import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";
import { AppError } from "../errors.js";
import type { RepoProvider } from "../repos/repoProvider.js";
import { getRepoProvider } from "../repos/repoProviderRegistry.js";
import { findProjectRepoForUpdate, type RepoRecord } from "../repos/repoRepository.js";
import { loadExecution } from "./takeoverExecution.js";
import {
  findCaseForUpdate,
  insertTakeoverAudit,
  markHandedOver,
  updateHandoverStatus,
  type HandoverStatus,
  type TakeoverCase,
} from "./takeoverRepository.js";

const WALLET = /^0x[0-9a-f]{40}$/;

export interface HandoverResult {
  githubLogin: string;
  status: HandoverStatus;
  handedOverAt: Date;
  repo: RepoRecord;
  /** True when the handover was already complete and nothing was done by this call. */
  alreadyHandedOver: boolean;
}

function unconfigured(): AppError {
  return new AppError(503, "Repository provisioning is not configured", true);
}

async function assertAccepted(current: TakeoverCase, db: PoolClient): Promise<void> {
  const execution = await loadExecution(current, db);
  if (execution.state === "unknown") throw new AppError(503, "The indexer could not be read; try again shortly", true);
  if (execution.state !== "accepted") throw new AppError(409, "The new developer has not accepted on chain yet");
}

function auditTarget(current: TakeoverCase): string {
  const wallet = current.candidateWallet.toLowerCase();
  if (!WALLET.test(wallet)) throw new Error("takeover candidate wallet is not a lowercase address");
  return wallet;
}

/** Retry of an invited handover: re-sends the invitation and refreshes the stored status. */
async function refreshInvited(
  db: PoolClient,
  current: TakeoverCase,
  repo: RepoRecord,
  login: string,
  actorUserId: string,
  ip: string | null,
  provider: RepoProvider | null
): Promise<HandoverResult> {
  const handedOverAt = current.handedOverAt;
  if (!provider) throw unconfigured();
  if (handedOverAt === null) throw new Error("handed over case has no handover time");
  const result = await provider.addCollaborator(repo.repoName, login);
  await updateHandoverStatus(db, current.id, result.status, result.collaboratorId);
  if (result.status !== "invited") {
    await insertTakeoverAudit(db, actorUserId, "takeover.handover", auditTarget(current), "handover invited", "handover active", ip);
  }
  return { githubLogin: login, status: result.status, handedOverAt, repo, alreadyHandedOver: false };
}

async function handoverLocked(
  db: PoolClient,
  caseId: string,
  login: string,
  actorUserId: string,
  ip: string | null,
  provider: RepoProvider | null
): Promise<HandoverResult> {
  const current = await findCaseForUpdate(db, caseId);
  if (!current) throw new AppError(404, "Not found");
  await assertAccepted(current, db);

  const repo = await findProjectRepoForUpdate(db, current.projectId);
  if (!repo) throw new AppError(409, "No repository is linked to this project");
  if (login.toLowerCase() === repo.founderLogin.toLowerCase()) {
    throw new AppError(422, "That GitHub user is the previous developer");
  }

  const existingLogin = current.newDeveloperGithubLogin;
  if (current.handoverStatus !== null && existingLogin !== null && current.handedOverAt !== null) {
    if (existingLogin.toLowerCase() !== login.toLowerCase()) {
      throw new AppError(409, "Repository was already handed over to another GitHub user");
    }
    if (current.handoverStatus === "active") {
      return { githubLogin: existingLogin, status: "active", handedOverAt: current.handedOverAt, repo, alreadyHandedOver: true };
    }
    return refreshInvited(db, current, repo, existingLogin, actorUserId, ip, provider);
  }

  if (!provider) throw unconfigured();
  if (!(await provider.userExists(login))) throw new AppError(422, "GitHub user not found");
  const result = await provider.addCollaborator(repo.repoName, login);
  const handedOverAt = await markHandedOver(db, current.id, login, result.status, result.collaboratorId, repo.id, actorUserId);
  await insertTakeoverAudit(db, actorUserId, "takeover.handover", auditTarget(current), null, `handover ${result.status}`, ip);
  return { githubLogin: login, status: result.status, handedOverAt, repo, alreadyHandedOver: false };
}

/**
 * Admin hands the project repository to the new developer after the on-chain acceptance: ONE
 * transaction holding the case and repo row locks. The new developer gets WRITE (push) access; the
 * previous developer's access is removed separately by the repo lock-out. A provider failure rolls
 * everything back, so nothing is recorded. An active handover is returned as is (no provider call).
 */
export async function handoverRepository(
  caseId: string,
  githubLogin: string,
  actorUserId: string,
  ip: string | null,
  provider: RepoProvider | null = getRepoProvider()
): Promise<HandoverResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const result = await handoverLocked(client, caseId, githubLogin, actorUserId, ip, provider);
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
