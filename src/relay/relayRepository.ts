import { pool, qualified } from "../db/pool.js";

export type RelayKind = "claim" | "stake" | "vote" | "execute";
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
  /** null only for system `execute` requests. */
  userId: string | null;
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

// --- Admin read model ---------------------------------------------------------

export interface AdminRelayFilter {
  kind: RelayKind | undefined;
  status: RelayStatus | undefined;
  chainId: number | undefined;
  system: boolean;
  projectId: string | undefined;
  limit: number;
  offset: number;
}

export interface AdminRelayRecord extends RelayRecord {
  userId: string | null;
  account: string;
}

interface AdminRelayRow extends RelayRow {
  user_id: string | null;
  account: string;
}

const ADMIN_RELAY_FILTER_SQL = `WHERE ($1::text IS NULL OR kind = $1::text)
       AND ($2::text IS NULL OR status = $2::text)
       AND ($3::integer IS NULL OR chain_id = $3::integer)
       AND ($4::boolean = false OR user_id IS NULL)
       AND ($5::text IS NULL OR project_id = $5::text)`;

/** Filtered, paged request list for staff. Never selects `args` or `payload`. */
export async function listRelayRequestsForAdmin(
  filter: AdminRelayFilter
): Promise<{ items: AdminRelayRecord[]; total: number }> {
  const filterParams = [
    filter.kind ?? null,
    filter.status ?? null,
    filter.chainId ?? null,
    filter.system,
    filter.projectId ?? null,
  ];
  const [page, count] = await Promise.all([
    pool.query<AdminRelayRow>(
      `SELECT ${RECORD_COLUMNS}, user_id, account FROM app.relay_requests ${ADMIN_RELAY_FILTER_SQL}
       ORDER BY created_at DESC, id LIMIT $6 OFFSET $7`,
      [...filterParams, filter.limit, filter.offset]
    ),
    pool.query<{ total: string }>(
      `SELECT count(*) AS total FROM app.relay_requests ${ADMIN_RELAY_FILTER_SQL}`,
      filterParams
    ),
  ]);
  return {
    items: page.rows.map((row) => ({ ...toRecord(row), userId: row.user_id, account: row.account })),
    total: Number(count.rows[0]?.total ?? 0),
  };
}

// --- Automatic milestone execution -------------------------------------------

export interface ExecuteCandidate {
  projectId: string;
  chainId: number;
  escrowAddress: string;
  milestoneIndex: number;
}

interface CandidateRow {
  project_id: string;
  chain_id: number;
  escrow_address: string;
  milestone_index: number;
}

/**
 * Indexed projects whose current milestone is open, unexecuted and past its indexed voting end
 * (`endedBefore`, unix seconds). Milestones that already have a live/confirmed execute row, or a
 * SELF_PAY failure, are left out so they cannot starve the batch. The chain stays authoritative.
 */
export async function listExecuteCandidates(
  chainId: number,
  endedBefore: bigint,
  limit: number
): Promise<ExecuteCandidate[]> {
  const result = await pool.query<CandidateRow>(
    `SELECT p."id" AS project_id, p."chain_id", p."escrow_address", m."milestone_index"
     FROM ${qualified("project")} p
     JOIN ${qualified("milestone")} m
       ON m."project_id" = p."id" AND m."milestone_index" = p."current_milestone_index"
     WHERE p."chain_id" = $1 AND p."state" = 'ACTIVE' AND p."is_invalidated" = false
       AND p."cancelled_at" IS NULL
       AND m."is_voting_open" = true AND m."is_executed" = false AND m."is_failed" = false
       AND m."voting_end_time" <= $2::numeric
       AND NOT EXISTS (
         SELECT 1 FROM app.relay_requests r
         WHERE r.kind = 'execute'
           AND r.idem_key = 'execute:' || p."chain_id" || ':' || lower(p."escrow_address") || ':' || m."milestone_index"
           AND (r.status NOT IN ('FAILED', 'EXPIRED') OR r.error_code = 'SELF_PAY')
       )
     ORDER BY m."voting_end_time" LIMIT $3`,
    [chainId, endedBefore.toString(), limit]
  );
  return result.rows.map((row) => ({
    projectId: row.project_id,
    chainId: row.chain_id,
    escrowAddress: row.escrow_address.toLowerCase(),
    milestoneIndex: row.milestone_index,
  }));
}

export interface ExecuteHistory {
  /** A QUEUED/SENDING/SENT/CONFIRMED row exists for the key. */
  live: boolean;
  selfPay: boolean;
  /** FAILED or EXPIRED rows (including renamed earlier attempts). */
  failures: number;
  lastAttemptAt: Date | null;
}

interface HistoryRow {
  status: RelayStatus;
  error_code: string | null;
  created_at: Date;
}

/** Earlier execute attempts for one key, including rows renamed by a retry. */
export async function executeHistory(idemKey: string): Promise<ExecuteHistory> {
  const result = await pool.query<HistoryRow>(
    `SELECT status, error_code, created_at FROM app.relay_requests
     WHERE kind = 'execute' AND (idem_key = $1 OR idem_key LIKE $2)
     ORDER BY created_at DESC LIMIT 50`,
    [idemKey, `${idemKey}:%`]
  );
  const history: ExecuteHistory = { live: false, selfPay: false, failures: 0, lastAttemptAt: null };
  for (const row of result.rows) {
    history.lastAttemptAt ??= row.created_at;
    if (row.status === "FAILED" || row.status === "EXPIRED") history.failures += 1;
    else history.live = true;
    if (row.error_code === "SELF_PAY") history.selfPay = true;
  }
  return history;
}

/** Records a failed system attempt (so it is visible and counted); a previous row with the key is renamed. */
export async function recordExecuteFailure(
  request: Omit<NewRelayRequest, "kind" | "userId" | "expiresAt">,
  errorCode: string,
  errorMessage: string
): Promise<void> {
  await pool.query(
    `UPDATE app.relay_requests SET idem_key = idem_key || ':' || id::text
     WHERE idem_key = $1 AND status IN ('FAILED', 'EXPIRED')`,
    [request.idemKey]
  );
  await pool.query(
    `INSERT INTO app.relay_requests
       (kind, chain_id, project_id, user_id, account, payload, args, idem_key, status, error_code, error_message, expires_at)
     VALUES ('execute', $1, $2, NULL, $3, $4::jsonb, $5::jsonb, $6, 'FAILED', $7, $8, now())
     ON CONFLICT (idem_key) DO NOTHING`,
    [
      request.chainId,
      request.projectId,
      request.account,
      JSON.stringify(request.payload),
      JSON.stringify(request.args),
      request.idemKey,
      errorCode,
      errorMessage,
    ]
  );
}
