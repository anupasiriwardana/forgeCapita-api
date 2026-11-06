import { pool } from "../db/pool.js";

export type WalletStatus = "pending" | "approved" | "rejected";

export interface AcceptanceRecord {
  version: string;
  textHash: string;
  acceptedAt: Date;
}

export interface ShadowWalletRecord {
  id: string;
  userId: string;
  founderWallet: string;
  address: string;
  status: WalletStatus;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

export interface WalletReviewOutcome {
  id: string;
  userId: string;
  transitioned: boolean;
}

export interface LaunchChecks {
  applicationApproved: boolean;
  agreementAccepted: boolean;
  shadowWalletAvailable: boolean;
}

export interface OwnWalletRecord {
  id: string;
  address: string;
  status: WalletStatus;
  reviewNote: string | null;
  projectId: string | null;
  /** True while an active (pending/attached) launch draft holds the wallet. */
  reserved: boolean;
}

export interface ApprovedWallet {
  id: string;
  userId: string;
  address: string;
  /** Held by an active launch draft. */
  reserved: boolean;
  /** Bound to a startup profile. */
  bound: boolean;
}

export type WalletReference = { id: string } | { address: string };

export interface NewAcceptance {
  userId: string;
  walletAddress: string;
  version: string;
  textHash: string;
  typedName: string;
  message: string;
  signature: string;
  issuedAt: Date;
  ip: string | null;
}

interface AcceptanceRow {
  agreement_version: string;
  text_hash: string;
  accepted_at: Date;
}

interface WalletRow {
  id: string;
  user_id: string;
  founder_wallet: string;
  address: string;
  status: WalletStatus;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Date;
}

interface OwnWalletRow {
  id: string;
  address: string;
  status: WalletStatus;
  review_note: string | null;
  project_id: string | null;
  reserved: boolean;
}

interface ApprovedWalletRow {
  id: string;
  user_id: string;
  address: string;
  reserved: boolean;
  bound: boolean;
}

interface ReviewRow {
  id: string;
  user_id: string;
  transitioned: boolean;
}

interface ChecksRow {
  application_approved: boolean;
  agreement_accepted: boolean;
  shadow_wallet_available: boolean;
}

const WALLET_SELECT = `SELECT w.id, w.user_id, u.wallet_address AS founder_wallet, w.address, w.status,
  w.review_note, w.reviewed_by, w.reviewed_at, w.created_at
  FROM app.founder_wallets w JOIN app.users u ON u.id = w.user_id`;

function toAcceptance(row: AcceptanceRow): AcceptanceRecord {
  return { version: row.agreement_version, textHash: row.text_hash, acceptedAt: row.accepted_at };
}

function toWallet(row: WalletRow): ShadowWalletRecord {
  return {
    id: row.id,
    userId: row.user_id,
    founderWallet: row.founder_wallet,
    address: row.address,
    status: row.status,
    reviewNote: row.review_note,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
  };
}

/**
 * Stores the signed acceptance and its audit row in ONE statement. The unique constraint
 * (user_id, agreement_version) propagates as a pg 23505 error when already accepted.
 */
export async function insertAcceptance(input: NewAcceptance): Promise<AcceptanceRecord> {
  const result = await pool.query<AcceptanceRow>(
    `WITH accepted AS (
       INSERT INTO app.agreement_acceptances
         (user_id, wallet_address, agreement_version, text_hash, typed_name, message, signature, issued_at, ip)
       VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::timestamptz, $9::text)
       RETURNING wallet_address, agreement_version, text_hash, accepted_at
     ),
     audited AS (
       INSERT INTO app.audit_log (action, actor_user_id, target, before_value, after_value, ip)
       SELECT 'agreement.accept', $1::uuid, a.wallet_address, NULL, a.agreement_version, $9::text
       FROM accepted a
       RETURNING id
     )
     SELECT agreement_version, text_hash, accepted_at FROM accepted`,
    [
      input.userId,
      input.walletAddress,
      input.version,
      input.textHash,
      input.typedName,
      input.message,
      input.signature,
      input.issuedAt,
      input.ip,
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error("agreement insert returned no row");
  return toAcceptance(row);
}

export async function findAcceptance(userId: string, version: string): Promise<AcceptanceRecord | null> {
  const result = await pool.query<AcceptanceRow>(
    `SELECT agreement_version, text_hash, accepted_at FROM app.agreement_acceptances
     WHERE user_id = $1 AND agreement_version = $2`,
    [userId, version]
  );
  const row = result.rows[0];
  return row ? toAcceptance(row) : null;
}

/** Inserts a pending shadow wallet with its audit row. A unique violation (open request) propagates. */
export async function insertShadowWallet(
  userId: string,
  founderWallet: string,
  address: string,
  ip: string | null
): Promise<ShadowWalletRecord> {
  const result = await pool.query<WalletRow>(
    `WITH requested AS (
       INSERT INTO app.founder_wallets (user_id, address)
       VALUES ($1::uuid, $3::text)
       RETURNING id, user_id, address, status, review_note, reviewed_by, reviewed_at, created_at
     ),
     audited AS (
       INSERT INTO app.audit_log (action, actor_user_id, target, before_value, after_value, ip)
       SELECT 'shadow_wallet.request', $1::uuid, $2::text, NULL, 'pending', $4::text
       FROM requested
       RETURNING id
     )
     SELECT r.id, r.user_id, $2::text AS founder_wallet, r.address, r.status, r.review_note,
       r.reviewed_by, r.reviewed_at, r.created_at
     FROM requested r`,
    [userId, founderWallet, address, ip]
  );
  const row = result.rows[0];
  if (!row) throw new Error("shadow wallet insert returned no row");
  return toWallet(row);
}

/** All wallets of a founder (newest first, bounded) with the project each one is bound to. */
export async function listOwnWallets(userId: string): Promise<OwnWalletRecord[]> {
  const result = await pool.query<OwnWalletRow>(
    `SELECT w.id, w.address, w.status, w.review_note,
       COALESCE(s.project_id, d.project_id) AS project_id, (d.id IS NOT NULL) AS reserved
     FROM app.founder_wallets w
     LEFT JOIN app.startup_profiles s ON s.founder_wallet_id = w.id
     LEFT JOIN app.launch_drafts d ON d.founder_wallet_id = w.id AND d.status IN ('pending', 'attached')
     WHERE w.user_id = $1::uuid
     ORDER BY w.created_at DESC, w.id LIMIT 50`,
    [userId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    address: row.address,
    status: row.status,
    reviewNote: row.review_note,
    projectId: row.project_id,
    reserved: row.reserved === true,
  }));
}

const APPROVED_WALLET_SELECT = `SELECT w.id, w.user_id, w.address,
  EXISTS (SELECT 1 FROM app.launch_drafts d
          WHERE d.founder_wallet_id = w.id AND d.status IN ('pending', 'attached')) AS reserved,
  EXISTS (SELECT 1 FROM app.startup_profiles s WHERE s.founder_wallet_id = w.id) AS bound
  FROM app.founder_wallets w`;

/** Resolves an APPROVED wallet by id or lowercase address (approved addresses are unique). */
export async function findApprovedWallet(ref: WalletReference): Promise<ApprovedWallet | null> {
  const result =
    "id" in ref
      ? await pool.query<ApprovedWalletRow>(
          `${APPROVED_WALLET_SELECT} WHERE w.id = $1::uuid AND w.status = 'approved'`,
          [ref.id]
        )
      : await pool.query<ApprovedWalletRow>(
          `${APPROVED_WALLET_SELECT} WHERE w.address = $1::text AND w.status = 'approved'`,
          [ref.address]
        );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        userId: row.user_id,
        address: row.address,
        reserved: row.reserved === true,
        bound: row.bound === true,
      }
    : null;
}

export async function findShadowWalletById(id: string): Promise<ShadowWalletRecord | null> {
  const result = await pool.query<WalletRow>(`${WALLET_SELECT} WHERE w.id = $1`, [id]);
  const row = result.rows[0];
  return row ? toWallet(row) : null;
}

export async function listShadowWallets(
  status: WalletStatus | undefined,
  limit: number,
  offset: number
): Promise<{ items: ShadowWalletRecord[]; total: number }> {
  const [page, count] = await Promise.all([
    pool.query<WalletRow>(
      `${WALLET_SELECT} WHERE ($1::text IS NULL OR w.status = $1::text)
       ORDER BY w.created_at DESC, w.id LIMIT $2 OFFSET $3`,
      [status ?? null, limit, offset]
    ),
    pool.query<{ total: string }>(
      `SELECT count(*) AS total FROM app.founder_wallets w
       WHERE ($1::text IS NULL OR w.status = $1::text)`,
      [status ?? null]
    ),
  ]);
  return { items: page.rows.map(toWallet), total: Number(count.rows[0]?.total ?? 0) };
}

function toOutcome(row: ReviewRow): WalletReviewOutcome {
  return { id: row.id, userId: row.user_id, transitioned: row.transitioned };
}

/**
 * Moves a PENDING shadow wallet to `approved` or `rejected` and writes the audit row in ONE
 * statement (row locked with FOR UPDATE). Returns null for an unknown id; `transitioned` is
 * false when the wallet was not pending or the reviewer owns it.
 */
async function reviewShadowWallet(
  id: string,
  reviewerUserId: string,
  status: "approved" | "rejected",
  note: string | null,
  ip: string | null
): Promise<WalletReviewOutcome | null> {
  const result = await pool.query<ReviewRow>(
    `WITH target AS (
       SELECT w.id, w.user_id, w.status, u.wallet_address
       FROM app.founder_wallets w JOIN app.users u ON u.id = w.user_id
       WHERE w.id = $1::uuid
       FOR UPDATE OF w
     ),
     reviewed AS (
       UPDATE app.founder_wallets w SET
         status = $3::text, reviewed_at = now(), reviewed_by = $2::uuid,
         review_note = $4::text, updated_at = now()
       FROM target t
       WHERE w.id = t.id AND t.status = 'pending' AND t.user_id <> $2::uuid
       RETURNING w.id
     ),
     audited AS (
       INSERT INTO app.audit_log (action, actor_user_id, target, before_value, after_value, ip)
       SELECT 'shadow_wallet.' || CASE WHEN $3::text = 'approved' THEN 'approve' ELSE 'reject' END,
         $2::uuid, t.wallet_address, 'pending', $3::text, $5::text
       FROM target t JOIN reviewed r ON r.id = t.id
       RETURNING id
     )
     SELECT t.id, t.user_id, (r.id IS NOT NULL) AS transitioned
     FROM target t LEFT JOIN reviewed r ON r.id = t.id`,
    [id, reviewerUserId, status, note, ip]
  );
  const row = result.rows[0];
  return row ? toOutcome(row) : null;
}

export function approveShadowWallet(
  id: string,
  reviewerUserId: string,
  note: string | null,
  ip: string | null
): Promise<WalletReviewOutcome | null> {
  return reviewShadowWallet(id, reviewerUserId, "approved", note, ip);
}

export function rejectShadowWallet(
  id: string,
  reviewerUserId: string,
  note: string,
  ip: string | null
): Promise<WalletReviewOutcome | null> {
  return reviewShadowWallet(id, reviewerUserId, "rejected", note, ip);
}

export async function readLaunchChecks(userId: string, version: string): Promise<LaunchChecks> {
  const result = await pool.query<ChecksRow>(
    `SELECT
       EXISTS (SELECT 1 FROM app.founder_applications WHERE user_id = $1::uuid AND status = 'approved')
         AS application_approved,
       EXISTS (SELECT 1 FROM app.agreement_acceptances WHERE user_id = $1::uuid AND agreement_version = $2::text)
         AS agreement_accepted,
       EXISTS (
         SELECT 1 FROM app.founder_wallets w
         WHERE w.user_id = $1::uuid AND w.status = 'approved'
           AND NOT EXISTS (SELECT 1 FROM app.startup_profiles s WHERE s.founder_wallet_id = w.id)
           AND NOT EXISTS (
             SELECT 1 FROM app.launch_drafts d
             WHERE d.founder_wallet_id = w.id AND d.status IN ('pending', 'attached')
           )
       ) AS shadow_wallet_available`,
    [userId, version]
  );
  const row = result.rows[0];
  return {
    applicationApproved: row?.application_approved ?? false,
    agreementAccepted: row?.agreement_accepted ?? false,
    shadowWalletAvailable: row?.shadow_wallet_available ?? false,
  };
}
