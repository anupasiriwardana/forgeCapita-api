import { config } from "../config/env.js";
import { pool } from "../db/pool.js";
import { AppError } from "../errors.js";
import { logger } from "../logger.js";
import type { AuthUser } from "../types/index.js";
import { buildRepoName } from "./repoNaming.js";
import type { CollaboratorResult, CreatedRepo, RepoProvider } from "./repoProvider.js";
import { getRepoProvider } from "./repoProviderRegistry.js";
import {
  findUnlinkedRepo,
  insertProvisionAudit,
  insertRepo,
  lockUser,
  updateCollaborator,
  type Db,
  type RepoRecord,
  type RepoStatus,
} from "./repoRepository.js";

const PG_UNIQUE_VIOLATION = "23505";

export interface ProvisionDeps {
  provider: RepoProvider | null;
  branchProtection: boolean;
}

export interface ProvisionResult {
  repo: RepoRecord;
  /** True when a new repository was created by this call. */
  created: boolean;
}

/** Internal outcome: a failure is thrown only after the failed state has been committed. */
interface LockedOutcome extends ProvisionResult {
  failure: unknown;
}

function defaultDeps(): ProvisionDeps {
  return { provider: getRepoProvider(), branchProtection: config.REPO_BRANCH_PROTECTION };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === PG_UNIQUE_VIOLATION;
}

type InviteOutcome = { ok: true; result: CollaboratorResult } | { ok: false; error: unknown };

async function invite(provider: RepoProvider, repoName: string, login: string): Promise<InviteOutcome> {
  try {
    return { ok: true, result: await provider.addCollaborator(repoName, login) };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Branch protection is best effort (it can need a paid GitHub plan); the repo stays usable without it. */
async function protectBranch(provider: RepoProvider, repo: CreatedRepo): Promise<void> {
  if (!provider.protectDefaultBranch) return;
  try {
    await provider.protectDefaultBranch(repo.name, repo.defaultBranch);
  } catch {
    logger.warn({ repo: repo.fullName }, "branch protection could not be applied");
  }
}

async function runLocked(
  db: Db,
  user: AuthUser,
  input: { githubUsername: string; projectName: string },
  ip: string | null,
  deps: ProvisionDeps,
  provider: RepoProvider
): Promise<LockedOutcome> {
  const wallet = user.address.toLowerCase();
  await lockUser(db, user.id);
  const existing = await findUnlinkedRepo(db, user.id);

  if (existing) {
    if (existing.founderLogin.toLowerCase() !== input.githubUsername.toLowerCase()) {
      throw new AppError(409, "A repository request already exists for a different GitHub user");
    }
    if (existing.status !== "failed") return { repo: existing, created: false, failure: null };
    const outcome = await invite(provider, existing.repoName, existing.founderLogin);
    if (!outcome.ok) return { repo: existing, created: false, failure: outcome.error };
    await updateCollaborator(db, existing.id, outcome.result.status, outcome.result.collaboratorId);
    await insertProvisionAudit(db, user.id, wallet, "failed", outcome.result.status, ip);
    return {
      repo: { ...existing, status: outcome.result.status, collaboratorId: toIdText(outcome.result) },
      created: false,
      failure: null,
    };
  }

  if (!(await provider.userExists(input.githubUsername))) throw new AppError(422, "GitHub user not found");

  const created = await provider.createRepo(buildRepoName(input.projectName));
  let id: string;
  try {
    id = await insertRepo(db, {
      userId: user.id,
      repoId: created.id,
      repoName: created.name,
      fullName: created.fullName,
      htmlUrl: created.htmlUrl,
      founderLogin: input.githubUsername,
    });
  } catch (err) {
    logger.error({ repo: created.fullName }, "repository created but its row could not be stored");
    if (isUniqueViolation(err)) throw new AppError(409, "A repository request already exists");
    throw err;
  }

  const outcome = await invite(provider, created.name, input.githubUsername);
  const status: RepoStatus = outcome.ok ? outcome.result.status : "failed";
  const collaboratorId = outcome.ok ? outcome.result.collaboratorId : null;
  if (outcome.ok) await updateCollaborator(db, id, status, collaboratorId);
  await insertProvisionAudit(db, user.id, wallet, null, status, ip);
  const failure = outcome.ok ? null : outcome.error;
  if (outcome.ok && deps.branchProtection) await protectBranch(provider, created);

  return {
    repo: {
      id,
      userId: user.id,
      founderWallet: wallet,
      provider: "github",
      repoId: String(created.id),
      repoName: created.name,
      fullName: created.fullName,
      htmlUrl: created.htmlUrl,
      founderLogin: input.githubUsername,
      collaboratorId: collaboratorId === null ? null : String(collaboratorId),
      status,
      projectId: null,
      createdAt: new Date(),
    },
    created: true,
    failure,
  };
}

function toIdText(result: CollaboratorResult): string | null {
  return result.collaboratorId === null ? null : String(result.collaboratorId);
}

/**
 * Provisions the founder's private repository and invites them with push access. One transaction
 * per founder (advisory lock + unique index), so concurrent calls cannot create two repos. A repo
 * whose invite failed is kept with status failed; the next call retries only the invite.
 */
export async function provisionRepo(
  user: AuthUser,
  input: { githubUsername: string; projectName: string },
  ip: string | null,
  deps: ProvisionDeps = defaultDeps()
): Promise<ProvisionResult> {
  const provider = deps.provider;
  if (!provider) throw new AppError(503, "Repository provisioning is not configured", true);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let outcome: LockedOutcome;
    try {
      outcome = await runLocked(client, user, input, ip, deps, provider);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
    const { failure, ...result } = outcome;
    if (failure !== null) throw failure;
    return result;
  } finally {
    client.release();
  }
}
