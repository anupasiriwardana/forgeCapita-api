import { Pool } from "pg";
import { config } from "../config/env.js";

/**
 * Shared PostgreSQL connection pool.
 * Re-exported so every service layer uses the same pool instance.
 */
export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

/**
 * Quoted, schema-qualified name of a Ponder-managed table, e.g. "ponder"."project".
 * The schema comes from PONDER_SCHEMA, which env validation restricts to
 * ^[a-z_][a-z0-9_]{0,62}$, so interpolating it is safe. `table` must be a constant.
 */
export function qualified(table: string): string {
  return `"${config.PONDER_SCHEMA}"."${table}"`;
}
