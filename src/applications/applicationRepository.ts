import { pool } from "../db/pool.js";
import type { ApplicationRecord, ApplicationStatus, ReviewOutcome } from "./applicationTypes.js";

export interface NewApplication {
  userId: string;
  walletAddress: string;
  projectName: string;
  summary: string;
  websiteUrl: string;
  pitchDeckUrl: string;
  repoUrl: string | undefined;
  contact: string | undefined;
}

interface ApplicationRow {
  id: string;
  user_id: string;
  wallet_address: string;
  project_name: string;
  summary: string;
  website_url: string;
  pitch_deck_url: string;
  repo_url: string | null;
  contact: string | null;
  status: ApplicationStatus;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  kyc_verified_at: Date | null;
  kyc_verified_by: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ReviewRow {
  id: string;
  user_id: string;
  wallet_address: string;
  previous_status: ApplicationStatus;
  transitioned: boolean;
  role_changed: boolean;
}

const APPLICATION_COLUMNS = `id, user_id, wallet_address, project_name, summary, website_url,
  pitch_deck_url, repo_url, contact, status, review_note, reviewed_by, reviewed_at,
  kyc_verified_at, kyc_verified_by, created_at, updated_at`;

function toRecord(row: ApplicationRow): ApplicationRecord {
  return {
    id: row.id,
    userId: row.user_id,
    walletAddress: row.wallet_address,
    projectName: row.project_name,
    summary: row.summary,
    websiteUrl: row.website_url,
    pitchDeckUrl: row.pitch_deck_url,
    repoUrl: row.repo_url,
    contact: row.contact,
    status: row.status,
    reviewNote: row.review_note,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    kycVerifiedAt: row.kyc_verified_at,
    kycVerifiedBy: row.kyc_verified_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toOutcome(row: ReviewRow): ReviewOutcome {
  return {
    id: row.id,
    userId: row.user_id,
    walletAddress: row.wallet_address,
    previousStatus: row.previous_status,
    transitioned: row.transitioned,
    roleChanged: row.role_changed,
  };
}

/** Inserts a pending application. A unique-index violation (open application) propagates as a pg error. */
export async function insertApplication(input: NewApplication): Promise<ApplicationRecord> {
  const result = await pool.query<ApplicationRow>(
    `INSERT INTO app.founder_applications
       (user_id, wallet_address, project_name, summary, website_url, pitch_deck_url, repo_url, contact)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${APPLICATION_COLUMNS}`,
    [
      input.userId,
      input.walletAddress,
      input.projectName,
      input.summary,
      input.websiteUrl,
      input.pitchDeckUrl,
      input.repoUrl ?? null,
      input.contact ?? null,
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error("application insert returned no row");
  return toRecord(row);
}

export async function findLatestApplicationByUser(userId: string): Promise<ApplicationRecord | null> {
  const result = await pool.query<ApplicationRow>(
    `SELECT ${APPLICATION_COLUMNS} FROM app.founder_applications
     WHERE user_id = $1 ORDER BY created_at DESC, id LIMIT 1`,
    [userId]
  );
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

export async function findApplicationById(id: string): Promise<ApplicationRecord | null> {
  const result = await pool.query<ApplicationRow>(
    `SELECT ${APPLICATION_COLUMNS} FROM app.founder_applications WHERE id = $1`,
    [id]
  );
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

export async function listApplications(
  status: ApplicationStatus | undefined,
  limit: number,
  offset: number
): Promise<{ items: ApplicationRecord[]; total: number }> {
  const [page, count] = await Promise.all([
    pool.query<ApplicationRow>(
      `SELECT ${APPLICATION_COLUMNS} FROM app.founder_applications
       WHERE ($1::text IS NULL OR status = $1::text)
       ORDER BY created_at DESC, id LIMIT $2 OFFSET $3`,
      [status ?? null, limit, offset]
    ),
    pool.query<{ total: string }>(
      `SELECT count(*) AS total FROM app.founder_applications
       WHERE ($1::text IS NULL OR status = $1::text)`,
      [status ?? null]
    ),
  ]);
  return { items: page.rows.map(toRecord), total: Number(count.rows[0]?.total ?? 0) };
}

/**
 * Approves a PENDING application in ONE statement: the status transition with its KYC
 * stamp, the grant of the 'founder' role (only to a current 'investor', never a
 * downgrade of staff/admin), the revocation of the applicant's sessions when the role
 * changed, and the audit rows commit together or not at all. Returns null for an
 * unknown id; `transitioned` is false when the application was not pending or the
 * reviewer is the applicant (the caller tells these apart).
 */
export async function approveApplication(
  id: string,
  reviewerUserId: string,
  note: string | null,
  ip: string | null
): Promise<ReviewOutcome | null> {
  const result = await pool.query<ReviewRow>(
    `WITH target AS (
       SELECT a.id, a.user_id, a.wallet_address, a.status, u.role AS user_role
       FROM app.founder_applications a JOIN app.users u ON u.id = a.user_id
       WHERE a.id = $1::uuid
       FOR UPDATE OF a, u
     ),
     approved AS (
       UPDATE app.founder_applications a SET
         status = 'approved', kyc_verified_at = now(), kyc_verified_by = $2::uuid,
         reviewed_at = now(), reviewed_by = $2::uuid, review_note = $3::text, updated_at = now()
       FROM target t
       WHERE a.id = t.id AND t.status = 'pending' AND t.user_id <> $2::uuid
       RETURNING a.id
     ),
     promoted AS (
       UPDATE app.users us SET role = 'founder'
       FROM target t JOIN approved ap ON ap.id = t.id
       WHERE us.id = t.user_id AND t.user_role = 'investor'
       RETURNING us.id
     ),
     audit_approve AS (
       INSERT INTO app.audit_log (action, actor_user_id, target, before_value, after_value, ip)
       SELECT 'application.approve', $2::uuid, t.wallet_address, 'pending', 'approved', $4::text
       FROM target t JOIN approved ap ON ap.id = t.id
       RETURNING id
     ),
     audit_role AS (
       INSERT INTO app.audit_log (action, actor_user_id, target, before_value, after_value, ip)
       SELECT 'role.change', $2::uuid, t.wallet_address, 'investor', 'founder', $4::text
       FROM target t JOIN promoted p ON p.id = t.user_id
       RETURNING id
     ),
     revoked AS (
       DELETE FROM app.sessions WHERE user_id IN (SELECT id FROM promoted) RETURNING id_hash
     )
     SELECT t.id, t.user_id, t.wallet_address, t.status AS previous_status,
       (ap.id IS NOT NULL) AS transitioned, (p.id IS NOT NULL) AS role_changed
     FROM target t
     LEFT JOIN approved ap ON ap.id = t.id
     LEFT JOIN promoted p ON p.id = t.user_id`,
    [id, reviewerUserId, note, ip]
  );
  const row = result.rows[0];
  return row ? toOutcome(row) : null;
}

/** Rejects a PENDING application and writes its audit row in ONE statement; see approveApplication. */
export async function rejectApplication(
  id: string,
  reviewerUserId: string,
  note: string,
  ip: string | null
): Promise<ReviewOutcome | null> {
  const result = await pool.query<ReviewRow>(
    `WITH target AS (
       SELECT a.id, a.user_id, a.wallet_address, a.status
       FROM app.founder_applications a
       WHERE a.id = $1::uuid
       FOR UPDATE OF a
     ),
     rejected AS (
       UPDATE app.founder_applications a SET
         status = 'rejected', reviewed_at = now(), reviewed_by = $2::uuid,
         review_note = $3::text, updated_at = now()
       FROM target t
       WHERE a.id = t.id AND t.status = 'pending' AND t.user_id <> $2::uuid
       RETURNING a.id
     ),
     audit_reject AS (
       INSERT INTO app.audit_log (action, actor_user_id, target, before_value, after_value, ip)
       SELECT 'application.reject', $2::uuid, t.wallet_address, 'pending', 'rejected', $4::text
       FROM target t JOIN rejected r ON r.id = t.id
       RETURNING id
     )
     SELECT t.id, t.user_id, t.wallet_address, t.status AS previous_status,
       (r.id IS NOT NULL) AS transitioned, false AS role_changed
     FROM target t LEFT JOIN rejected r ON r.id = t.id`,
    [id, reviewerUserId, note, ip]
  );
  const row = result.rows[0];
  return row ? toOutcome(row) : null;
}
