import { pool, qualified } from "../db/pool.js";
import { nextState, type ComplianceState, type OpenCase, type OpenState } from "./complianceLogic.js";

export interface CheckableProject {
  projectId: string;
  chainId: number;
  escrow: string;
  wallet: string;
}

const MAX_PROJECTS = 500;

/** Projects on the audited chains with an approved bound wallet (never the legacy shadow_wallet). */
export async function listCheckableProjects(chainIds: readonly number[]): Promise<CheckableProject[]> {
  const result = await pool.query<{ project_id: string; chain_id: number; escrow: string; wallet: string }>(
    `SELECT sp.project_id, sp.chain_id, sp.escrow_address AS escrow, lower(fw.address) AS wallet
     FROM app.startup_profiles sp
     JOIN app.founder_wallets fw ON fw.id = sp.founder_wallet_id AND fw.status = 'approved'
     WHERE sp.chain_id = ANY($1::int[])
     ORDER BY sp.project_id LIMIT $2::int`,
    [chainIds, MAX_PROJECTS]
  );
  return result.rows.map((r) => ({ projectId: r.project_id, chainId: r.chain_id, escrow: r.escrow, wallet: r.wallet }));
}

/** True when the native cursor was polled and no cursor of the wallet holds an error. */
export async function walletCursorsHealthy(chainId: number, wallet: string): Promise<boolean> {
  const result = await pool.query<{ healthy: boolean }>(
    `SELECT bool_or(kind = 'native' AND last_polled_at IS NOT NULL) AND NOT bool_or(last_error IS NOT NULL) AS healthy
     FROM app.inflow_cursors WHERE chain_id = $1 AND wallet_address = $2`,
    [chainId, wallet]
  );
  return result.rows[0]?.healthy === true;
}

/** Native inflow only: internal and ERC-20 transfers are not counted. Window bounds are unix seconds. */
export async function sumObservedNative(chainId: number, wallet: string, fromSec: number, toSec: number): Promise<bigint> {
  const result = await pool.query<{ total: string }>(
    `SELECT COALESCE(sum(amount), 0)::text AS total FROM app.inflow_records
     WHERE chain_id = $1 AND wallet_address = $2 AND kind = 'native' AND block_time >= $3::bigint AND block_time <= $4::bigint`,
    [chainId, wallet, fromSec, toSec]
  );
  return BigInt(result.rows[0]?.total ?? "0");
}

/** Sum of on-chain routed gross revenue of a project over the window (Ponder revenue_record). */
export async function sumRouted(projectId: string, chainId: number, fromSec: number, toSec: number): Promise<bigint> {
  const result = await pool.query<{ total: string }>(
    `SELECT COALESCE(sum(gross), 0)::text AS total FROM ${qualified("revenue_record")}
     WHERE project_id = $1 AND chain_id = $2 AND "timestamp" >= $3::numeric AND "timestamp" <= $4::numeric`,
    [projectId, chainId, fromSec, toSec]
  );
  return BigInt(result.rows[0]?.total ?? "0");
}

export interface CheckResult {
  project: CheckableProject;
  observed: bigint;
  routed: bigint;
  shortfallBps: number;
  flagged: boolean;
  windowStartSec: number;
  windowEndSec: number;
  now: Date;
}

const AUDIT_ACTIONS = {
  WARNED: "compliance.warn",
  ESCALATED: "compliance.escalate",
  RESOLVED: "compliance.resolve",
} as const;

interface OpenRow {
  id: string;
  state: OpenState;
  opened_at: Date;
}

/**
 * Records one check and applies the automatic state transition. The case update and its audit_log
 * row (NULL actor = automatic) commit together. Returns the new state.
 */
export async function applyCheck(check: CheckResult): Promise<ComplianceState> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<OpenRow>(
      `SELECT id::text AS id, state, opened_at FROM app.compliance_cases
       WHERE project_id = $1 AND state IN ('OK', 'WARNED', 'ESCALATED') FOR UPDATE`,
      [check.project.projectId]
    );
    const open = found.rows[0];
    const shutdown = await client.query(
      `SELECT 1 FROM app.compliance_cases WHERE project_id = $1 AND state = 'SHUTDOWN' LIMIT 1`,
      [check.project.projectId]
    );
    if (shutdown.rowCount) {
      // SHUTDOWN is terminal: the job never writes for a shut-down project.
      await client.query("COMMIT");
      return "SHUTDOWN";
    }
    const current: OpenCase | null = open ? { state: open.state, openedAt: open.opened_at } : null;
    const next = nextState(current, check.flagged, check.now);
    const values = [
      check.observed.toString(),
      check.routed.toString(),
      check.shortfallBps,
      check.windowStartSec,
      check.windowEndSec,
    ];

    if (open === undefined) {
      await client.query(
        `INSERT INTO app.compliance_cases
           (project_id, chain_id, state, last_checked_at, last_inflow_wei, last_routed_wei, last_shortfall_bps, window_start, window_end)
         VALUES ($1, $2, $3, now(), $4::numeric, $5::numeric, $6::int, to_timestamp($7::bigint), to_timestamp($8::bigint))`,
        [check.project.projectId, check.project.chainId, next, ...values]
      );
    } else {
      await client.query(
        `UPDATE app.compliance_cases SET
           state = $2,
           state_changed_at = CASE WHEN state <> $2 THEN now() ELSE state_changed_at END,
           opened_at = CASE WHEN state = 'OK' AND $2 = 'WARNED' THEN now() ELSE opened_at END,
           escalated_at = CASE WHEN state <> 'ESCALATED' AND $2 = 'ESCALATED' THEN now() ELSE escalated_at END,
           resolved_at = CASE WHEN $2 = 'RESOLVED' THEN now() ELSE resolved_at END,
           last_checked_at = now(), last_inflow_wei = $3::numeric, last_routed_wei = $4::numeric,
           last_shortfall_bps = $5::int, window_start = to_timestamp($6::bigint), window_end = to_timestamp($7::bigint)
         WHERE id = $1::bigint`,
        [open.id, next, ...values]
      );
    }

    const before = current?.state ?? "NONE";
    if (next !== before && next !== "OK") {
      await client.query(
        `INSERT INTO app.audit_log (actor_user_id, action, target, before_value, after_value)
         VALUES (NULL, $1, $2, $3, $4)`,
        [AUDIT_ACTIONS[next], check.project.escrow, before, next]
      );
    }
    await client.query("COMMIT");
    return next;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// --- reads -------------------------------------------------------------------

export interface TransparencyRow {
  known: boolean;
  wallet: string | null;
  state: ComplianceState | null;
  lastCheckedAt: Date | null;
  observed: string | null;
  routed: string | null;
  shortfallBps: number | null;
}

/** Latest case row of a project plus whether the project exists and its approved bound wallet. */
export async function readTransparency(projectId: string): Promise<TransparencyRow> {
  const result = await pool.query<{
    known: boolean;
    wallet: string | null;
    state: ComplianceState | null;
    last_checked_at: Date | null;
    observed: string | null;
    routed: string | null;
    shortfall_bps: number | null;
  }>(
    `SELECT (EXISTS (SELECT 1 FROM app.startup_profiles WHERE project_id = $1)
            OR EXISTS (SELECT 1 FROM ${qualified("project")} WHERE id = $1)) AS known,
       (SELECT lower(fw.address) FROM app.startup_profiles sp
          JOIN app.founder_wallets fw ON fw.id = sp.founder_wallet_id AND fw.status = 'approved'
          WHERE sp.project_id = $1) AS wallet,
       c.state, c.last_checked_at, c.last_inflow_wei::text AS observed, c.last_routed_wei::text AS routed,
       c.last_shortfall_bps AS shortfall_bps
     FROM (SELECT 1) one
     LEFT JOIN LATERAL (
       SELECT * FROM app.compliance_cases WHERE project_id = $1 ORDER BY id DESC LIMIT 1
     ) c ON true`,
    [projectId]
  );
  const row = result.rows[0];
  return {
    known: row?.known === true,
    wallet: row?.wallet ?? null,
    state: row?.state ?? null,
    lastCheckedAt: row?.last_checked_at ?? null,
    observed: row?.observed ?? null,
    routed: row?.routed ?? null,
    shortfallBps: row?.shortfall_bps ?? null,
  };
}

export interface ComplianceFilter {
  state: ComplianceState | undefined;
  chainId: number | undefined;
  limit: number;
  offset: number;
}

export interface ComplianceItem {
  id: string;
  projectId: string;
  chainId: number;
  state: ComplianceState;
  openedAt: Date;
  stateChangedAt: Date;
  escalatedAt: Date | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  lastCheckedAt: Date | null;
  inflowWei: string | null;
  routedWei: string | null;
  shortfallBps: number | null;
  windowStart: Date | null;
  windowEnd: Date | null;
}

const COMPLIANCE_FILTER_SQL = `WHERE ($1::text IS NULL OR state = $1::text) AND ($2::int IS NULL OR chain_id = $2::int)`;

interface CaseRow {
  id: string;
  project_id: string;
  chain_id: number;
  state: ComplianceState;
  opened_at: Date;
  state_changed_at: Date;
  escalated_at: Date | null;
  resolved_at: Date | null;
  resolution_note: string | null;
  last_checked_at: Date | null;
  inflow: string | null;
  routed: string | null;
  shortfall_bps: number | null;
  window_start: Date | null;
  window_end: Date | null;
}

const CASE_COLUMNS = `id::text AS id, project_id, chain_id, state, opened_at, state_changed_at, escalated_at, resolved_at,
         resolution_note, last_checked_at, last_inflow_wei::text AS inflow, last_routed_wei::text AS routed,
         last_shortfall_bps AS shortfall_bps, window_start, window_end`;

function toItem(r: CaseRow): ComplianceItem {
  return {
    id: r.id,
    projectId: r.project_id,
    chainId: r.chain_id,
    state: r.state,
    openedAt: r.opened_at,
    stateChangedAt: r.state_changed_at,
    escalatedAt: r.escalated_at,
    resolvedAt: r.resolved_at,
    resolutionNote: r.resolution_note,
    lastCheckedAt: r.last_checked_at,
    inflowWei: r.inflow,
    routedWei: r.routed,
    shortfallBps: r.shortfall_bps,
    windowStart: r.window_start,
    windowEnd: r.window_end,
  };
}

export async function listCasesForAdmin(filter: ComplianceFilter): Promise<{ items: ComplianceItem[]; total: number }> {
  const filterParams = [filter.state ?? null, filter.chainId ?? null];
  const [page, count] = await Promise.all([
    pool.query<CaseRow>(
      `SELECT ${CASE_COLUMNS}
       FROM app.compliance_cases ${COMPLIANCE_FILTER_SQL}
       ORDER BY state_changed_at DESC, id DESC LIMIT $3 OFFSET $4`,
      [...filterParams, filter.limit, filter.offset]
    ),
    pool.query<{ total: string }>(`SELECT count(*) AS total FROM app.compliance_cases ${COMPLIANCE_FILTER_SQL}`, filterParams),
  ]);
  return {
    items: page.rows.map(toItem),
    total: Number(count.rows[0]?.total ?? 0),
  };
}

// --- staff actions -----------------------------------------------------------

export type ManualCloseKind = "resolve" | "shutdown";

export type ManualCloseResult =
  | { outcome: "ok"; item: ComplianceItem }
  | { outcome: "not_found" }
  | { outcome: "not_eligible" };

const MANUAL_CLOSE = {
  resolve: { allowed: ["WARNED", "ESCALATED"], next: "RESOLVED", action: "compliance.resolve" },
  shutdown: { allowed: ["ESCALATED"], next: "SHUTDOWN", action: "compliance.shutdown" },
} as const;

/**
 * Staff resolve/shutdown of a project's open case in ONE transaction: row lock, state change and
 * audit_log row (actor = staff user) commit together. The note is stored but never logged.
 */
export async function closeCaseManually(
  kind: ManualCloseKind,
  projectId: string,
  actorUserId: string,
  note: string,
  ip: string | null
): Promise<ManualCloseResult> {
  const rule = MANUAL_CLOSE[kind];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const known = await client.query(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM app.startup_profiles WHERE project_id = $1)
              OR EXISTS (SELECT 1 FROM ${qualified("project")} WHERE id = $1)`,
      [projectId]
    );
    if (!known.rowCount) {
      await client.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    const found = await client.query<{ id: string; state: ComplianceState }>(
      `SELECT id::text AS id, state FROM app.compliance_cases
       WHERE project_id = $1 AND state IN ('WARNED', 'ESCALATED') FOR UPDATE`,
      [projectId]
    );
    const open = found.rows[0];
    if (open === undefined || !(rule.allowed as readonly string[]).includes(open.state)) {
      await client.query("ROLLBACK");
      return { outcome: "not_eligible" };
    }
    const updated = await client.query<CaseRow>(
      `UPDATE app.compliance_cases SET state = $2, state_changed_at = now(),
         resolved_at = CASE WHEN $2 = 'RESOLVED' THEN now() ELSE resolved_at END, resolution_note = $3
       WHERE id = $1::bigint RETURNING ${CASE_COLUMNS}`,
      [open.id, rule.next, note]
    );
    const escrow = projectId.split(":")[1] ?? "";
    await client.query(
      `INSERT INTO app.audit_log (actor_user_id, action, target, before_value, after_value, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [actorUserId, rule.action, escrow, open.state, rule.next, ip]
    );
    await client.query("COMMIT");
    const row = updated.rows[0];
    if (row === undefined) throw new Error("compliance case update returned no row");
    return { outcome: "ok", item: toItem(row) };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
