import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

/**
 * Shared PostgreSQL connection pool.
 * Re-exported so every service layer uses the same pool instance.
 */
export const pool = new Pool({
  connectionString: process.env["DATABASE_URL"],
  ssl: {
    rejectUnauthorized: false,
  },
});

/**
 * Runs once at server startup.
 * Creates the `startup_profiles` table if it does not already exist.
 */
export async function initDb(): Promise<void> {
  const sql = `
    CREATE TABLE IF NOT EXISTS startup_profiles (
      project_id      VARCHAR      PRIMARY KEY,
      name            VARCHAR      NOT NULL,
      description     TEXT         NOT NULL,
      logo_url        VARCHAR,
      pitch_deck_url  VARCHAR,
      founder_bio     TEXT,
      website_url     VARCHAR,
      shadow_wallet   VARCHAR,
      kyc_verified    BOOLEAN      DEFAULT false,
      created_at      TIMESTAMP    NOT NULL DEFAULT NOW()
    );
  `;

  await pool.query(sql);
  console.log("✅ DB schema verified — startup_profiles table is ready.");
}
