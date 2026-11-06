import { pool } from "../db/pool.js";
import type { DraftPayload } from "../schemas/draftSchemas.js";

export type DraftStatus = "pending" | "attached" | "applied" | "cancelled" | "expired" | "conflict";

export interface DraftRecord {
  id: string;
  userId: string;
  status: DraftStatus;
  chainId: number;
  founderWalletId: string | null;
  escrowAddress: string | null;
  projectId: string | null;
  name: string;
  createdAt: Date;
  appliedAt: Date | null;
}

export interface NewDraft {
  userId: string;
  walletAddress: string;
  chainId: number;
  founderWalletId: string | null;
  payload: DraftPayload;
  ip: string | null;
}

interface DraftRow {
  id: string;
  user_id: string;
  status: DraftStatus;
  chain_id: number;
  founder_wallet_id: string | null;
  escrow_address: string | null;
  project_id: string | null;
  name: string;
  created_at: Date;
  applied_at: Date | null;
}

const DRAFT_COLUMNS = `id, user_id, status, chain_id, founder_wallet_id, escrow_address, project_id,
  payload->>'name' AS name, created_at, applied_at`;

/**
 * Column list for a SELECT over a CTE that already exposed DRAFT_COLUMNS: `payload` no longer exists
 * there and `name` is already the aliased value (selecting DRAFT_COLUMNS again fails with 42703).
 */
const OUTER_COLUMNS = `id, user_id, status, chain_id, founder_wallet_id, escrow_address, project_id,
  name, created_at, applied_at`;

function toDraft(row: DraftRow): DraftRecord {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    chainId: row.chain_id,
    founderWalletId: row.founder_wallet_id,
    escrowAddress: row.escrow_address,
    projectId: row.project_id,
    name: row.name,
    createdAt: row.created_at,
    appliedAt: row.applied_at,
  };
}

/** Inserts a pending draft with its audit row in ONE statement; a unique violation propagates. */
export async function insertDraft(input: NewDraft): Promise<DraftRecord> {
  const result = await pool.query<DraftRow>(
    `WITH created AS (
       INSERT INTO app.launch_drafts (user_id, wallet_address, chain_id, founder_wallet_id, payload)
       VALUES ($1::uuid, $2::text, $3::integer, $4::uuid, $5::jsonb)
       RETURNING ${DRAFT_COLUMNS}, wallet_address
     ),
     audited AS (
       INSERT INTO app.audit_log (action, actor_user_id, target, before_value, after_value, ip)
       SELECT 'launch_draft.create', $1::uuid, c.wallet_address, NULL, 'pending', $6::text
       FROM created c
       RETURNING id
     )
     SELECT ${OUTER_COLUMNS} FROM created`,
    [
      input.userId,
      input.walletAddress,
      input.chainId,
      input.founderWalletId,
      JSON.stringify(input.payload),
      input.ip,
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error("draft insert returned no row");
  return toDraft(row);
}

export async function findOwnDraft(id: string, userId: string): Promise<DraftRecord | null> {
  const result = await pool.query<DraftRow>(
    `SELECT ${DRAFT_COLUMNS} FROM app.launch_drafts WHERE id = $1::uuid AND user_id = $2::uuid`,
    [id, userId]
  );
  const row = result.rows[0];
  return row ? toDraft(row) : null;
}

export async function listOwnDrafts(userId: string): Promise<DraftRecord[]> {
  const result = await pool.query<DraftRow>(
    `SELECT ${DRAFT_COLUMNS} FROM app.launch_drafts WHERE user_id = $1::uuid
     ORDER BY created_at DESC, id LIMIT 20`,
    [userId]
  );
  return result.rows.map(toDraft);
}

/**
 * Moves the owner's PENDING draft to attached with the escrow address. Returns null when no
 * pending draft matched. A project_id unique violation propagates.
 */
export async function attachPendingDraft(
  id: string,
  userId: string,
  escrowAddress: string
): Promise<DraftRecord | null> {
  const result = await pool.query<DraftRow>(
    `UPDATE app.launch_drafts SET
       escrow_address = $3::text, project_id = chain_id::text || ':' || $3::text,
       status = 'attached', attached_at = now(), updated_at = now()
     WHERE id = $1::uuid AND user_id = $2::uuid AND status = 'pending'
     RETURNING ${DRAFT_COLUMNS}`,
    [id, userId, escrowAddress]
  );
  const row = result.rows[0];
  return row ? toDraft(row) : null;
}

/** Cancels the owner's PENDING draft (releasing the wallet) with its audit row; null if none matched. */
export async function cancelPendingDraft(
  id: string,
  userId: string,
  ip: string | null
): Promise<DraftRecord | null> {
  const result = await pool.query<DraftRow>(
    `WITH cancelled AS (
       UPDATE app.launch_drafts SET status = 'cancelled', updated_at = now()
       WHERE id = $1::uuid AND user_id = $2::uuid AND status = 'pending'
       RETURNING ${DRAFT_COLUMNS}, wallet_address
     ),
     audited AS (
       INSERT INTO app.audit_log (action, actor_user_id, target, before_value, after_value, ip)
       SELECT 'launch_draft.cancel', $2::uuid, c.wallet_address, 'pending', 'cancelled', $3::text
       FROM cancelled c
       RETURNING id
     )
     SELECT ${OUTER_COLUMNS} FROM cancelled`,
    [id, userId, ip]
  );
  const row = result.rows[0];
  return row ? toDraft(row) : null;
}
