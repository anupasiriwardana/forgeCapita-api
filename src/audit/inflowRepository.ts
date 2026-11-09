import { pool } from "../db/pool.js";
import type { InflowEntry, InflowKind } from "./explorerClient.js";

export interface AuditWallet {
  chainId: number;
  address: string;
}

interface WalletRow {
  chain_id: number;
  address: string;
}

/**
 * Approved, bound shadow wallets on the given chains (the APPROVED founder_wallets address, never
 * the legacy startup_profiles.shadow_wallet). Never-polled wallets come first, then the least
 * recently polled, so every wallet is covered over successive passes.
 */
export async function listAuditWallets(chainIds: readonly number[], limit: number): Promise<AuditWallet[]> {
  const result = await pool.query<WalletRow>(
    `SELECT w.chain_id, w.address
     FROM (
       SELECT DISTINCT sp.chain_id, lower(fw.address) AS address
       FROM app.startup_profiles sp
       JOIN app.founder_wallets fw ON fw.id = sp.founder_wallet_id AND fw.status = 'approved'
       WHERE sp.chain_id = ANY($1::int[])
     ) w
     LEFT JOIN (
       SELECT chain_id, wallet_address, max(last_polled_at) AS polled
       FROM app.inflow_cursors
       GROUP BY chain_id, wallet_address
     ) c ON c.chain_id = w.chain_id AND c.wallet_address = w.address
     ORDER BY c.polled ASC NULLS FIRST, w.chain_id, w.address
     LIMIT $2::int`,
    [chainIds, limit]
  );
  return result.rows.map((row) => ({ chainId: row.chain_id, address: row.address }));
}

export async function readCursor(chainId: number, wallet: string, kind: InflowKind): Promise<bigint> {
  const result = await pool.query<{ last_block: string }>(
    "SELECT last_block FROM app.inflow_cursors WHERE chain_id = $1 AND wallet_address = $2 AND kind = $3",
    [chainId, wallet, kind]
  );
  const row = result.rows[0];
  return row === undefined ? 0n : BigInt(row.last_block);
}

/** Moves the cursor forward only (never back), stamps the poll time and stores the short error or clears it. */
export async function writeCursor(
  chainId: number,
  wallet: string,
  kind: InflowKind,
  lastBlock: bigint,
  error: string | null
): Promise<void> {
  await pool.query(
    `INSERT INTO app.inflow_cursors (chain_id, wallet_address, kind, last_block, last_polled_at, last_error)
     VALUES ($1, $2, $3, $4::bigint, now(), $5)
     ON CONFLICT (chain_id, wallet_address, kind) DO UPDATE SET
       last_block = GREATEST(app.inflow_cursors.last_block, EXCLUDED.last_block),
       last_polled_at = now(),
       last_error = EXCLUDED.last_error`,
    [chainId, wallet, kind, lastBlock.toString(), error === null ? null : error.slice(0, 200)]
  );
}

const INSERT_CHUNK = 500;

/** Inserts entries once; duplicates (same chain, tx, kind, entry_ref) are ignored. Returns the new row count. */
export async function insertInflows(chainId: number, wallet: string, entries: readonly InflowEntry[]): Promise<number> {
  let inserted = 0;
  for (let start = 0; start < entries.length; start += INSERT_CHUNK) {
    const chunk = entries.slice(start, start + INSERT_CHUNK);
    const result = await pool.query(
      `INSERT INTO app.inflow_records
         (chain_id, wallet_address, tx_hash, kind, entry_ref, token_address, token_symbol, amount,
          from_address, block_number, block_time)
       SELECT $1::int, $2::text, t.tx_hash, t.kind, t.entry_ref, t.token_address, t.token_symbol,
         t.amount::numeric, t.from_address, t.block_number::bigint, t.block_time::bigint
       FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[],
                   $10::text[], $11::text[])
         AS t(tx_hash, kind, entry_ref, token_address, token_symbol, amount, from_address, block_number, block_time)
       ON CONFLICT (chain_id, tx_hash, kind, entry_ref) DO NOTHING`,
      [
        chainId,
        wallet,
        chunk.map((e) => e.txHash),
        chunk.map((e) => e.kind),
        chunk.map((e) => e.entryRef),
        chunk.map((e) => e.tokenAddress),
        chunk.map((e) => e.tokenSymbol),
        chunk.map((e) => e.amount.toString()),
        chunk.map((e) => e.fromAddress),
        chunk.map((e) => e.blockNumber.toString()),
        chunk.map((e) => e.blockTime.toString()),
      ]
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

// --- staff read --------------------------------------------------------------

export interface InflowFilter {
  chainId: number | undefined;
  projectId: string | undefined;
  kind: InflowKind | undefined;
  limit: number;
  offset: number;
}

export interface InflowItem {
  id: string;
  chainId: number;
  walletAddress: string;
  txHash: string;
  kind: InflowKind;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  amount: string;
  fromAddress: string;
  blockNumber: string;
  blockTime: string;
  firstSeenAt: Date;
}

export interface InflowCursorItem {
  kind: InflowKind;
  lastBlock: string;
  lastPolledAt: Date | null;
  lastError: string | null;
}

interface InflowRow {
  id: string;
  chain_id: number;
  wallet_address: string;
  tx_hash: string;
  kind: InflowKind;
  token_address: string | null;
  token_symbol: string | null;
  amount: string;
  from_address: string;
  block_number: string;
  block_time: string;
  first_seen_at: Date;
}

/**
 * The record filter. A projectId resolves to its approved bound wallet through startup_profiles
 * ($3 is "<chainId>:<escrow>"); an unbound project matches nothing.
 */
const INFLOW_FILTER_SQL = `
  WHERE ($1::int IS NULL OR r.chain_id = $1::int)
    AND ($2::text IS NULL OR r.kind = $2::text)
    AND ($3::text IS NULL OR EXISTS (
      SELECT 1 FROM app.startup_profiles sp
      JOIN app.founder_wallets fw ON fw.id = sp.founder_wallet_id AND fw.status = 'approved'
      WHERE sp.project_id = $3::text AND sp.chain_id = r.chain_id AND lower(fw.address) = r.wallet_address
    ))`;

export async function listInflowsForAdmin(filter: InflowFilter): Promise<{ items: InflowItem[]; total: number }> {
  const filterParams = [filter.chainId ?? null, filter.kind ?? null, filter.projectId ?? null];
  const [page, count] = await Promise.all([
    pool.query<InflowRow>(
      `SELECT r.id::text AS id, r.chain_id, r.wallet_address, r.tx_hash, r.kind, r.token_address,
         r.token_symbol, r.amount::text AS amount, r.from_address, r.block_number::text AS block_number,
         r.block_time::text AS block_time, r.first_seen_at
       FROM app.inflow_records r ${INFLOW_FILTER_SQL}
       ORDER BY r.block_time DESC, r.id DESC LIMIT $4 OFFSET $5`,
      [...filterParams, filter.limit, filter.offset]
    ),
    pool.query<{ total: string }>(`SELECT count(*) AS total FROM app.inflow_records r ${INFLOW_FILTER_SQL}`, filterParams),
  ]);
  return {
    items: page.rows.map((row) => ({
      id: row.id,
      chainId: row.chain_id,
      walletAddress: row.wallet_address,
      txHash: row.tx_hash,
      kind: row.kind,
      tokenAddress: row.token_address,
      tokenSymbol: row.token_symbol,
      amount: row.amount,
      fromAddress: row.from_address,
      blockNumber: row.block_number,
      blockTime: row.block_time,
      firstSeenAt: row.first_seen_at,
    })),
    total: Number(count.rows[0]?.total ?? 0),
  };
}

/** Cursors of the approved wallet bound to a project (empty when unbound or never polled). */
export async function listCursorsForProject(projectId: string): Promise<InflowCursorItem[]> {
  const result = await pool.query<{
    kind: InflowKind;
    last_block: string;
    last_polled_at: Date | null;
    last_error: string | null;
  }>(
    `SELECT c.kind, c.last_block::text AS last_block, c.last_polled_at, c.last_error
     FROM app.inflow_cursors c
     JOIN app.startup_profiles sp ON sp.project_id = $1::text AND sp.chain_id = c.chain_id
     JOIN app.founder_wallets fw ON fw.id = sp.founder_wallet_id AND fw.status = 'approved'
       AND lower(fw.address) = c.wallet_address
     ORDER BY c.kind`,
    [projectId]
  );
  return result.rows.map((row) => ({
    kind: row.kind,
    lastBlock: row.last_block,
    lastPolledAt: row.last_polled_at,
    lastError: row.last_error,
  }));
}
