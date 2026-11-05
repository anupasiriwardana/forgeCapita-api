import dotenv from "dotenv";
import { resolve } from "node:path";
import { Pool } from "pg";
import { MigrationError, getStatus, runMigrations } from "./migrationRunner.js";

dotenv.config({ quiet: true });

const URL_PATTERN = /^postgres(ql)?:\/\//;
const MIGRATIONS_DIR = resolve(process.cwd(), "migrations");

function resolveConnectionString(): string {
  const raw = process.env["MIGRATION_DATABASE_URL"] || process.env["DATABASE_URL"];
  if (!raw || !URL_PATTERN.test(raw)) {
    throw new MigrationError(
      "MIGRATION_DATABASE_URL or DATABASE_URL must be set to a postgres:// or postgresql:// URL"
    );
  }
  return raw;
}

async function main(command: string | undefined): Promise<void> {
  if (command !== "up" && command !== "status") {
    throw new MigrationError("Usage: migrate.ts <up|status>");
  }
  const pool = new Pool({
    connectionString: resolveConnectionString(),
    ssl: { rejectUnauthorized: false },
  });
  try {
    if (command === "up") {
      const applied = await runMigrations(pool, MIGRATIONS_DIR);
      for (const name of applied) console.log(`applied ${name}`);
      console.log(`Migrations complete: ${applied.length} applied`);
      return;
    }
    const status = await getStatus(pool, MIGRATIONS_DIR);
    for (const name of status.applied) console.log(`applied  ${name}`);
    for (const name of status.pending) console.log(`pending  ${name}`);
    for (const name of status.mismatched) console.log(`CHECKSUM MISMATCH  ${name}`);
    for (const name of status.unknownApplied) console.log(`NO FILE  ${name}`);
    console.log(
      `${status.applied.length} applied, ${status.pending.length} pending, ` +
        `${status.mismatched.length} mismatched, ${status.unknownApplied.length} without file`
    );
    if (status.mismatched.length > 0 || status.unknownApplied.length > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main(process.argv[2]).catch((err: unknown) => {
  // Only our own messages are printed; driver errors may carry connection details.
  const message = err instanceof MigrationError ? err.message : "Could not complete the database operation";
  console.error(`Migration failed: ${message}`);
  process.exitCode = 1;
});
