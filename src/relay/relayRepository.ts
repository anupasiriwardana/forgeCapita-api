import { pool, qualified } from "../db/pool.js";

export type RelayKind = "claim" | "stake" | "vote";
export type RelayStatus = "QUEUED" | "SENDING" | "SENT" | "CONFIRMED" | "FAILED" | "EXPIRED";

/** Client-safe view of a request: never carries `args` (calldata with the signature). */
export interface RelayRecord {
  id: string;
  kind: RelayKind;
  chainId: number;
  projectId: string;
  status: RelayStatus;
  errorCode: string | null;
  errorMessage: string | null;
  txHash: string | null;
  gasUsed: string | null;
  effectiveGasPrice: string | null;
  createdAt: Date;
  sentAt: Date | null;
  confirmedAt: Date | null;
  expiresAt: Date;
}

export interface RelayProject {
  id: string;
  chainId: number;
  escrowAddress: string;
  distributorAddress: string;
  tokenAddress: string;
}

export interface NewRelayRequest {
  kind: RelayKind;
  chainId: number;
  projectId: string;
  userId: string;
  account: string;
  payload: Record<string, unknown>;
  args: { to: string; data: string };
  idemKey: string;
  expiresAt: Date;
}

/** A claimed queue row; the only shape that exposes the calldata, used by the worker alone. */
export interface QueuedRelay {
  id: string;
  kind: RelayKind;
  to: string;
  data: string;
}

export interface SentRelay {
  id: string;
  txHash: string;
}

interface RelayRow {
  id: string;
  kind: RelayKind;
  chain_id: number;
  project_id: string;
  status: RelayStatus;
  error_code: string | null;
  error_message: string | null;
  tx_hash: string | null;
  gas_used: string | null;
  effective_gas_price: string | null;
  created_at: Date;
  sent_at: Date | null;
  confirmed_at: Date | null;
  expires_at: Date;
}

const RECORD_COLUMNS = `id, kind, chain_id, project_id, status, error_code, error_message, tx_hash,
  gas_used, effective_gas_price, created_at, sent_at, confirmed_at, expires_at`;

function toRecord(row: RelayRow): RelayRecord {
  return {
    id: row.id,
    kind: row.kind,
    chainId: row.chain_id,
    projectId: row.project_id,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    txHash: row.tx_hash,
    gasUsed: row.gas_used,
    effectiveGasPrice: row.effective_gas_price,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    confirmedAt: row.confirmed_at,
    expiresAt: row.expires_at,
  };
}

interface ProjectRow {
  id: string;
  chain_id: number;
  escrow_address: string;
  distributor_address: string;
  token_address: string;
}

/** Looks the project up in the indexer table; addresses are normalised to lowercase. */
export async function findRelayProject(projectId: string): Promise<RelayProject | null> {
  const result = await pool.query<ProjectRow>(
    `SELECT "id", "chain_id", "escrow_address", "distributor_address", "token_address"
     FROM ${qualified("project")} WHERE "id" = $1`,
    [projectId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    chainId: row.chain_id,
    escrowAddress: row.escrow_address.toLowerCase(),
    distributorAddress: row.distributor_address.toLowerCase(),
    tokenAddress: row.token_address.toLowerCase(),
  };
}

/** The newest request with this key that is still live or done (FAILED and EXPIRED may be retried). */
export async function findActiveByIdemKey(idemKey: string): Promise<RelayRecord | null> {
  const result = await pool.query<RelayRow>(
    `SELECT ${RECORD_COLUMNS} FROM app.relay_requests
     WHERE idem_key = $1 AND status NOT IN ('FAILED', 'EXPIRED')`,
    [idemKey]
  );
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

export async function countUserSince24h(userId: string): Promise<number> {
  const result = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM app.relay_requests
     WHERE user_id = $1 AND created_at > now() - interval '24 hours'`,
    [userId]
  );
  return result.rows[0]?.n ?? 0;
}

export async function countChainSince24h(chainId: number): Promise<number> {
  const result = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM app.relay_requests
     WHERE chain_id = $1 AND created_at > now() - interval '24 hours'`,
    [chainId]
  );
  return result.rows[0]?.n ?? 0;
}

/**
 * Inserts a queued request. A FAILED/EXPIRED row holding the same key is first renamed so it keeps
 * counting towards quotas while the new row can reuse the key. Returns null when a live row already
 * owns the key (idempotent repeat or a concurrent insert).
 */
export async function insertRelayRequest(input: NewRelayRequest): Promise<RelayRecord | null> {
  await pool.query(
    `UPDATE app.relay_requests SET idem_key = idem_key || ':' || id::text
     WHERE idem_key = $1 AND status IN ('FAILED', 'EXPIRED')`,
    [input.idemKey]
  );
  const result = await pool.query<RelayRow>(
    `INSERT INTO app.relay_requests
       (kind, chain_id, project_id, user_id, account, payload, args, idem_key, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
     ON CONFLICT (idem_key) DO NOTHING
     RETURNING ${RECORD_COLUMNS}`,
    [
      input.kind,
      input.chainId,
      input.projectId,
      input.userId,
      input.account,
      JSON.stringify(input.payload),
      JSON.stringify(input.args),
      input.idemKey,
      input.expiresAt,
    ]
  );
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

export async function findOwnRequest(id: string, userId: string): Promise<RelayRecord | null> {
  const result = await pool.query<RelayRow>(
    `SELECT ${RECORD_COLUMNS} FROM app.relay_requests WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

export async function listOwnRequests(userId: string, limit: number): Promise<RelayRecord[]> {
  const result = await pool.query<RelayRow>(
    `SELECT ${RECORD_COLUMNS} FROM app.relay_requests
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return result.rows.map(toRecord);
}

// ─── Worker statements ──────────────────────────────────────────────────────

/** Boot recovery: a row left SENDING without a hash may or may not have been broadcast, so it is failed. */
export async function failInterrupted(): Promise<number> {
  const result = await pool.query(
    `UPDATE app.relay_requests
     SET status = 'FAILED', error_code = 'INTERRUPTED', error_message = 'Relay interrupted by a restart'
     WHERE status = 'SENDING' AND tx_hash IS NULL`
  );
  return result.rowCount ?? 0;
}

/** Expires queued or never-sent rows past their deadline. */
export async function expireStale(): Promise<number> {
  const result = await pool.query(
    `UPDATE app.relay_requests SET status = 'EXPIRED'
     WHERE status IN ('QUEUED', 'SENDING') AND tx_hash IS NULL AND expires_at < now()`
  );
  return result.rowCount ?? 0;
}

interface QueuedRow {
  id: string;
  kind: RelayKind;
  args: { to: string; data: string };
}

/** Atomically takes the oldest queued, unexpired row of a chain and marks it SENDING. */
export async function claimNextQueued(chainId: number): Promise<QueuedRelay | null> {
  const result = await pool.query<QueuedRow>(
    `UPDATE app.relay_requests SET status = 'SENDING'
     WHERE id = (
       SELECT id FROM app.relay_requests
       WHERE status = 'QUEUED' AND chain_id = $1 AND expires_at > now()
       ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     RETURNING id, kind, args`,
    [chainId]
  );
  const row = result.rows[0];
  return row ? { id: row.id, kind: row.kind, to: row.args.to, data: row.args.data } : null;
}

export async function markSent(id: string, txHash: string): Promise<void> {
  await pool.query(
    `UPDATE app.relay_requests SET status = 'SENT', tx_hash = $2, sent_at = now()
     WHERE id = $1 AND status = 'SENDING'`,
    [id, txHash]
  );
}

export async function markFailed(
  id: string,
  errorCode: string,
  errorMessage: string,
  gas?: { gasUsed: bigint; effectiveGasPrice: bigint }
): Promise<void> {
  await pool.query(
    `UPDATE app.relay_requests
     SET status = 'FAILED', error_code = $2, error_message = $3, gas_used = $4, effective_gas_price = $5
     WHERE id = $1 AND status IN ('SENDING', 'SENT')`,
    [id, errorCode, errorMessage, gas?.gasUsed.toString() ?? null, gas?.effectiveGasPrice.toString() ?? null]
  );
}

export async function markConfirmed(id: string, gasUsed: bigint, effectiveGasPrice: bigint): Promise<void> {
  await pool.query(
    `UPDATE app.relay_requests
     SET status = 'CONFIRMED', gas_used = $2, effective_gas_price = $3, confirmed_at = now()
     WHERE id = $1 AND status = 'SENT'`,
    [id, gasUsed.toString(), effectiveGasPrice.toString()]
  );
}

export async function listSent(chainId: number, limit: number): Promise<SentRelay[]> {
  const result = await pool.query<{ id: string; tx_hash: string }>(
    `SELECT id, tx_hash FROM app.relay_requests
     WHERE status = 'SENT' AND chain_id = $1 AND tx_hash IS NOT NULL
     ORDER BY sent_at LIMIT $2`,
    [chainId, limit]
  );
  return result.rows.map((row) => ({ id: row.id, txHash: row.tx_hash }));
}
