import { pool } from "../db/pool.js";
import type { Role } from "../types/index.js";

export interface RoleChangeInput {
  actorUserId: string;
  targetAddress: string;
  newRole: Role;
  ip: string | null;
}

export interface RoleChangeResult {
  userId: string;
  address: string;
  previousRole: Role;
  changed: boolean;
}

export interface AuditEntry {
  id: string;
  actorUserId: string | null;
  action: string;
  target: string;
  beforeValue: string | null;
  afterValue: string | null;
  ip: string | null;
  createdAt: Date;
}

interface RoleChangeRow {
  id: string;
  wallet_address: string;
  previous_role: Role;
  changed: boolean;
}

interface AuditRow {
  id: string;
  actor_user_id: string | null;
  action: string;
  target: string;
  before_value: string | null;
  after_value: string | null;
  ip: string | null;
  created_at: Date;
}

/**
 * Changes a non-admin user's role in ONE statement: the update, its audit row and the
 * revocation of the user's sessions (so the new role applies on next sign-in) commit
 * together or not at all. Returns null for an unknown address. Admins are never touched;
 * an unchanged role writes no audit row.
 */
export async function insertRoleChange(input: RoleChangeInput): Promise<RoleChangeResult | null> {
  const result = await pool.query<RoleChangeRow>(
    `WITH existing AS (
       SELECT id, wallet_address, role FROM app.users WHERE wallet_address = $1 FOR UPDATE
     ),
     updated AS (
       UPDATE app.users u SET role = $2::text
       FROM existing e
       WHERE u.id = e.id AND e.role <> 'admin' AND e.role <> $2::text
       RETURNING u.id, u.wallet_address, u.role
     ),
     audited AS (
       INSERT INTO app.audit_log (action, actor_user_id, target, before_value, after_value, ip)
       SELECT 'role.change', $3::uuid, u.wallet_address, e.role, u.role, $4::text
       FROM updated u JOIN existing e ON e.id = u.id
       RETURNING id
     ),
     revoked AS (
       DELETE FROM app.sessions WHERE user_id IN (SELECT id FROM updated) RETURNING id_hash
     )
     SELECT e.id, e.wallet_address, e.role AS previous_role, (u.id IS NOT NULL) AS changed
     FROM existing e LEFT JOIN updated u ON u.id = e.id`,
    [input.targetAddress, input.newRole, input.actorUserId, input.ip]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    userId: row.id,
    address: row.wallet_address,
    previousRole: row.previous_role,
    changed: row.changed,
  };
}

export async function listAuditEntries(limit: number, offset: number): Promise<AuditEntry[]> {
  const result = await pool.query<AuditRow>(
    `SELECT id, actor_user_id, action, target, before_value, after_value, ip, created_at
     FROM app.audit_log ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return result.rows.map((row) => ({
    id: row.id,
    actorUserId: row.actor_user_id,
    action: row.action,
    target: row.target,
    beforeValue: row.before_value,
    afterValue: row.after_value,
    ip: row.ip,
    createdAt: row.created_at,
  }));
}

export interface AuditFilter {
  action: string | undefined;
  target: string | undefined;
  actor: string | undefined;
  limit: number;
  offset: number;
}

const AUDIT_FILTER_SQL = `WHERE ($1::text IS NULL OR action = $1::text)
       AND ($2::text IS NULL OR target = $2::text)
       AND ($3::uuid IS NULL OR actor_user_id = $3::uuid)`;

/** Filtered, paged audit read with a total over the same filters. Read-only. */
export async function listAuditPage(filter: AuditFilter): Promise<{ items: AuditEntry[]; total: number }> {
  const filterParams = [filter.action ?? null, filter.target ?? null, filter.actor ?? null];
  const [page, count] = await Promise.all([
    pool.query<AuditRow>(
      `SELECT id, actor_user_id, action, target, before_value, after_value, ip, created_at
       FROM app.audit_log ${AUDIT_FILTER_SQL}
       ORDER BY created_at DESC, id DESC LIMIT $4 OFFSET $5`,
      [...filterParams, filter.limit, filter.offset]
    ),
    pool.query<{ total: string }>(`SELECT count(*) AS total FROM app.audit_log ${AUDIT_FILTER_SQL}`, filterParams),
  ]);
  return {
    items: page.rows.map((row) => ({
      id: row.id,
      actorUserId: row.actor_user_id,
      action: row.action,
      target: row.target,
      beforeValue: row.before_value,
      afterValue: row.after_value,
      ip: row.ip,
      createdAt: row.created_at,
    })),
    total: Number(count.rows[0]?.total ?? 0),
  };
}
