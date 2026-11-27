import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { listMigrations } from "../../src/db/migrationRunner.js";
import { MIGRATIONS_DIR, bootstrapDatabase, closePool, createUser, migrationStatus, pool } from "./db.js";

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
      "project_repos",
      "relay_requests",
      "schema_migrations",
      "sessions",
      "startup_profiles",
      "takeover_cases",
      "takeover_snapshot_holders",
      "takeover_votes",
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
      "project_repos_unlinked_user_uidx",
    ]) {
      expect(names).toContain(expected);
    }
    const dropped = await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = 'founder_wallets_open_user_idx'");
    expect(dropped.rowCount).toBe(0);
  });

  it("migration 024 CHECKs reject bad founder application profile values", async () => {
    const user = await createUser(1);
    const about = "x".repeat(60);
    const base = { resume: "https://drive.google.com/r", about, linkedin: "https://www.linkedin.com/in/jane", github: null as string | null };
    const attempt = async (over: Partial<typeof base>): Promise<unknown> => {
      const v = { ...base, ...over };
      try {
        await pool.query(
          `INSERT INTO app.founder_applications (user_id, wallet_address, resume_url, about, linkedin_url, github_url)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [user.id, user.address, v.resume, v.about, v.linkedin, v.github]
        );
        await pool.query("DELETE FROM app.founder_applications");
        return null;
      } catch (err) {
        return (err as { constraint?: string }).constraint;
      }
    };
    expect(await attempt({})).toBeNull();
    expect(await attempt({ github: "https://github.com/jane/repo", linkedin: null as unknown as string })).toBe(
      "founder_applications_github_url_format"
    );
    expect(await attempt({ about: null as unknown as string })).toBe("founder_applications_new_format_consistent");
    expect(await attempt({ linkedin: null as unknown as string })).toBe("founder_applications_one_link_required");
    expect(await attempt({ about: "short" })).toBe("founder_applications_about_length");
  });

  it("migration 025 adds auto_approved (NOT NULL, default false) to applications and shadow wallets", async () => {
    const columns = await pool.query<{ table_name: string; is_nullable: string; column_default: string | null; data_type: string }>(
      `SELECT table_name, is_nullable, column_default, data_type FROM information_schema.columns
       WHERE table_schema = 'app' AND column_name = 'auto_approved' ORDER BY table_name`
    );
    expect(columns.rows).toEqual([
      { table_name: "founder_applications", is_nullable: "NO", column_default: "false", data_type: "boolean" },
      { table_name: "founder_wallets", is_nullable: "NO", column_default: "false", data_type: "boolean" },
    ]);
    const user = await createUser(2);
    const wallet = await pool.query<{ auto_approved: boolean }>(
      "INSERT INTO app.founder_wallets (user_id, address) VALUES ($1, $2) RETURNING auto_approved",
      [user.id, "0x" + "ab".repeat(20)]
    );
    expect(wallet.rows[0]?.auto_approved).toBe(false);
    await pool.query("DELETE FROM app.founder_wallets");
    const sql = readFileSync(join(MIGRATIONS_DIR, "025_founder_auto_approval.sql"), "utf8");
    await expect(pool.query(sql)).resolves.toBeDefined();
  });

  it("each migration file can be re-executed on the migrated schema (idempotent SQL)", async () => {
    for (const file of listMigrations(MIGRATIONS_DIR)) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file.name), "utf8");
      await expect(pool.query(sql)).resolves.toBeDefined();
    }
  });
});
