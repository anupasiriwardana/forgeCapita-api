import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Minimal forward-only SQL migration runner.
 *
 * Pooler-safe: it never uses session-level state. Each pending file runs in its
 * own transaction guarded by a transaction-level advisory lock, so it also works
 * through a transaction-mode pooler such as Neon's pooled endpoint.
 */

const MIGRATION_FILE_PATTERN = /^(\d{3})_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK_KEY = "727361001";
const UNDEFINED_TABLE = "42P01";

export interface QueryResult {
  rows: Record<string, unknown>[];
}

export interface MigrationClient {
  query(sql: string): Promise<QueryResult>;
  release(): void;
}

export interface MigrationPool {
  connect(): Promise<MigrationClient>;
}

export interface MigrationFile {
  version: number;
  name: string;
  checksum: string;
  sql: string;
}

export interface MigrationStatus {
  applied: string[];
  pending: string[];
  mismatched: string[];
  unknownApplied: string[];
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/** sha256 of the text with CRLF normalised to LF, so Windows checkouts match. */
export function checksumOf(content: string): string {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/** Reads and validates the migration files: naming, contiguity, no duplicates. */
export function listMigrations(dir: string): MigrationFile[] {
  const names = readdirSync(dir)
    .filter((entry) => entry.endsWith(".sql"))
    .sort();

  const files: MigrationFile[] = [];
  const seen = new Set<number>();
  for (const name of names) {
    const match = MIGRATION_FILE_PATTERN.exec(name);
    if (!match || match[1] === undefined) {
      throw new MigrationError(`Invalid migration file name: ${name}`);
    }
    const version = Number(match[1]);
    if (seen.has(version)) {
      throw new MigrationError(`Duplicate migration version: ${match[1]}`);
    }
    seen.add(version);
    const sql = readFileSync(join(dir, name), "utf8");
    files.push({ version, name, checksum: checksumOf(sql), sql });
  }

  files.forEach((file, index) => {
    if (file.version !== index + 1) {
      throw new MigrationError(`Migration numbering gap before: ${file.name}`);
    }
  });
  return files;
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
}

function toAppliedRows(rows: Record<string, unknown>[]): AppliedRow[] {
  return rows.map((row) => ({
    version: Number(row["version"]),
    name: String(row["name"]),
    checksum: String(row["checksum"]),
  }));
}

function stringField(err: unknown, field: string): string | undefined {
  if (typeof err === "object" && err !== null && field in err) {
    const value = (err as Record<string, unknown>)[field];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

async function readApplied(client: MigrationClient): Promise<AppliedRow[]> {
  try {
    const result = await client.query(
      "SELECT version, name, checksum FROM app.schema_migrations ORDER BY version"
    );
    return toAppliedRows(result.rows);
  } catch (err) {
    if (stringField(err, "code") === UNDEFINED_TABLE) return [];
    throw err;
  }
}

function computeStatus(files: MigrationFile[], applied: AppliedRow[]): MigrationStatus {
  const appliedByVersion = new Map(applied.map((row) => [row.version, row]));
  const fileVersions = new Set(files.map((file) => file.version));

  const status: MigrationStatus = { applied: [], pending: [], mismatched: [], unknownApplied: [] };
  for (const file of files) {
    const row = appliedByVersion.get(file.version);
    if (!row) {
      status.pending.push(file.name);
    } else if (row.checksum !== file.checksum) {
      status.mismatched.push(file.name);
    } else {
      status.applied.push(file.name);
    }
  }
  for (const row of applied) {
    if (!fileVersions.has(row.version)) status.unknownApplied.push(row.name);
  }
  return status;
}

/** Read-only report of applied, pending and drifted migrations. */
export async function getStatus(pool: MigrationPool, dir: string): Promise<MigrationStatus> {
  const files = listMigrations(dir);
  const client = await pool.connect();
  try {
    return computeStatus(files, await readApplied(client));
  } finally {
    client.release();
  }
}

/** Throws when any migration file has not been applied. Never alters the schema. */
export async function verifyMigrationsApplied(pool: MigrationPool, dir: string): Promise<void> {
  const status = await getStatus(pool, dir);
  if (status.pending.length > 0) {
    throw new MigrationError(`Pending migrations: ${status.pending.join(", ")}`);
  }
}

async function rollbackQuietly(client: MigrationClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original failure is what matters; the connection is released either way.
  }
}

async function bootstrap(client: MigrationClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
    await client.query("CREATE SCHEMA IF NOT EXISTS app");
    await client.query(
      `CREATE TABLE IF NOT EXISTS app.schema_migrations (
         version     integer      PRIMARY KEY,
         name        varchar(255) NOT NULL,
         checksum    char(64)     NOT NULL,
         applied_at  timestamptz  NOT NULL DEFAULT now()
       )`
    );
    await client.query("COMMIT");
  } catch (err) {
    await rollbackQuietly(client);
    throw err;
  }
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Applies one file under the advisory lock. Returns false if another instance won the race. */
async function applyOne(client: MigrationClient, file: MigrationFile): Promise<boolean> {
  await client.query("BEGIN");
  try {
    await client.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
    const already = await client.query(
      `SELECT 1 FROM app.schema_migrations WHERE version = ${file.version}`
    );
    if (already.rows.length > 0) {
      await client.query("COMMIT");
      return false;
    }
    await client.query(file.sql);
    await client.query(
      `INSERT INTO app.schema_migrations (version, name, checksum, applied_at)
       VALUES (${file.version}, ${literal(file.name)}, ${literal(file.checksum)}, now())`
    );
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await rollbackQuietly(client);
    const code = stringField(err, "code");
    const constraint = stringField(err, "constraint");
    const detail = [code ? `SQLSTATE ${code}` : null, constraint ? `constraint ${constraint}` : null]
      .filter((part): part is string => part !== null)
      .join(", ");
    throw new MigrationError(`Migration ${file.name} failed${detail ? ` (${detail})` : ""}`);
  }
}

/** Applies pending migrations in order. Returns the names of the files it applied. */
export async function runMigrations(pool: MigrationPool, dir: string): Promise<string[]> {
  const files = listMigrations(dir);
  const client = await pool.connect();
  try {
    await bootstrap(client);
    const status = computeStatus(files, await readApplied(client));

    if (status.unknownApplied.length > 0) {
      throw new MigrationError(
        `Applied migrations have no file: ${status.unknownApplied.join(", ")}`
      );
    }
    if (status.mismatched.length > 0) {
      throw new MigrationError(
        `Checksum mismatch for applied migration: ${status.mismatched.join(", ")}`
      );
    }

    const appliedNow: string[] = [];
    const pending = new Set(status.pending);
    for (const file of files) {
      if (!pending.has(file.name)) continue;
      if (await applyOne(client, file)) appliedNow.push(file.name);
    }
    return appliedNow;
  } finally {
    client.release();
  }
}
