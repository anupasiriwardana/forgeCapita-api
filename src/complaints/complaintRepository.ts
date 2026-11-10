import { pool, qualified } from "../db/pool.js";

export const COMPLAINT_CATEGORIES = [
  "MISREPRESENTATION",
  "REVENUE_UNDERREPORTING",
  "INACTIVITY",
  "SECURITY",
  "OTHER",
] as const;
export const COMPLAINT_STATUSES = ["OPEN", "INVESTIGATING", "RESOLVED", "DISMISSED"] as const;

export type ComplaintCategory = (typeof COMPLAINT_CATEGORIES)[number];
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

/** Complaints one user may file per rolling 24 hours. */
export const DAILY_COMPLAINT_CAP = 5;

const TRANSITIONS: Readonly<Record<ComplaintStatus, readonly ComplaintStatus[]>> = {
  OPEN: ["INVESTIGATING", "RESOLVED", "DISMISSED"],
  INVESTIGATING: ["RESOLVED", "DISMISSED"],
  RESOLVED: [],
  DISMISSED: [],
};

/** True when a staff status change from `from` to `to` is allowed. */
export function canTransition(from: ComplaintStatus, to: ComplaintStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface Complaint {
  id: string;
  projectId: string;
  chainId: number;
  category: ComplaintCategory;
  body: string;
  evidenceUrl: string | null;
  status: ComplaintStatus;
  /** Staff response; shown to the reporter of this complaint only. */
  staffNote: string | null;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
}

/** Staff view: adds the reporter wallet. */
export interface AdminComplaint extends Complaint {
  reporterAddress: string;
}

interface ComplaintRow {
  id: string;
  project_id: string;
  chain_id: number;
  category: ComplaintCategory;
  body: string;
  evidence_url: string | null;
  status: ComplaintStatus;
  staff_note: string | null;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
}

interface AdminComplaintRow extends ComplaintRow {
  reporter_address: string;
}

const COLUMNS = `c.id::text AS id, c.project_id, c.chain_id, c.category, c.body, c.evidence_url, c.status,
  c.staff_note, c.created_at, c.updated_at, c.resolved_at`;
const ADMIN_COLUMNS = `${COLUMNS}, u.wallet_address AS reporter_address`;
const ADMIN_FROM = `app.complaints c JOIN app.users u ON u.id = c.reporter_user_id`;

function toComplaint(r: ComplaintRow): Complaint {
  return {
    id: r.id,
    projectId: r.project_id,
    chainId: r.chain_id,
    category: r.category,
    body: r.body,
    evidenceUrl: r.evidence_url,
    status: r.status,
    staffNote: r.staff_note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at,
  };
}

function toAdminComplaint(r: AdminComplaintRow): AdminComplaint {
  return { ...toComplaint(r), reporterAddress: r.reporter_address };
}

function escrowOf(projectId: string): string {
  return projectId.split(":")[1] ?? "";
}

export interface NewComplaint {
  projectId: string;
  category: ComplaintCategory;
  body: string;
  evidenceUrl: string | null;
}

export type CreateResult =
  | { outcome: "ok"; complaint: Complaint }
  | { outcome: "project_not_found" }
  | { outcome: "rate_limited" }
  | { outcome: "duplicate" };

/**
 * Files a complaint in ONE transaction: project check, 24 h cap, insert and audit row (complaint
 * id only, never the text) commit together. The partial unique index maps to `duplicate`.
 */
export async function createComplaint(
  input: NewComplaint,
  reporterUserId: string,
  ip: string | null
): Promise<CreateResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const known = await client.query(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM app.startup_profiles WHERE project_id = $1)
              OR EXISTS (SELECT 1 FROM ${qualified("project")} WHERE id = $1)`,
      [input.projectId]
    );
    if (!known.rowCount) {
      await client.query("ROLLBACK");
      return { outcome: "project_not_found" };
    }
    // Serialise one user's filings so concurrent requests cannot slip past the cap.
    await client.query("SELECT 1 FROM app.users WHERE id = $1 FOR UPDATE", [reporterUserId]);
    const recent = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM app.complaints
       WHERE reporter_user_id = $1 AND created_at > now() - interval '24 hours'`,
      [reporterUserId]
    );
    if (Number(recent.rows[0]?.n ?? 0) >= DAILY_COMPLAINT_CAP) {
      await client.query("ROLLBACK");
      return { outcome: "rate_limited" };
    }
    const chainId = Number(input.projectId.split(":")[0]);
    const inserted = await client.query<ComplaintRow>(
      `INSERT INTO app.complaints (project_id, chain_id, reporter_user_id, category, body, evidence_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id::text AS id, project_id, chain_id, category, body, evidence_url, status,
         staff_note, created_at, updated_at, resolved_at`,
      [input.projectId, chainId, reporterUserId, input.category, input.body, input.evidenceUrl]
    );
    const row = inserted.rows[0];
    if (row === undefined) throw new Error("complaint insert returned no row");
    await client.query(
      `INSERT INTO app.audit_log (actor_user_id, action, target, before_value, after_value, ip)
       VALUES ($1, 'complaint.create', $2, 'NONE', $3, $4)`,
      [reporterUserId, escrowOf(input.projectId), `OPEN#${row.id}`, ip]
    );
    await client.query("COMMIT");
    return { outcome: "ok", complaint: toComplaint(row) };
  } catch (err) {
    await client.query("ROLLBACK");
    if ((err as { code?: string }).code === "23505") return { outcome: "duplicate" };
    throw err;
  } finally {
    client.release();
  }
}

/** The reporter's own complaints, newest first, including the staff note (no staff identity is stored on the row). */
export async function listOwnComplaints(reporterUserId: string, limit: number): Promise<Complaint[]> {
  const result = await pool.query<ComplaintRow>(
    `SELECT ${COLUMNS} FROM app.complaints c WHERE c.reporter_user_id = $1 ORDER BY c.id DESC LIMIT $2`,
    [reporterUserId, limit]
  );
  return result.rows.map(toComplaint);
}

export interface ComplaintFilter {
  status: ComplaintStatus | undefined;
  projectId: string | undefined;
  limit: number;
  offset: number;
}

export async function listComplaintsForAdmin(
  filter: ComplaintFilter
): Promise<{ items: AdminComplaint[]; total: number }> {
  const where = `WHERE ($1::text IS NULL OR c.status = $1::text) AND ($2::text IS NULL OR c.project_id = $2::text)`;
  const params = [filter.status ?? null, filter.projectId ?? null];
  const [page, count] = await Promise.all([
    pool.query<AdminComplaintRow>(
      `SELECT ${ADMIN_COLUMNS} FROM ${ADMIN_FROM} ${where} ORDER BY c.id DESC LIMIT $3 OFFSET $4`,
      [...params, filter.limit, filter.offset]
    ),
    pool.query<{ total: string }>(`SELECT count(*) AS total FROM app.complaints c ${where}`, params),
  ]);
  return { items: page.rows.map(toAdminComplaint), total: Number(count.rows[0]?.total ?? 0) };
}

export type StatusChangeResult =
  | { outcome: "ok"; complaint: AdminComplaint }
  | { outcome: "not_found" }
  | { outcome: "invalid_transition" };

/**
 * Staff status change in ONE transaction: row lock, update and audit row (actor = staff user)
 * commit together. The note is shown to the reporter but never logged or audited.
 */
export async function changeComplaintStatus(
  id: string,
  next: ComplaintStatus,
  note: string | null,
  actorUserId: string,
  ip: string | null
): Promise<StatusChangeResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<{ status: ComplaintStatus; project_id: string }>(
      `SELECT status, project_id FROM app.complaints WHERE id = $1::bigint FOR UPDATE`,
      [id]
    );
    const current = found.rows[0];
    if (current === undefined) {
      await client.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    if (!canTransition(current.status, next)) {
      await client.query("ROLLBACK");
      return { outcome: "invalid_transition" };
    }
    await client.query(
      `UPDATE app.complaints SET status = $2, staff_note = COALESCE($3, staff_note), updated_at = now(),
         resolved_at = CASE WHEN $2 IN ('RESOLVED', 'DISMISSED') THEN now() ELSE resolved_at END
       WHERE id = $1::bigint`,
      [id, next, note]
    );
    await client.query(
      `INSERT INTO app.audit_log (actor_user_id, action, target, before_value, after_value, ip)
       VALUES ($1, 'complaint.status', $2, $3, $4, $5)`,
      [actorUserId, escrowOf(current.project_id), current.status, `${next}#${id}`, ip]
    );
    const updated = await client.query<AdminComplaintRow>(
      `SELECT ${ADMIN_COLUMNS} FROM ${ADMIN_FROM} WHERE c.id = $1::bigint`,
      [id]
    );
    await client.query("COMMIT");
    const row = updated.rows[0];
    if (row === undefined) throw new Error("complaint update returned no row");
    return { outcome: "ok", complaint: toAdminComplaint(row) };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
