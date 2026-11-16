import type { PoolClient } from "pg";
import { config } from "../config/env.js";
import { pool } from "../db/pool.js";
import { AppError } from "../errors.js";
import { signatureMatches } from "../auth/siwe.js";
import { AGREEMENT_VERSION } from "../founders/agreement.js";
import { readLaunchChecks } from "../founders/founderRepository.js";
import type { AuthUser } from "../types/index.js";
import { fetchIndexedHead, lagSeconds, type IndexedHead } from "./indexerStatus.js";
import {
  findCase,
  findCaseForUpdate,
  findIndexedProject,
  findLastFailedCloseAt,
  findSnapshotWeight,
  findUserIdByWallet,
  findVote,
  hasActiveCase,
  insertCase,
  insertHolders,
  insertTakeoverAudit,
  markAccepted,
  markCancelled,
  markClosed,
  markOpen,
  readPositions,
  sumVotes,
  upsertVote,
  type Db,
  type HolderPosition,
  type IndexedProject,
  type TakeoverCase,
  type VoteRecord,
  type VoteSums,
} from "./takeoverRepository.js";
import {
  buildAcceptanceMessage,
  buildVoteMessage,
  isNewerVote,
  parseIssuedAt,
  type VoteChoice,
} from "./takeoverMessages.js";
import { decideResult, isInCooldown, isQuorumReached, quorumWeightRequired } from "./takeoverTally.js";

/*
 * Precision trade-off (read before relying on a snapshot): the snapshot is INDEXED state taken from
 * the Ponder position table at the moment an admin opens the vote. The position read is live, so the
 * head block reported by the indexer's /status is only a LOWER BOUND ("indexed at or after block N"),
 * and the recorded lag says how far behind the chain the indexer was. Opening is refused when the lag
 * exceeds TAKEOVER_MAX_LAG_SECONDS. The vote built on this snapshot is advisory and off-chain.
 */

const PG_UNIQUE_VIOLATION = "23505";

/**
 * Projects eligible for a takeover vote: state ACTIVE (funded and running milestones) and not
 * invalidated. FUNDING has no developer to replace yet; COMPLETED, FAILED, CANCELLED and SHUTDOWN
 * are terminal.
 */
export const ELIGIBLE_PROJECT_STATE = "ACTIVE";

export interface PrepareInput {
  chainId: number;
  projectAddress: string;
  candidateWallet: string;
  reason: string;
  evidenceLinks: string[];
}

export interface OpenResult {
  takeoverCase: TakeoverCase;
  /** True when the case was already open and nothing was snapshotted by this call. */
  alreadyOpen: boolean;
}

export interface OpenDeps {
  fetchHead: (chainId: number) => Promise<IndexedHead>;
  maxLagSeconds: number;
  now: () => number;
  voteDays: number;
  quorumPercent: number;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === PG_UNIQUE_VIOLATION;
}

/** The indexer must be recent enough for the snapshot to mean something; fails closed otherwise. */
export function assertFreshHead(head: IndexedHead, nowMs: number, maxLagSeconds: number): number {
  const lag = lagSeconds(head, nowMs);
  if (lag > maxLagSeconds) throw new AppError(503, "Indexer is behind; try again when it has caught up", true);
  return lag;
}

export function assertProjectEligible(project: IndexedProject, candidateWallet: string): void {
  if (project.state !== ELIGIBLE_PROJECT_STATE || project.isInvalidated) {
    throw new AppError(409, "Project is not in a state that allows a takeover vote");
  }
  if (project.developer === candidateWallet) throw new AppError(422, "Candidate is already the project developer");
}

/** Sum of staked balances and the audit warning token when it differs from the indexed project total. */
export function summariseSnapshot(
  holders: HolderPosition[],
  projectTotalStaked: bigint
): { total: bigint; mismatch: boolean } {
  const total = holders.reduce((sum, holder) => sum + holder.staked, 0n);
  return { total, mismatch: total !== projectTotalStaked };
}

async function assertCandidateEligible(userId: string): Promise<void> {
  const checks = await readLaunchChecks(userId, AGREEMENT_VERSION);
  if (!checks.applicationApproved) throw new AppError(422, "Candidate has no approved founder application");
  if (!checks.agreementAccepted) throw new AppError(422, "Candidate has not accepted the current agreement");
}

/** Staff or admin prepares a case. Nothing is snapshotted and nothing is public until an admin opens it. */
export async function prepareCase(actorUserId: string, input: PrepareInput, ip: string | null): Promise<TakeoverCase> {
  const projectId = `${input.chainId}:${input.projectAddress}`;
  const project = await findIndexedProject(pool, projectId);
  if (!project) throw new AppError(404, "Project not found");
  if (project.developer === input.candidateWallet) throw new AppError(422, "Candidate is already the project developer");
  const candidateUserId = await findUserIdByWallet(pool, input.candidateWallet);
  if (candidateUserId === null) throw new AppError(422, "Candidate has no account");
  await assertCandidateEligible(candidateUserId);
  if (await hasActiveCase(pool, projectId)) throw new AppError(409, "This project already has an active takeover case");
  const lastFailed = await findLastFailedCloseAt(pool, projectId);
  if (isInCooldown(lastFailed, Date.now(), config.TAKEOVER_COOLDOWN_DAYS)) {
    throw new AppError(409, "A takeover case for this project failed recently; try again after the cooldown");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const created = await insertCase(client, {
        chainId: input.chainId,
        projectId,
        candidateWallet: input.candidateWallet,
        candidateUserId,
        reason: input.reason,
        evidenceLinks: input.evidenceLinks,
        createdBy: actorUserId,
      });
      await insertTakeoverAudit(client, actorUserId, "takeover.prepare", project.escrowAddress, null, "prepared", ip);
      await client.query("COMMIT");
      return created;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (isUniqueViolation(err)) throw new AppError(409, "This project already has an active takeover case");
      throw err;
    }
  } finally {
    client.release();
  }
}

function defaultOpenDeps(): OpenDeps {
  return {
    fetchHead: (chainId) => fetchIndexedHead(chainId),
    maxLagSeconds: config.TAKEOVER_MAX_LAG_SECONDS,
    now: Date.now,
    voteDays: config.TAKEOVER_VOTE_DAYS,
    quorumPercent: config.TAKEOVER_QUORUM_PERCENT,
  };
}

async function openLocked(
  db: Parameters<typeof findCaseForUpdate>[0],
  id: string,
  actorUserId: string,
  ip: string | null,
  deps: OpenDeps
): Promise<OpenResult> {
  const current = await findCaseForUpdate(db, id);
  if (!current) throw new AppError(404, "Not found");
  if (current.status === "vote_open") return { takeoverCase: current, alreadyOpen: true };
  if (current.status !== "prepared") throw new AppError(409, "Case cannot be opened in its current status");
  if (current.candidateAcceptedAt === null) throw new AppError(409, "Candidate has not accepted");

  const head = await deps.fetchHead(current.chainId);
  const lag = assertFreshHead(head, deps.now(), deps.maxLagSeconds);

  const read = await readPositions(db, current.projectId);
  if (!read) throw new AppError(404, "Project not found");
  assertProjectEligible(read.project, current.candidateWallet);

  const { total, mismatch } = summariseSnapshot(read.holders, read.project.totalStaked);
  await insertHolders(db, current.id, read.holders);
  const opened = await markOpen(db, current.id, actorUserId, {
    block: head.blockNumber,
    blockTimestamp: new Date(head.blockTimestamp * 1000),
    lagSeconds: lag,
    totalStaked: total,
    holderCount: read.holders.length,
    developer: read.project.developer,
    voteDays: deps.voteDays,
    quorumPercent: deps.quorumPercent,
  });
  // Short token only (audit after_value is capped at 32 chars): holder count and a total-mismatch flag.
  const token = `open h=${read.holders.length}${mismatch ? " total-diff" : ""}`;
  await insertTakeoverAudit(db, actorUserId, "takeover.open", read.project.escrowAddress, "prepared", token, ip);
  return { takeoverCase: opened, alreadyOpen: false };
}

/**
 * Admin opens the vote: ONE transaction holding the case row lock freezes the stake snapshot.
 * Already open returns as is (no second snapshot). Any failure rolls back, leaving the case prepared.
 */
export async function openCase(
  id: string,
  actorUserId: string,
  ip: string | null,
  deps: OpenDeps = defaultOpenDeps()
): Promise<OpenResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const result = await openLocked(client, id, actorUserId, ip, deps);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  } finally {
    client.release();
  }
}

/** Admin cancels a prepared or open case; an open case keeps its frozen snapshot rows. Already cancelled is a no-op. */
export async function cancelCase(id: string, actorUserId: string, ip: string | null): Promise<TakeoverCase> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const current = await findCaseForUpdate(client, id);
      if (!current) throw new AppError(404, "Not found");
      if (current.status === "cancelled") {
        await client.query("COMMIT");
        return current;
      }
      if (current.status !== "prepared" && current.status !== "vote_open") {
        throw new AppError(409, "Case cannot be cancelled in its current status");
      }
      const cancelled = await markCancelled(client, id);
      const escrow = current.projectId.slice(current.projectId.indexOf(":") + 1);
      await insertTakeoverAudit(client, actorUserId, "takeover.cancel", escrow, current.status, "cancelled", ip);
      await client.query("COMMIT");
      return cancelled;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  } finally {
    client.release();
  }
}

async function inTransaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  } finally {
    client.release();
  }
}

function escrowOf(projectId: string): string {
  return projectId.slice(projectId.indexOf(":") + 1);
}

/** Candidate signs the off-chain acceptance that must exist before an admin can open the vote. */
export async function acceptCandidate(
  user: AuthUser,
  caseId: string,
  fields: { issuedAt: string; signature: string },
  ip: string | null,
  now: Date = new Date()
): Promise<{ alreadyAccepted: boolean }> {
  return inTransaction(async (db) => {
    const current = await findCaseForUpdate(db, caseId);
    // Not the candidate of this case: indistinguishable from a missing case.
    if (!current || current.candidateUserId !== user.id) throw new AppError(404, "Not found");
    if (current.status !== "prepared") throw new AppError(409, "Case is not awaiting acceptance");
    if (current.candidateAcceptedAt !== null) return { alreadyAccepted: true };

    const issuedAt = parseIssuedAt(fields.issuedAt, now);
    const message = buildAcceptanceMessage({
      caseId: current.id,
      projectId: current.projectId,
      wallet: user.address,
      issuedAt: fields.issuedAt,
    });
    if (!signatureMatches(message, fields.signature, user.address)) throw new AppError(400, "Invalid signature");
    await markAccepted(db, current.id, message, fields.signature, issuedAt);
    await insertTakeoverAudit(db, user.id, "takeover.accept", escrowOf(current.projectId), "prepared", "accepted", ip);
    return { alreadyAccepted: false };
  });
}

/** Voter must be a snapshot staker other than the developer under takeover and the candidate; returns the weight. */
export function assertVoterEligible(input: {
  voter: string;
  developerAtOpen: string | null;
  candidateWallet: string;
  weight: bigint | null;
}): bigint {
  if (input.voter === input.developerAtOpen || input.voter === input.candidateWallet) {
    throw new AppError(403, "Not eligible");
  }
  if (input.weight === null || input.weight <= 0n) throw new AppError(403, "Not eligible");
  return input.weight;
}

async function closeLocked(db: Db, current: TakeoverCase, actorUserId: string | null, ip: string | null): Promise<TakeoverCase> {
  if (current.snapshotTotalStaked === null || current.quorumPercent === null) {
    throw new Error("vote_open case without snapshot total or quorum cannot be closed");
  }
  const sums = await sumVotes(db, current.id);
  const result = decideResult({
    yes: sums.yes,
    no: sums.no,
    total: BigInt(current.snapshotTotalStaked),
    quorumPercent: current.quorumPercent,
  });
  const closed = await markClosed(db, current.id, result, sums);
  await insertTakeoverAudit(db, actorUserId, "takeover.close", escrowOf(current.projectId), "vote_open", result, ip);
  return closed;
}

/**
 * Lazy close: under the case row lock, a vote_open case whose window has elapsed gets its tallies and
 * result persisted exactly once. Idempotent; a closed case is returned unchanged. Null when missing.
 */
export async function closeIfDue(caseId: string): Promise<TakeoverCase | null> {
  return inTransaction(async (db) => {
    const current = await findCaseForUpdate(db, caseId);
    if (!current) return null;
    if (current.status === "vote_open" && current.votingEnded) return closeLocked(db, current, null, null);
    return current;
  });
}

/** Cheap pre-check on an unlocked read, so only overdue cases take the row lock. */
export async function refreshIfDue(current: TakeoverCase): Promise<TakeoverCase> {
  if (current.status !== "vote_open" || !current.votingEnded) return current;
  return (await closeIfDue(current.id)) ?? current;
}

/** Admin closes a case whose window has elapsed (early termination is cancel). Already closed is a no-op. */
export async function closeCase(id: string, actorUserId: string, ip: string | null): Promise<TakeoverCase> {
  return inTransaction(async (db) => {
    const current = await findCaseForUpdate(db, id);
    if (!current) throw new AppError(404, "Not found");
    if (current.status === "closed") return current;
    if (current.status !== "vote_open") throw new AppError(409, "Case cannot be closed in its current status");
    if (!current.votingEnded) throw new AppError(409, "Voting window has not ended");
    return closeLocked(db, current, actorUserId, ip);
  });
}

export interface TallyView {
  status: TakeoverCase["status"];
  result: TakeoverCase["result"];
  candidateWallet: string;
  endsAt: string | null;
  quorumPercent: number | null;
  quorumWeightRequired: string | null;
  snapshotTotalStaked: string | null;
  yesWeight: string;
  noWeight: string;
  votedWeight: string;
  voterCount: number;
  quorumReached: boolean | null;
  closedAt: string | null;
  advisory: true;
}

function persistedSums(current: TakeoverCase): VoteSums {
  const yes = BigInt(current.yesWeight ?? "0");
  const no = BigInt(current.noWeight ?? "0");
  return { yes, no, voted: yes + no, count: current.voterCount ?? 0 };
}

/** Aggregate public tally. Closed cases use the persisted result; open cases sum the live votes. Never per-address data. */
export async function loadTally(current: TakeoverCase, db: Db = pool): Promise<TallyView> {
  const sums = current.status === "closed" ? persistedSums(current) : await sumVotes(db, current.id);
  const total = current.snapshotTotalStaked === null ? null : BigInt(current.snapshotTotalStaked);
  const percent = current.quorumPercent;
  const known = total !== null && percent !== null;
  return {
    status: current.status,
    result: current.result,
    candidateWallet: current.candidateWallet,
    endsAt: current.endsAt === null ? null : current.endsAt.toISOString(),
    quorumPercent: percent,
    quorumWeightRequired: known ? quorumWeightRequired(total, percent).toString() : null,
    snapshotTotalStaked: current.snapshotTotalStaked,
    yesWeight: sums.yes.toString(),
    noWeight: sums.no.toString(),
    votedWeight: sums.voted.toString(),
    voterCount: sums.count,
    quorumReached: known ? isQuorumReached(sums.voted, total, percent) : null,
    closedAt: current.closedAt === null ? null : current.closedAt.toISOString(),
    advisory: true,
  };
}

/** Public tally read: only opened cases exist publicly; an overdue case is closed lazily first. */
export async function readPublicTally(caseId: string): Promise<TallyView> {
  const found = await findCase(caseId);
  if (!found || (found.status !== "vote_open" && found.status !== "closed")) throw new AppError(404, "Not found");
  return loadTally(await refreshIfDue(found));
}

export interface CastVoteResult {
  vote: VoteRecord;
  tally: TallyView;
}

/** A snapshot staker casts or changes an advisory vote with a wallet signature over the server-built message. */
export async function castVote(
  user: AuthUser,
  caseId: string,
  fields: { choice: VoteChoice; issuedAt: string; signature: string },
  ip: string | null,
  now: Date = new Date()
): Promise<CastVoteResult> {
  await closeIfDue(caseId);
  return inTransaction(async (db) => {
    const current = await findCaseForUpdate(db, caseId);
    if (!current || current.status === "prepared" || current.status === "cancelled") throw new AppError(404, "Not found");
    if (current.status !== "vote_open" || current.endsAt === null || current.votingEnded) {
      throw new AppError(409, "Voting is not open");
    }
    const voter = user.address.toLowerCase();
    const weight = assertVoterEligible({
      voter,
      developerAtOpen: current.developerAtOpen,
      candidateWallet: current.candidateWallet,
      weight: await findSnapshotWeight(db, current.id, voter),
    });
    const issuedAt = parseIssuedAt(fields.issuedAt, now);
    const message = buildVoteMessage({
      caseId: current.id,
      projectId: current.projectId,
      choice: fields.choice,
      wallet: user.address,
      issuedAt: fields.issuedAt,
    });
    if (!signatureMatches(message, fields.signature, user.address)) throw new AppError(400, "Invalid signature");
    const existing = await findVote(db, current.id, voter);
    if (!isNewerVote(existing === null ? null : existing.issuedAt, issuedAt)) throw new AppError(409, "Stale vote");

    const vote = await upsertVote(db, {
      caseId: current.id,
      voter,
      choice: fields.choice,
      weight,
      message,
      signature: fields.signature,
      issuedAt,
    });
    await insertTakeoverAudit(db, user.id, "takeover.vote", escrowOf(current.projectId), null, fields.choice, ip);
    return { vote, tally: await loadTally(current, db) };
  });
}
