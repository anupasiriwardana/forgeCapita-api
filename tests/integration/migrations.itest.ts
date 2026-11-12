import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { listMigrations } from "../../src/db/migrationRunner.js";
import { MIGRATIONS_DIR, bootstrapDatabase, closePool, migrationStatus, pool } from "./db.js";

let first: string[] = [];
let second: string[] = [];

beforeAll(async () => {
  ({ first, second } = await bootstrapDatabase());
});
afterAll(closePool);

describe("migrations on an empty database", () => {
  it("applies every migration file in order and the second run is a no-op", async () => {
    const files = listMigrations(MIGRATIONS_DIR).map((f) => f.name);
    expect(files.length).toBeGreaterThanOrEqual(11);
    expect(first).toEqual(files);
    expect(second).toEqual([]);
    const status = await migrationStatus();
    expect(status.pending).toEqual([]);
    expect(status.mismatched).toEqual([]);
    expect(status.unknownApplied).toEqual([]);
  });

  it("creates the expected tables, triggers and partial indexes", async () => {
    const tables = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'app' ORDER BY table_name"
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      "agreement_acceptances",
      "audit_log",
      "auth_nonces",
      "complaints",
      "compliance_cases",
      "founder_applications",
      "founder_wallets",
      "gas_samples",
      "inflow_cursors",
      "inflow_records",
      "launch_drafts",
      "relay_requests",
      "schema_migrations",
      "sessions",
      "startup_profiles",
      "user_profiles",
      "users",
    ]);
    const triggers = await pool.query<{ tgname: string }>(
      "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'app.audit_log'::regclass ORDER BY tgname"
    );
    expect(triggers.rows.map((r) => r.tgname)).toEqual(["audit_log_no_truncate", "audit_log_no_update_delete"]);
    const indexes = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'app'"
    );
    const names = indexes.rows.map((r) => r.indexname);
    for (const expected of [
      "launch_drafts_active_wallet_uidx",
      "founder_wallets_pending_user_idx",
      "founder_wallets_approved_address_idx",
      "relay_requests_idem_key_uidx",
      "founder_applications_open_wallet_idx",
      "compliance_cases_open_project_uidx",
      "complaints_active_uidx",
    ]) {
      expect(names).toContain(expected);
    }
    const dropped = await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = 'founder_wallets_open_user_idx'");
    expect(dropped.rowCount).toBe(0);
  });

  it("each migration file can be re-executed on the migrated schema (idempotent SQL)", async () => {
    for (const file of listMigrations(MIGRATIONS_DIR)) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file.name), "utf8");
      await expect(pool.query(sql)).resolves.toBeDefined();
    }
  });
});
