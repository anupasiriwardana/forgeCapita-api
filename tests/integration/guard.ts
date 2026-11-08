/**
 * Safety guard for the integration suite. The suite DROPs schemas and TRUNCATEs tables, so it
 * must never run against anything but the throwaway test database.
 */

const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["pg_test", "localhost", "127.0.0.1"]);
const REQUIRED_DATABASE = "forgecapita_test";

export const DEFAULT_TEST_DATABASE_URL = "postgresql://test:test@pg_test:5432/forgecapita_test";

/** Throws unless the URL points at an allowed test host AND the forgecapita_test database. Returns the host. */
export function assertSafeTestDatabaseUrl(raw: string | undefined): string {
  if (!raw) throw new Error("Integration tests: no database URL given");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Integration tests: database URL is not parseable; aborting");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("Integration tests: database URL must be postgres:// or postgresql://; aborting");
  }
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error(
      `Integration tests refuse to run: host "${url.hostname}" is not one of ${[...ALLOWED_HOSTS].join(", ")}`
    );
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (database !== REQUIRED_DATABASE) {
    throw new Error(`Integration tests refuse to run: database must be "${REQUIRED_DATABASE}"`);
  }
  return url.hostname;
}

/** Local test Postgres has no TLS, while src/db/pool.ts always requests it; sslmode=disable in the URL wins. */
export function withSslDisabled(raw: string): string {
  const url = new URL(raw);
  if (!url.searchParams.has("sslmode")) url.searchParams.set("sslmode", "disable");
  return url.toString();
}
