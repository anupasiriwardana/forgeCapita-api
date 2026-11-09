import { resolve } from "node:path";
import { pool } from "../../src/db/pool.js";
import { getStatus, runMigrations } from "../../src/db/migrationRunner.js";
import { assertSafeTestDatabaseUrl } from "./guard.js";

export { pool };

export const MIGRATIONS_DIR = resolve(process.cwd(), "migrations");

/**
 * Minimal copies of the Ponder tables the API reads (names and types as the generated Ponder
 * schema creates them: snake_case, bigint = numeric(78), hex = text). Mirror of
 * forgecapita-indexer/ponder.schema.ts `project` and `milestone`.
 */
const PONDER_STUBS = `
  CREATE TABLE ponder.project (
    id                      text PRIMARY KEY,
    chain_id                integer NOT NULL,
    escrow_address          text NOT NULL,
    token_address           text NOT NULL,
    distributor_address     text NOT NULL,
    developer               text NOT NULL,
    funding_goal            numeric(78) NOT NULL,
    total_raised            numeric(78) NOT NULL,
    is_funding_active       boolean NOT NULL,
    state                   text NOT NULL,
    funding_deadline        numeric(78) NOT NULL,
    close_grace             numeric(78) NOT NULL,
    refund_window           numeric(78) NOT NULL,
    voting_period           numeric(78) NOT NULL,
    funding_closed_at       numeric(78),
    platform_fee            numeric(78),
    cancelled_at            numeric(78),
    failed_milestone_index  integer,
    is_invalidated          boolean NOT NULL DEFAULT false,
    shutdown_at             numeric(78),
    current_milestone_index integer NOT NULL DEFAULT 0,
    total_staked            numeric(78) NOT NULL DEFAULT 0,
    token_name              text NOT NULL,
    token_symbol            text NOT NULL,
    created_at              numeric(78) NOT NULL
  );
  CREATE TABLE ponder.milestone (
    id                   text PRIMARY KEY,
    chain_id             integer NOT NULL,
    project_id           text NOT NULL,
    milestone_index      integer NOT NULL,
    is_voting_open       boolean NOT NULL,
    is_executed          boolean NOT NULL,
    yes_votes            numeric(78) NOT NULL,
    no_votes             numeric(78) NOT NULL,
    unlock_percentage    integer NOT NULL,
    description          text NOT NULL,
    voting_start_time    numeric(78) NOT NULL,
    frozen_at_vote_start numeric(78) NOT NULL,
    voting_end_time      numeric(78) NOT NULL,
    executed_at          numeric(78),
    amount_released      numeric(78),
    tokens_vested        numeric(78),
    gas_debt_recouped    numeric(78),
    is_failed            boolean NOT NULL DEFAULT false,
    failed_at            numeric(78)
  );`;

/**
 * Drops and recreates the `app` and `ponder` schemas, applies every migration (twice: the second
 * run must be a no-op) and creates the Ponder stubs. Call once per test file in beforeAll.
 */
export async function bootstrapDatabase(): Promise<{ first: string[]; second: string[] }> {
  assertSafeTestDatabaseUrl(process.env["DATABASE_URL"]?.replace(/\?.*$/, ""));
  await pool.query("DROP SCHEMA IF EXISTS app CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS ponder CASCADE");
  await pool.query("CREATE SCHEMA ponder");
  const first = await runMigrations(pool, MIGRATIONS_DIR);
  const second = await runMigrations(pool, MIGRATIONS_DIR);
  await pool.query(PONDER_STUBS);
  return { first, second };
}

export function migrationStatus(): ReturnType<typeof getStatus> {
  return getStatus(pool, MIGRATIONS_DIR);
}

/**
 * Empties every table between tests. app.audit_log rejects TRUNCATE by design, so its USER
 * triggers are disabled for the duration of this one transaction (the test user owns the
 * table; ALTER ... DISABLE TRIGGER is transactional, so a failure restores them). The
 * append-only behaviour itself is tested in audit.itest.ts with the triggers enabled.
 */
export async function resetData(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE app.audit_log DISABLE TRIGGER USER");
    await client.query(
      `TRUNCATE app.audit_log, app.inflow_records, app.inflow_cursors, app.relay_requests, app.launch_drafts, app.startup_profiles,
         app.founder_wallets, app.agreement_acceptances, app.founder_applications,
         app.sessions, app.auth_nonces, app.users, ponder.project, ponder.milestone`
    );
    await client.query("ALTER TABLE app.audit_log ENABLE TRIGGER USER");
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

// --- fixtures ----------------------------------------------------------------

/** Deterministic lowercase address for index n. */
export function addr(n: number): string {
  return "0x" + n.toString(16).padStart(40, "0");
}

export type TestRole = "investor" | "founder" | "staff" | "admin";

export interface TestUser {
  id: string;
  address: string;
  role: TestRole;
}

export async function createUser(n: number, role: TestRole = "investor"): Promise<TestUser> {
  const address = addr(n);
  const result = await pool.query<{ id: string }>(
    "INSERT INTO app.users (wallet_address, role) VALUES ($1, $2) RETURNING id",
    [address, role]
  );
  const row = result.rows[0];
  if (!row) throw new Error("user insert returned no row");
  return { id: row.id, address, role };
}

export async function createSession(userId: string, hash: string): Promise<void> {
  await pool.query(
    "INSERT INTO app.sessions (id_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')",
    [hash, userId]
  );
}

export async function createApprovedWallet(userId: string, address: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO app.founder_wallets (user_id, address, status) VALUES ($1, $2, 'approved') RETURNING id",
    [userId, address]
  );
  const row = result.rows[0];
  if (!row) throw new Error("wallet insert returned no row");
  return row.id;
}

export interface StubProject {
  chainId: number;
  escrow: string;
  developer?: string;
  state?: string;
  isInvalidated?: boolean;
  cancelledAt?: string | null;
  currentMilestoneIndex?: number;
  tokenName?: string;
}

/** Inserts a ponder.project row; returns its id (`<chainId>:<escrow>`). */
export async function insertPonderProject(p: StubProject): Promise<string> {
  const id = `${p.chainId}:${p.escrow}`;
  await pool.query(
    `INSERT INTO ponder.project
       (id, chain_id, escrow_address, token_address, distributor_address, developer, funding_goal,
        total_raised, is_funding_active, state, funding_deadline, close_grace, refund_window,
        voting_period, cancelled_at, is_invalidated, current_milestone_index, token_name,
        token_symbol, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 1000, 0, false, $7, 0, 0, 0, 100, $8, $9, $10, $11, 'TKN', 1)`,
    [
      id,
      p.chainId,
      p.escrow,
      addr(901),
      addr(902),
      p.developer ?? addr(903),
      p.state ?? "ACTIVE",
      p.cancelledAt ?? null,
      p.isInvalidated ?? false,
      p.currentMilestoneIndex ?? 0,
      p.tokenName ?? "Token",
    ]
  );
  return id;
}

export interface StubMilestone {
  projectId: string;
  chainId: number;
  index: number;
  votingEndTime: number;
  isVotingOpen?: boolean;
  isExecuted?: boolean;
  isFailed?: boolean;
}

export async function insertPonderMilestone(m: StubMilestone): Promise<void> {
  await pool.query(
    `INSERT INTO ponder.milestone
       (id, chain_id, project_id, milestone_index, is_voting_open, is_executed, yes_votes, no_votes,
        unlock_percentage, description, voting_start_time, frozen_at_vote_start, voting_end_time, is_failed)
     VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 25, 'm', 0, 0, $7, $8)`,
    [
      `${m.projectId}:${m.index}`,
      m.chainId,
      m.projectId,
      m.index,
      m.isVotingOpen ?? true,
      m.isExecuted ?? false,
      m.votingEndTime,
      m.isFailed ?? false,
    ]
  );
}

export interface AuditRow {
  action: string;
  target: string;
  before_value: string | null;
  after_value: string | null;
  actor_user_id: string | null;
}

export async function auditRows(): Promise<AuditRow[]> {
  const result = await pool.query<AuditRow>(
    "SELECT action, target, before_value, after_value, actor_user_id FROM app.audit_log ORDER BY id"
  );
  return result.rows;
}

/** pg error code and constraint of a rejected promise, for unique/check violation assertions. */
export async function pgErrorOf(
  promise: Promise<unknown>
): Promise<{ code?: string; constraint?: string; message: string }> {
  try {
    await promise;
  } catch (err) {
    const e = err as { code?: string; constraint?: string; message?: string };
    return {
      ...(e.code !== undefined && { code: e.code }),
      ...(e.constraint !== undefined && { constraint: e.constraint }),
      message: e.message ?? "",
    };
  }
  throw new Error("expected the statement to be rejected, but it succeeded");
}
