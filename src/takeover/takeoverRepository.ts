import type { PoolClient } from "pg";
import { pool, qualified } from "../db/pool.js";
import type { TakeoverResult } from "./takeoverTally.js";

export type Db = Pick<PoolClient, "query">;
export type TakeoverStatus = "prepared" | "vote_open" | "closed" | "cancelled";

export interface TakeoverCase {
  id: string;
  chainId: number;
  projectId: string;
  candidateWallet: string;
  candidateUserId: string;
  reason: string;
  evidenceLinks: string[];
  status: TakeoverStatus;
  createdBy: string;
  openedBy: string | null;
  createdAt: Date;
  openedAt: Date | null;
  cancelledAt: Date | null;
  snapshotBlock: string | null;
  snapshotBlockTimestamp: Date | null;
  snapshotTakenAt: Date | null;
  snapshotLagSeconds: number | null;
  snapshotTotalStaked: string | null;
  snapshotHolderCount: number | null;
  /** Acceptance signature and message are never selected into this model. */
  candidateAcceptedAt: Date | null;
  developerAtOpen: string | null;
  endsAt: Date | null;
  closedAt: Date | null;
  result: TakeoverResult | null;
  yesWeight: string | null;
  noWeight: string | null;
  votedWeight: string | null;
  voterCount: number | null;
  quorumPercent: number | null;
  /** DB clock at read time: the voting window has elapsed (false for legacy cases without ends_at). */
  votingEnded: boolean;
}

export interface SnapshotHolder {
  investorAddress: string;
  stakedBalance: string;
  unstakedBalance: string | null;
}

export interface IndexedProject {
  id: string;
  chainId: number;
  escrowAddress: string;
  developer: string;
  state: string;
  isInvalidated: boolean;
}

export interface HolderPosition {
  investor: string;
  staked: bigint;
  /** Approximate (position.tokensHeld); null when the indexer has no value. */
  unstaked: bigint | null;
}

/** Live read of positions plus the project row, from ONE statement (consistent read). */
export interface PositionRead {
  project: IndexedProject & { totalStaked: bigint };
  holders: HolderPosition[];
}

interface CaseRow {
  id: string;
  chain_id: number;
  project_id: string;
  candidate_wallet: string;
  candidate_user_id: string;
  reason: string;
  evidence_links: string[];
  status: TakeoverStatus;
  created_by: string;
  opened_by: string | null;
  created_at: Date;
  opened_at: Date | null;
  cancelled_at: Date | null;
  snapshot_block: string | null;
  snapshot_block_timestamp: Date | null;
  snapshot_taken_at: Date | null;
  snapshot_lag_seconds: number | null;
  snapshot_total_staked: string | null;
  snapshot_holder_count: number | null;
  candidate_accepted_at: Date | null;
  developer_at_open: string | null;
  ends_at: Date | null;
  closed_at: Date | null;
  result: TakeoverResult | null;
  yes_weight: string | null;
  no_weight: string | null;
  voted_weight: string | null;
  voter_count: number | null;
  quorum_percent: number | null;
  voting_ended: boolean;
}

const CASE_COLUMNS = `id, chain_id, project_id, candidate_wallet, candidate_user_id, reason, evidence_links, status,
  created_by, opened_by, created_at, opened_at, cancelled_at, snapshot_block::text AS snapshot_block,
  snapshot_block_timestamp, snapshot_taken_at, snapshot_lag_seconds, snapshot_total_staked::text AS snapshot_total_staked,
  snapshot_holder_count, candidate_accepted_at, developer_at_open, ends_at, closed_at, result,
  yes_weight::text AS yes_weight, no_weight::text AS no_weight, voted_weight::text AS voted_weight, voter_count,
  quorum_percent, (ends_at IS NOT NULL AND ends_at <= now()) AS voting_ended`;

function toCase(row: CaseRow): TakeoverCase {
  return {
    id: row.id,
    chainId: row.chain_id,
    projectId: row.project_id,
    candidateWallet: row.candidate_wallet,
    candidateUserId: row.candidate_user_id,
    reason: row.reason,
    evidenceLinks: row.evidence_links,
    status: row.status,
    createdBy: row.created_by,
    openedBy: row.opened_by,
    createdAt: row.created_at,
    openedAt: row.opened_at,
    cancelledAt: row.cancelled_at,
    snapshotBlock: row.snapshot_block,
    snapshotBlockTimestamp: row.snapshot_block_timestamp,
    snapshotTakenAt: row.snapshot_taken_at,
    snapshotLagSeconds: row.snapshot_lag_seconds,
    snapshotTotalStaked: row.snapshot_total_staked,
    snapshotHolderCount: row.snapshot_holder_count,
    candidateAcceptedAt: row.candidate_accepted_at,
    developerAtOpen: row.developer_at_open,
    endsAt: row.ends_at,
    closedAt: row.closed_at,
    result: row.result,
    yesWeight: row.yes_weight,
    noWeight: row.no_weight,
    votedWeight: row.voted_weight,
    voterCount: row.voter_count,
    quorumPercent: row.quorum_percent,
    votingEnded: row.voting_ended,
  };
}

export async function findIndexedProject(db: Db, projectId: string): Promise<IndexedProject | null> {
  const result = await db.query<{
    id: string;
    chain_id: number;
    escrow_address: string;
    developer: string;
    state: string;
    is_invalidated: boolean;
  }>(
    `SELECT id, chain_id, escrow_address, developer, state, is_invalidated FROM ${qualified("project")} WHERE id = $1`,
    [projectId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    chainId: row.chain_id,
    escrowAddress: row.escrow_address.toLowerCase(),
    developer: row.developer.toLowerCase(),
    state: row.state,
    isInvalidated: row.is_invalidated,
  };
}

export async function findUserIdByWallet(db: Db, wallet: string): Promise<string | null> {
  const result = await db.query<{ id: string }>("SELECT id FROM app.users WHERE wallet_address = $1", [wallet]);
  return result.rows[0]?.id ?? null;
}

export async function hasActiveCase(db: Db, projectId: string): Promise<boolean> {
  const result = await db.query(
    "SELECT 1 FROM app.takeover_cases WHERE project_id = $1 AND status IN ('prepared', 'vote_open')",
    [projectId]
  );
  return (result.rowCount ?? 0) > 0;
}

export interface NewCase {
  chainId: number;
  projectId: string;
  candidateWallet: string;
  candidateUserId: string;
  reason: string;
  evidenceLinks: string[];
  createdBy: string;
}

export async function insertCase(db: Db, input: NewCase): Promise<TakeoverCase> {
  const result = await db.query<CaseRow>(
    `INSERT INTO app.takeover_cases
       (chain_id, project_id, candidate_wallet, candidate_user_id, reason, evidence_links, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7)
     RETURNING ${CASE_COLUMNS}`,
    [input.chainId, input.projectId, input.candidateWallet, input.candidateUserId, input.reason, input.evidenceLinks, input.createdBy]
  );
  const row = result.rows[0];
  if (!row) throw new Error("takeover case insert returned no row");
  return toCase(row);
}

export async function findCaseForUpdate(db: Db, id: string): Promise<TakeoverCase | null> {
  const result = await db.query<CaseRow>(`SELECT ${CASE_COLUMNS} FROM app.takeover_cases WHERE id = $1 FOR UPDATE`, [id]);
  const row = result.rows[0];
  return row ? toCase(row) : null;
}

export async function findCase(id: string): Promise<TakeoverCase | null> {
  const result = await pool.query<CaseRow>(`SELECT ${CASE_COLUMNS} FROM app.takeover_cases WHERE id = $1`, [id]);
  const row = result.rows[0];
  return row ? toCase(row) : null;
}

/**
 * One statement reads the project row and its positions with staked balance above zero, so the
 * per-holder rows and project.total_staked come from the same snapshot of the indexed tables.
 * Returns null when the project does not exist. Bigint columns are numeric: read as text.
 */
export async function readPositions(db: Db, projectId: string): Promise<PositionRead | null> {
  const result = await db.query<{
    id: string;
    chain_id: number;
    escrow_address: string;
    developer: string;
    state: string;
    is_invalidated: boolean;
    total_staked: string;
    investor: string | null;
    staked_balance: string | null;
    tokens_held: string | null;
  }>(
    `WITH p AS (
       SELECT id, chain_id, escrow_address, developer, state, is_invalidated, total_staked::text AS total_staked
       FROM ${qualified("project")} WHERE id = $1
     ),
     h AS (
       SELECT investor, staked_balance::text AS staked_balance, tokens_held::text AS tokens_held
       FROM ${qualified("position")} WHERE project = $1 AND staked_balance > 0
     )
     SELECT p.*, h.investor, h.staked_balance, h.tokens_held FROM p LEFT JOIN h ON true`,
    [projectId]
  );
  const first = result.rows[0];
  if (!first) return null;
  const holders = result.rows.flatMap((row): HolderPosition[] =>
    row.investor === null || row.staked_balance === null
      ? []
      : [
          {
            investor: row.investor.toLowerCase(),
            staked: BigInt(row.staked_balance),
            unstaked: row.tokens_held === null ? null : BigInt(row.tokens_held),
          },
        ]
  );
  return {
    project: {
      id: first.id,
      chainId: first.chain_id,
      escrowAddress: first.escrow_address.toLowerCase(),
      developer: first.developer.toLowerCase(),
      state: first.state,
      isInvalidated: first.is_invalidated,
      totalStaked: BigInt(first.total_staked),
    },
    holders,
  };
}

/** Bulk insert through array parameters (one statement and a fixed parameter count for any holder count). */
export async function insertHolders(db: Db, caseId: string, holders: HolderPosition[]): Promise<void> {
  if (holders.length === 0) return;
  await db.query(
    `INSERT INTO app.takeover_snapshot_holders (case_id, investor_address, staked_balance, unstaked_balance)
     SELECT $1::uuid, t.investor, t.staked::numeric, t.unstaked::numeric
     FROM unnest($2::text[], $3::text[], $4::text[]) AS t(investor, staked, unstaked)`,
    [
      caseId,
      holders.map((h) => h.investor),
      holders.map((h) => h.staked.toString()),
      holders.map((h) => (h.unstaked === null ? null : h.unstaked.toString())),
    ]
  );
}

export interface SnapshotValues {
  block: bigint;
  blockTimestamp: Date;
  lagSeconds: number;
  totalStaked: bigint;
  holderCount: number;
  /** Indexed developer at open time (excluded from voting). */
  developer: string;
  voteDays: number;
  quorumPercent: number;
}

export async function markOpen(db: Db, id: string, actorUserId: string, snap: SnapshotValues): Promise<TakeoverCase> {
  const result = await db.query<CaseRow>(
    `UPDATE app.takeover_cases SET status = 'vote_open', opened_by = $2, opened_at = now(),
       snapshot_block = $3::numeric, snapshot_block_timestamp = $4, snapshot_taken_at = now(),
       snapshot_lag_seconds = $5, snapshot_total_staked = $6::numeric, snapshot_holder_count = $7,
       developer_at_open = $8, ends_at = now() + make_interval(days => $9::int), quorum_percent = $10
     WHERE id = $1 RETURNING ${CASE_COLUMNS}`,
    [
      id,
      actorUserId,
      snap.block.toString(),
      snap.blockTimestamp,
      snap.lagSeconds,
      snap.totalStaked.toString(),
      snap.holderCount,
      snap.developer,
      snap.voteDays,
      snap.quorumPercent,
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error("takeover case update returned no row");
  return toCase(row);
}

export async function markCancelled(db: Db, id: string): Promise<TakeoverCase> {
  const result = await db.query<CaseRow>(
    `UPDATE app.takeover_cases SET status = 'cancelled', cancelled_at = now() WHERE id = $1 RETURNING ${CASE_COLUMNS}`,
    [id]
  );
  const row = result.rows[0];
  if (!row) throw new Error("takeover case update returned no row");
  return toCase(row);
}

/** Audit rows carry only short tokens: never the reason or evidence text. */
export async function insertTakeoverAudit(
  db: Db,
  actorUserId: string | null,
  action: string,
  target: string,
  before: string | null,
  after: string,
  ip: string | null
): Promise<void> {
  await db.query(
    `INSERT INTO app.audit_log (actor_user_id, action, target, before_value, after_value, ip)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [actorUserId, action, target, before, after, ip]
  );
}

export async function listCases(
  status: TakeoverStatus | undefined,
  chainId: number | undefined,
  limit: number,
  offset: number
): Promise<{ items: TakeoverCase[]; total: number }> {
  const filter = "WHERE ($1::text IS NULL OR status = $1::text) AND ($2::int IS NULL OR chain_id = $2::int)";
  const params = [status ?? null, chainId ?? null];
  const [page, count] = await Promise.all([
    pool.query<CaseRow>(
      `SELECT ${CASE_COLUMNS} FROM app.takeover_cases ${filter} ORDER BY created_at DESC, id LIMIT $3 OFFSET $4`,
      [...params, limit, offset]
    ),
    pool.query<{ total: string }>(`SELECT count(*) AS total FROM app.takeover_cases ${filter}`, params),
  ]);
  return { items: page.rows.map(toCase), total: Number(count.rows[0]?.total ?? 0) };
}

export async function listHolders(caseId: string, limit: number, offset: number): Promise<SnapshotHolder[]> {
  const result = await pool.query<{ investor_address: string; staked_balance: string; unstaked_balance: string | null }>(
    `SELECT investor_address, staked_balance::text AS staked_balance, unstaked_balance::text AS unstaked_balance
     FROM app.takeover_snapshot_holders WHERE case_id = $1
     ORDER BY staked_balance DESC, investor_address LIMIT $2 OFFSET $3`,
    [caseId, limit, offset]
  );
  return result.rows.map((row) => ({
    investorAddress: row.investor_address,
    stakedBalance: row.staked_balance,
    unstakedBalance: row.unstaked_balance,
  }));
}

export type VoteChoiceValue = "YES" | "NO";

export interface VoteSums {
  yes: bigint;
  no: bigint;
  voted: bigint;
  count: number;
}

export interface VoteRecord {
  voter: string;
  choice: VoteChoiceValue;
  weight: string;
  issuedAt: Date;
  updatedAt: Date;
}

export interface NewVote {
  caseId: string;
  voter: string;
  choice: VoteChoiceValue;
  weight: bigint;
  message: string;
  signature: string;
  issuedAt: Date;
}

interface VoteRow {
  voter_address: string;
  choice: VoteChoiceValue;
  weight: string;
  issued_at: Date;
  updated_at: Date;
}

const VOTE_COLUMNS = "voter_address, choice, weight::text AS weight, issued_at, updated_at";

function toVote(row: VoteRow): VoteRecord {
  return { voter: row.voter_address, choice: row.choice, weight: row.weight, issuedAt: row.issued_at, updatedAt: row.updated_at };
}

/** Candidate acceptance: stores the signed text. Never selected back (see TakeoverCase). */
export async function markAccepted(
  db: Db,
  id: string,
  message: string,
  signature: string,
  issuedAt: Date
): Promise<void> {
  await db.query(
    `UPDATE app.takeover_cases SET candidate_accepted_at = now(), candidate_acceptance_message = $2,
       candidate_acceptance_signature = $3, candidate_acceptance_issued_at = $4
     WHERE id = $1`,
    [id, message, signature, issuedAt]
  );
}

/** Latest close time of a failed or no_quorum case of the project (passed and cancelled cases are ignored). */
export async function findLastFailedCloseAt(db: Db, projectId: string): Promise<Date | null> {
  const result = await db.query<{ closed_at: Date | null }>(
    `SELECT max(closed_at) AS closed_at FROM app.takeover_cases
     WHERE project_id = $1 AND status = 'closed' AND result IN ('failed', 'no_quorum')`,
    [projectId]
  );
  return result.rows[0]?.closed_at ?? null;
}

export async function listCasesForCandidate(userId: string): Promise<TakeoverCase[]> {
  const result = await pool.query<CaseRow>(
    `SELECT ${CASE_COLUMNS} FROM app.takeover_cases
     WHERE candidate_user_id = $1 AND status IN ('prepared', 'vote_open') ORDER BY created_at DESC LIMIT 50`,
    [userId]
  );
  return result.rows.map(toCase);
}

export async function findSnapshotWeight(db: Db, caseId: string, voter: string): Promise<bigint | null> {
  const result = await db.query<{ staked_balance: string }>(
    "SELECT staked_balance::text AS staked_balance FROM app.takeover_snapshot_holders WHERE case_id = $1 AND investor_address = $2",
    [caseId, voter]
  );
  const row = result.rows[0];
  return row ? BigInt(row.staked_balance) : null;
}

export async function findVote(db: Db, caseId: string, voter: string): Promise<VoteRecord | null> {
  const result = await db.query<VoteRow>(
    `SELECT ${VOTE_COLUMNS} FROM app.takeover_votes WHERE case_id = $1 AND voter_address = $2`,
    [caseId, voter]
  );
  const row = result.rows[0];
  return row ? toVote(row) : null;
}

/** One row per voter: a repeat updates choice and the signed proof only (weight stays as first copied). */
export async function upsertVote(db: Db, vote: NewVote): Promise<VoteRecord> {
  const result = await db.query<VoteRow>(
    `INSERT INTO app.takeover_votes (case_id, voter_address, choice, weight, message, signature, issued_at)
     VALUES ($1, $2, $3, $4::numeric, $5, $6, $7)
     ON CONFLICT (case_id, voter_address) DO UPDATE
       SET choice = EXCLUDED.choice, message = EXCLUDED.message, signature = EXCLUDED.signature,
           issued_at = EXCLUDED.issued_at, updated_at = now()
     RETURNING ${VOTE_COLUMNS}`,
    [vote.caseId, vote.voter, vote.choice, vote.weight.toString(), vote.message, vote.signature, vote.issuedAt]
  );
  const row = result.rows[0];
  if (!row) throw new Error("takeover vote upsert returned no row");
  return toVote(row);
}

export async function sumVotes(db: Db, caseId: string): Promise<VoteSums> {
  const result = await db.query<{ yes: string; no: string; count: string }>(
    `SELECT COALESCE(SUM(weight) FILTER (WHERE choice = 'YES'), 0)::text AS yes,
            COALESCE(SUM(weight) FILTER (WHERE choice = 'NO'), 0)::text AS no,
            count(*)::text AS count
     FROM app.takeover_votes WHERE case_id = $1`,
    [caseId]
  );
  const row = result.rows[0];
  const yes = BigInt(row?.yes ?? "0");
  const no = BigInt(row?.no ?? "0");
  return { yes, no, voted: yes + no, count: Number(row?.count ?? 0) };
}

export async function markClosed(db: Db, id: string, result: TakeoverResult, sums: VoteSums): Promise<TakeoverCase> {
  const updated = await db.query<CaseRow>(
    `UPDATE app.takeover_cases SET status = 'closed', closed_at = now(), result = $2,
       yes_weight = $3::numeric, no_weight = $4::numeric, voted_weight = $5::numeric, voter_count = $6
     WHERE id = $1 RETURNING ${CASE_COLUMNS}`,
    [id, result, sums.yes.toString(), sums.no.toString(), sums.voted.toString(), sums.count]
  );
  const row = updated.rows[0];
  if (!row) throw new Error("takeover case update returned no row");
  return toCase(row);
}

export async function listVotes(caseId: string, limit: number, offset: number): Promise<{ items: VoteRecord[]; total: number }> {
  const [page, count] = await Promise.all([
    pool.query<VoteRow>(
      `SELECT ${VOTE_COLUMNS} FROM app.takeover_votes WHERE case_id = $1
       ORDER BY weight DESC, voter_address LIMIT $2 OFFSET $3`,
      [caseId, limit, offset]
    ),
    pool.query<{ total: string }>("SELECT count(*) AS total FROM app.takeover_votes WHERE case_id = $1", [caseId]),
  ]);
  return { items: page.rows.map(toVote), total: Number(count.rows[0]?.total ?? 0) };
}

/** Latest case of a project whose vote has been opened (prepared and cancelled cases are not public). */
export async function findPublicCase(projectId: string): Promise<TakeoverCase | null> {
  const result = await pool.query<CaseRow>(
    `SELECT ${CASE_COLUMNS} FROM app.takeover_cases
     WHERE project_id = $1 AND status IN ('vote_open', 'closed') ORDER BY opened_at DESC LIMIT 1`,
    [projectId]
  );
  const row = result.rows[0];
  return row ? toCase(row) : null;
}
