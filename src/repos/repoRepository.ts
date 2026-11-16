import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";

export type RepoStatus = "invited" | "active" | "failed" | "revoked";

export interface RepoRecord {
  id: string;
  userId: string;
  founderWallet: string;
  provider: "github";
  repoId: string;
  repoName: string;
  fullName: string;
  htmlUrl: string;
  founderLogin: string;
  collaboratorId: string | null;
  status: RepoStatus;
  projectId: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface NewRepo {
  userId: string;
  repoId: number;
  repoName: string;
  fullName: string;
  htmlUrl: string;
  founderLogin: string;
}

export type Db = Pick<PoolClient, "query">;

interface RepoRow {
  id: string;
  user_id: string;
  founder_wallet: string;
  provider: "github";
  repo_id: string;
  repo_name: string;
  full_name: string;
  html_url: string;
  founder_login: string;
  collaborator_id: string | null;
  collaborator_status: RepoStatus;
  project_id: string | null;
  created_at: Date;
  revoked_at?: Date | null;
}

const COLUMNS = `r.id, r.user_id, u.wallet_address AS founder_wallet, r.provider, r.repo_id::text AS repo_id,
  r.repo_name, r.full_name, r.html_url, r.founder_login, r.collaborator_id::text AS collaborator_id,
  r.collaborator_status, r.project_id, r.created_at, r.revoked_at`;

function toRecord(row: RepoRow): RepoRecord {
  return {
    id: row.id,
    userId: row.user_id,
    founderWallet: row.founder_wallet,
    provider: row.provider,
    repoId: row.repo_id,
    repoName: row.repo_name,
    fullName: row.full_name,
    htmlUrl: row.html_url,
    founderLogin: row.founder_login,
    collaboratorId: row.collaborator_id,
    status: row.collaborator_status,
    projectId: row.project_id,
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? null,
  };
}

/** Serialises provisioning per founder for the rest of the transaction. */
export async function lockUser(db: Db, userId: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`repo:${userId}`]);
}

/** The founder's repo that is not yet linked to a project, if any. */
export async function findUnlinkedRepo(db: Db, userId: string): Promise<RepoRecord | null> {
  const result = await db.query<RepoRow>(
    `SELECT ${COLUMNS} FROM app.project_repos r JOIN app.users u ON u.id = r.user_id
     WHERE r.user_id = $1 AND r.project_id IS NULL`,
    [userId]
  );
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

/** Inserts a fresh repo row with status failed (promoted once the invite succeeds). */
export async function insertRepo(db: Db, repo: NewRepo): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO app.project_repos (user_id, provider, repo_id, repo_name, full_name, html_url, founder_login, collaborator_status)
     VALUES ($1, 'github', $2::bigint, $3, $4, $5, $6, 'failed') RETURNING id`,
    [repo.userId, String(repo.repoId), repo.repoName, repo.fullName, repo.htmlUrl, repo.founderLogin]
  );
  const row = result.rows[0];
  if (!row) throw new Error("project_repos insert returned no row");
  return row.id;
}

export async function updateCollaborator(
  db: Db,
  id: string,
  status: RepoStatus,
  collaboratorId: number | null
): Promise<void> {
  await db.query(
    `UPDATE app.project_repos SET collaborator_status = $2, collaborator_id = $3::bigint, updated_at = now() WHERE id = $1`,
    [id, status, collaboratorId === null ? null : String(collaboratorId)]
  );
}

/** Appends the provisioning audit row; target is the founder wallet (lowercase). */
export async function insertProvisionAudit(
  db: Db,
  actorUserId: string,
  founderWallet: string,
  before: RepoStatus | null,
  after: RepoStatus,
  ip: string | null
): Promise<void> {
  await db.query(
    `INSERT INTO app.audit_log (actor_user_id, action, target, before_value, after_value, ip)
     VALUES ($1, 'repo.provision', $2, $3, $4, $5)`,
    [actorUserId, founderWallet, before, after, ip]
  );
}

/** Locks one repo row for the rest of the transaction; null when the id is unknown. */
export async function findRepoForUpdate(db: Db, id: string): Promise<RepoRecord | null> {
  const result = await db.query<RepoRow>(
    `SELECT ${COLUMNS} FROM app.project_repos r JOIN app.users u ON u.id = r.user_id
     WHERE r.id = $1 FOR UPDATE OF r`,
    [id]
  );
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

/** Marks the repo revoked and returns the stored timestamp. */
export async function markRevoked(db: Db, id: string): Promise<Date> {
  const result = await db.query<{ revoked_at: Date }>(
    `UPDATE app.project_repos SET collaborator_status = 'revoked', revoked_at = now(), updated_at = now()
     WHERE id = $1 RETURNING revoked_at`,
    [id]
  );
  const row = result.rows[0];
  if (!row) throw new Error("project_repos revoke returned no row");
  return row.revoked_at;
}

/** Appends the lock-out audit row; target is the founder wallet (lowercase), actor is the admin. */
export async function insertRevokeAudit(
  db: Db,
  actorUserId: string,
  founderWallet: string,
  before: RepoStatus,
  ip: string | null
): Promise<void> {
  await db.query(
    `INSERT INTO app.audit_log (actor_user_id, action, target, before_value, after_value, ip)
     VALUES ($1, 'repo.revoke', $2, $3, 'revoked', $4)`,
    [actorUserId, founderWallet, before, ip]
  );
}

/** The founder's most recent repo (linked or not) for the self-service read. */
export async function findLatestRepo(userId: string): Promise<RepoRecord | null> {
  const result = await pool.query<RepoRow>(
    `SELECT ${COLUMNS} FROM app.project_repos r JOIN app.users u ON u.id = r.user_id
     WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT 1`,
    [userId]
  );
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

export async function listRepos(
  userId: string | undefined,
  limit: number,
  offset: number
): Promise<{ items: RepoRecord[]; total: number }> {
  const filter = userId ?? null;
  const [rows, count] = await Promise.all([
    pool.query<RepoRow>(
      `SELECT ${COLUMNS} FROM app.project_repos r JOIN app.users u ON u.id = r.user_id
       WHERE ($1::uuid IS NULL OR r.user_id = $1::uuid)
       ORDER BY r.created_at DESC, r.id LIMIT $2::int OFFSET $3::int`,
      [filter, limit, offset]
    ),
    pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM app.project_repos r WHERE ($1::uuid IS NULL OR r.user_id = $1::uuid)`,
      [filter]
    ),
  ]);
  return { items: rows.rows.map(toRecord), total: Number(count.rows[0]?.total ?? "0") };
}
