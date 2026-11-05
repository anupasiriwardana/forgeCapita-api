/**
 * Unit tests for the migration runner. No database is involved: the pool is a
 * hand-written fake that records every statement.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const {
  checksumOf,
  getStatus,
  listMigrations,
  runMigrations,
  verifyMigrationsApplied,
} = await import("../src/db/migrationRunner.js");

type Row = Record<string, unknown>;
type Handler = (sql: string) => { rows: Row[] } | Promise<{ rows: Row[] }> | undefined;

interface FakePool {
  connect: () => Promise<{ query: (sql: string) => Promise<{ rows: Row[] }>; release: () => void }>;
  log: string[];
  release: jest.Mock;
}

/** Fake pool: `applied` rows answer the schema_migrations SELECT; `handler` can override per statement. */
function makePool(applied: Row[] | "missing", handler?: Handler): FakePool {
  const log: string[] = [];
  const release = jest.fn();
  const client = {
    query: async (sql: string): Promise<{ rows: Row[] }> => {
      log.push(sql);
      const custom = handler?.(sql);
      if (custom !== undefined) return custom;
      if (sql.includes("FROM app.schema_migrations ORDER BY")) {
        if (applied === "missing") {
          throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
        }
        return { rows: applied };
      }
      return { rows: [] };
    },
    release,
  };
  return { connect: async () => client, log, release };
}

let dir: string;

function write(name: string, content: string): void {
  writeFileSync(join(dir, name), content);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "migrations-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("checksumOf", () => {
  it("is equal for CRLF and LF content", () => {
    expect(checksumOf("a\r\nb\r\n")).toBe(checksumOf("a\nb\n"));
  });

  it("differs for different content", () => {
    expect(checksumOf("a")).not.toBe(checksumOf("b"));
  });
});

describe("listMigrations", () => {
  it("returns files in order", () => {
    write("002_b.sql", "SELECT 2;");
    write("001_a.sql", "SELECT 1;");
    expect(listMigrations(dir).map((f) => f.name)).toEqual(["001_a.sql", "002_b.sql"]);
  });

  it("rejects a numbering gap", () => {
    write("001_a.sql", "SELECT 1;");
    write("003_c.sql", "SELECT 3;");
    expect(() => listMigrations(dir)).toThrow(/gap/);
  });

  it("rejects a sequence that does not start at 001", () => {
    write("002_b.sql", "SELECT 2;");
    expect(() => listMigrations(dir)).toThrow(/gap/);
  });

  it("rejects a duplicate version", () => {
    write("001_a.sql", "SELECT 1;");
    write("001_b.sql", "SELECT 1;");
    expect(() => listMigrations(dir)).toThrow(/Duplicate/);
  });

  it("rejects an invalid file name", () => {
    write("001_Bad-Name.sql", "SELECT 1;");
    expect(() => listMigrations(dir)).toThrow(/Invalid migration file name/);
  });
});

describe("runMigrations", () => {
  it("applies pending files in order, each in BEGIN/COMMIT with the lock first", async () => {
    write("001_a.sql", "SELECT 1;");
    write("002_b.sql", "SELECT 2;");
    const pool = makePool([]);

    const applied = await runMigrations(pool, dir);

    expect(applied).toEqual(["001_a.sql", "002_b.sql"]);
    const firstSql = pool.log.indexOf("SELECT 1;");
    const secondSql = pool.log.indexOf("SELECT 2;");
    expect(firstSql).toBeGreaterThan(-1);
    expect(secondSql).toBeGreaterThan(firstSql);

    for (const sqlIndex of [firstSql, secondSql]) {
      const before = pool.log.slice(0, sqlIndex);
      const beginAt = before.lastIndexOf("BEGIN");
      const lockAt = before.findIndex((s, i) => i > beginAt && s.includes("pg_advisory_xact_lock"));
      expect(beginAt).toBeGreaterThan(-1);
      expect(lockAt).toBeGreaterThan(beginAt);
      expect(pool.log[sqlIndex + 1]).toContain("INSERT INTO app.schema_migrations");
      expect(pool.log[sqlIndex + 2]).toBe("COMMIT");
    }
    expect(pool.release).toHaveBeenCalledTimes(1);
  });

  it("skips already applied files", async () => {
    write("001_a.sql", "SELECT 1;");
    write("002_b.sql", "SELECT 2;");
    const pool = makePool([
      { version: 1, name: "001_a.sql", checksum: checksumOf("SELECT 1;") },
    ]);

    const applied = await runMigrations(pool, dir);

    expect(applied).toEqual(["002_b.sql"]);
    expect(pool.log).not.toContain("SELECT 1;");
    expect(pool.log).toContain("SELECT 2;");
  });

  it("fails on checksum mismatch before running any SQL", async () => {
    write("001_a.sql", "SELECT 1;");
    write("002_b.sql", "SELECT 2;");
    const pool = makePool([{ version: 1, name: "001_a.sql", checksum: "deadbeef" }]);

    await expect(runMigrations(pool, dir)).rejects.toThrow(/Checksum mismatch.*001_a\.sql/);
    expect(pool.log).not.toContain("SELECT 2;");
    expect(pool.release).toHaveBeenCalledTimes(1);
  });

  it("fails when an applied version has no file", async () => {
    write("001_a.sql", "SELECT 1;");
    const pool = makePool([
      { version: 1, name: "001_a.sql", checksum: checksumOf("SELECT 1;") },
      { version: 2, name: "002_gone.sql", checksum: "x" },
    ]);

    await expect(runMigrations(pool, dir)).rejects.toThrow(/no file.*002_gone\.sql/);
  });

  it("rolls back and names only the file when the SQL fails", async () => {
    write("001_a.sql", "BOOM;");
    write("002_b.sql", "SELECT 2;");
    const pool = makePool([], (sql) => {
      if (sql === "BOOM;") {
        throw Object.assign(new Error("secret host details"), {
          code: "23514",
          constraint: "startup_profiles_name_length",
        });
      }
      return undefined;
    });

    const failure = runMigrations(pool, dir);
    await expect(failure).rejects.toThrow(
      "Migration 001_a.sql failed (SQLSTATE 23514, constraint startup_profiles_name_length)"
    );
    await expect(failure).rejects.not.toThrow(/secret/);
    expect(pool.log).toContain("ROLLBACK");
    expect(pool.log).not.toContain("SELECT 2;");
    expect(pool.log.some((s) => s.includes("INSERT INTO app.schema_migrations"))).toBe(false);
    expect(pool.release).toHaveBeenCalledTimes(1);
  });

  it("skips a version applied concurrently, detected under the lock", async () => {
    write("001_a.sql", "SELECT 1;");
    const pool = makePool([], (sql) => {
      if (sql.includes("WHERE version = 1")) return { rows: [{ "?column?": 1 }] };
      return undefined;
    });

    const applied = await runMigrations(pool, dir);

    expect(applied).toEqual([]);
    expect(pool.log).not.toContain("SELECT 1;");
    expect(pool.log.some((s) => s.includes("INSERT INTO app.schema_migrations"))).toBe(false);
    expect(pool.log).toContain("COMMIT");
  });

  it("bootstraps the schema and the tracking table", async () => {
    write("001_a.sql", "SELECT 1;");
    const pool = makePool("missing");

    await runMigrations(pool, dir);

    expect(pool.log).toContain("CREATE SCHEMA IF NOT EXISTS app");
    expect(pool.log.some((s) => s.includes("CREATE TABLE IF NOT EXISTS app.schema_migrations"))).toBe(
      true
    );
  });

  it("never sets search_path", async () => {
    write("001_a.sql", "SELECT 1;");
    const pool = makePool([]);
    await runMigrations(pool, dir);
    expect(pool.log.some((s) => /search_path/i.test(s))).toBe(false);
  });
});

describe("getStatus and verifyMigrationsApplied", () => {
  it("passes when everything is applied", async () => {
    write("001_a.sql", "SELECT 1;");
    const pool = makePool([{ version: 1, name: "001_a.sql", checksum: checksumOf("SELECT 1;") }]);

    expect(await getStatus(pool, dir)).toEqual({
      applied: ["001_a.sql"],
      pending: [],
      mismatched: [],
      unknownApplied: [],
    });
    await expect(verifyMigrationsApplied(pool, dir)).resolves.toBeUndefined();
    expect(pool.log.every((s) => s.startsWith("SELECT"))).toBe(true);
  });

  it("throws when the tracking table is missing (42P01) and issues no writes", async () => {
    write("001_a.sql", "SELECT 1;");
    const pool = makePool("missing");

    await expect(verifyMigrationsApplied(pool, dir)).rejects.toThrow(/Pending migrations/);
    expect(pool.log.every((s) => s.startsWith("SELECT"))).toBe(true);
  });

  it("throws when a file is pending", async () => {
    write("001_a.sql", "SELECT 1;");
    write("002_b.sql", "SELECT 2;");
    const pool = makePool([{ version: 1, name: "001_a.sql", checksum: checksumOf("SELECT 1;") }]);

    await expect(verifyMigrationsApplied(pool, dir)).rejects.toThrow(/002_b\.sql/);
  });

  it("propagates unexpected database errors", async () => {
    write("001_a.sql", "SELECT 1;");
    const pool = makePool([], () => {
      throw Object.assign(new Error("connection lost"), { code: "08006" });
    });
    await expect(getStatus(pool, dir)).rejects.toThrow("connection lost");
  });
});

describe("repository migration files", () => {
  const realDir = resolve(process.cwd(), "migrations");
  const files = readdirSync(realDir).filter((f) => f.endsWith(".sql"));

  it("are valid for the runner", () => {
    expect(listMigrations(realDir).map((f) => f.name)).toEqual(files.sort());
  });

  it.each(files)("%s has no transaction control, CONCURRENTLY or search_path", (file) => {
    const sql = readFileSync(join(realDir, file), "utf8");
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    expect(sql).not.toMatch(/CONCURRENTLY/i);
    expect(sql).not.toMatch(/search_path/i);
  });

  it.each(files)("%s schema-qualifies every CREATE TABLE and ALTER TABLE", (file) => {
    const sql = readFileSync(join(realDir, file), "utf8");
    const targets = [...sql.matchAll(/\b(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE(?: IF EXISTS)?)\s+(\S+)/gi)];
    for (const match of targets) {
      expect(match[1]).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  it("never references an unqualified startup_profiles", () => {
    for (const file of files) {
      const sql = readFileSync(join(realDir, file), "utf8");
      expect(sql).not.toMatch(/(?<![.'])\bstartup_profiles\b/);
    }
  });
});
