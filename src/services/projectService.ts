import { pool } from "../db/pool.js";
import type {
  CreateProfileBody,
  StartupProfileRow,
  UnifiedProjectRow,
} from "../types/index.js";

// ─── Upsert a startup profile ────────────────────────────────────────────────

export async function upsertProfile(
  body: CreateProfileBody
): Promise<StartupProfileRow> {
  const { projectId, name, description, logoUrl, pitchDeckUrl, founderBio, websiteUrl } =
    body;

  const sql = `
    INSERT INTO startup_profiles
      (project_id, name, description, logo_url, pitch_deck_url, founder_bio, website_url)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (project_id) DO UPDATE SET
      name           = EXCLUDED.name,
      description    = EXCLUDED.description,
      logo_url       = EXCLUDED.logo_url,
      pitch_deck_url = EXCLUDED.pitch_deck_url,
      founder_bio    = EXCLUDED.founder_bio,
      website_url    = EXCLUDED.website_url
    RETURNING *;
  `;

  const result = await pool.query<StartupProfileRow>(sql, [
    projectId,
    name,
    description,
    logoUrl ?? null,
    pitchDeckUrl ?? null,
    founderBio ?? null,
    websiteUrl ?? null,
  ]);

  // result.rows[0] is guaranteed because RETURNING * always returns the upserted row
  return result.rows[0]!;
}

// ─── Fetch a single unified project (on-chain JOIN off-chain) ────────────────

export async function getProjectById(
  projectId: string
): Promise<UnifiedProjectRow | null> {
  const sql = `
    SELECT
      p.*,
      s.name,
      s.description,
      s.logo_url,
      s.pitch_deck_url,
      s.founder_bio,
      s.website_url
    FROM project p
    LEFT JOIN startup_profiles s ON p.id = s.project_id
    WHERE p.id = $1;
  `;

  const result = await pool.query<UnifiedProjectRow>(sql, [projectId]);
  return result.rows[0] ?? null;
}

// ─── Fetch all unified projects ───────────────────────────────────────────────

export async function getAllProjects(): Promise<UnifiedProjectRow[]> {
  const sql = `
    SELECT
      p.*,
      s.name,
      s.description,
      s.logo_url,
      s.pitch_deck_url,
      s.founder_bio,
      s.website_url
    FROM project p
    LEFT JOIN startup_profiles s ON p.id = s.project_id
    ORDER BY p.created_at DESC;
  `;

  const result = await pool.query<UnifiedProjectRow>(sql);
  return result.rows;
}
