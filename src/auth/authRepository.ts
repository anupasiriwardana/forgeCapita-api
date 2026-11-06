import { pool } from "../db/pool.js";
import type { AuthUser, Role } from "../types/index.js";

export interface SessionRecord {
  user: AuthUser;
  lastSeenAt: Date;
  expiresAt: Date;
}

export interface StoredNonce {
  message: string;
  expiresAt: Date;
}

interface SessionJoinRow {
  user_id: string;
  wallet_address: string;
  role: Role;
  last_seen_at: Date;
  expires_at: Date;
}

interface UserRow {
  id: string;
  wallet_address: string;
  role: Role;
}

function toUser(row: UserRow): AuthUser {
  return { id: row.id, address: row.wallet_address, role: row.role };
}

export async function deleteExpiredNonces(): Promise<void> {
  await pool.query("DELETE FROM app.auth_nonces WHERE expires_at <= now()");
}

export async function upsertNonce(
  address: string,
  nonce: string,
  message: string,
  expiresAt: Date
): Promise<void> {
  await pool.query(
    `INSERT INTO app.auth_nonces (address, nonce, message, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (address) DO UPDATE SET
       nonce = EXCLUDED.nonce, message = EXCLUDED.message, expires_at = EXCLUDED.expires_at`,
    [address, nonce, message, expiresAt]
  );
}

/** Atomically deletes and returns the nonce row, so a nonce can be used once. */
export async function consumeNonce(address: string): Promise<StoredNonce | null> {
  const result = await pool.query<{ message: string; expires_at: Date }>(
    "DELETE FROM app.auth_nonces WHERE address = $1 RETURNING message, expires_at",
    [address]
  );
  const row = result.rows[0];
  return row ? { message: row.message, expiresAt: row.expires_at } : null;
}

/** Creates the user or refreshes last_login_at; promotes to admin when `makeAdmin`. */
export async function upsertUser(address: string, makeAdmin: boolean): Promise<AuthUser> {
  const result = await pool.query<UserRow>(
    `INSERT INTO app.users (wallet_address, role, last_login_at)
     VALUES ($1, CASE WHEN $2::boolean THEN 'admin' ELSE 'investor' END, now())
     ON CONFLICT (wallet_address) DO UPDATE SET
       last_login_at = now(),
       role = CASE WHEN $2::boolean THEN 'admin' ELSE app.users.role END
     RETURNING id, wallet_address, role`,
    [address, makeAdmin]
  );
  const row = result.rows[0];
  if (!row) throw new Error("user upsert returned no row");
  return toUser(row);
}

export async function insertSession(
  idHash: string,
  userId: string,
  expiresAt: Date,
  ip: string | null,
  userAgent: string | null
): Promise<void> {
  await pool.query(
    `INSERT INTO app.sessions (id_hash, user_id, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [idHash, userId, expiresAt, ip, userAgent]
  );
}

/** Keeps the newest `keep` sessions of a user and deletes the rest. */
export async function pruneSessions(userId: string, keep: number): Promise<void> {
  await pool.query(
    `DELETE FROM app.sessions
     WHERE user_id = $1
       AND id_hash NOT IN (
         SELECT id_hash FROM app.sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2
       )`,
    [userId, keep]
  );
}

export async function findSession(idHash: string): Promise<SessionRecord | null> {
  const result = await pool.query<SessionJoinRow>(
    `SELECT u.id AS user_id, u.wallet_address, u.role, s.last_seen_at, s.expires_at
     FROM app.sessions s
     JOIN app.users u ON u.id = s.user_id
     WHERE s.id_hash = $1`,
    [idHash]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    user: toUser({ id: row.user_id, wallet_address: row.wallet_address, role: row.role }),
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
  };
}

export async function touchSession(idHash: string): Promise<void> {
  await pool.query("UPDATE app.sessions SET last_seen_at = now() WHERE id_hash = $1", [idHash]);
}

export async function deleteSession(idHash: string): Promise<void> {
  await pool.query("DELETE FROM app.sessions WHERE id_hash = $1", [idHash]);
}

/** Removes every session that is past its absolute expiry or idle for longer than `idleSeconds`. */
export async function deleteExpiredSessions(idleSeconds: number): Promise<void> {
  await pool.query(
    `DELETE FROM app.sessions WHERE expires_at <= now()
       OR last_seen_at <= now() - make_interval(secs => $1::double precision)`,
    [idleSeconds]
  );
}

export interface UserListFilter {
  role: Role | undefined;
  /** Lowercase hex address prefix. */
  addressPrefix: string | undefined;
  limit: number;
  offset: number;
}

export interface UserListItem {
  id: string;
  address: string;
  role: Role;
  createdAt: Date;
  lastLoginAt: Date | null;
}

interface UserListRow {
  id: string;
  wallet_address: string;
  role: Role;
  created_at: Date;
  last_login_at: Date | null;
}

const USER_FILTER_SQL = `WHERE ($1::text IS NULL OR role = $1::text)
       AND ($2::text IS NULL OR starts_with(wallet_address, $2::text))`;

export async function listUsers(
  filter: UserListFilter
): Promise<{ items: UserListItem[]; total: number }> {
  const filterParams = [filter.role ?? null, filter.addressPrefix ?? null];
  const [page, count] = await Promise.all([
    pool.query<UserListRow>(
      `SELECT id, wallet_address, role, created_at, last_login_at
       FROM app.users ${USER_FILTER_SQL}
       ORDER BY created_at DESC, id
       LIMIT $3 OFFSET $4`,
      [...filterParams, filter.limit, filter.offset]
    ),
    pool.query<{ total: string }>(
      `SELECT count(*) AS total FROM app.users ${USER_FILTER_SQL}`,
      filterParams
    ),
  ]);
  return {
    items: page.rows.map((row) => ({
      id: row.id,
      address: row.wallet_address,
      role: row.role,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
    })),
    total: Number(count.rows[0]?.total ?? 0),
  };
}
