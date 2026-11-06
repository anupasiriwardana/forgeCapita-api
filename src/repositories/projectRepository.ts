import { pool, qualified } from "../db/pool.js";
import type { CreateProfileBody, ProfileRow, ProjectRow } from "../types/index.js";

export interface ProjectFilters {
  chainId?: number | undefined;
  state?: string | undefined;
  developer?: string | undefined;
  q?: string | undefined;
  category?: string | undefined;
  hasProfile?: boolean | undefined;
}

export type ProjectSort = "created_at" | "total_raised" | "funding_goal";
export type SortOrder = "asc" | "desc";

/** ORDER BY targets come only from these constants, never from user input. */
const SORT_COLUMNS: Readonly<Record<ProjectSort, string>> = {
  created_at: 'p."created_at"',
  total_raised: 'p."total_raised"',
  funding_goal: 'p."funding_goal"',
};

const SORT_DIRECTIONS: Readonly<Record<SortOrder, string>> = {
  asc: "ASC",
  desc: "DESC",
};

const PROJECT_SELECT = `
  SELECT
    p."id", p."chain_id", p."escrow_address", p."token_address", p."distributor_address",
    p."developer", p."funding_goal", p."total_raised", p."funding_deadline", p."close_grace",
    p."refund_window", p."voting_period", p."funding_closed_at", p."platform_fee",
    p."cancelled_at", p."shutdown_at", p."total_staked", p."created_at",
    p."is_funding_active", p."state", p."failed_milestone_index", p."is_invalidated",
    p."current_milestone_index", p."token_name", p."token_symbol",
    s.project_id AS profile_project_id,
    s.name AS profile_name,
    s.description AS profile_description,
    s.logo_url AS profile_logo_url,
    s.pitch_deck_url AS profile_pitch_deck_url,
    s.founder_bio AS profile_founder_bio,
    s.website_url AS profile_website_url,
    s.category AS profile_category,
    s.updated_at AS profile_updated_at`;

const PROJECT_FROM = `
  FROM ${qualified("project")} p
  LEFT JOIN app.startup_profiles s ON s.chain_id = p."chain_id" AND s.escrow_address = p."escrow_address"`;

/** Escapes LIKE wildcards so user text matches literally (pairs with ESCAPE '\'). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

interface WhereClause {
  sql: string;
  params: unknown[];
}

function buildWhere(filters: ProjectFilters): WhereClause {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.chainId !== undefined) clauses.push(`p."chain_id" = ${bind(filters.chainId)}`);
  if (filters.state !== undefined) clauses.push(`p."state" = ${bind(filters.state)}`);
  if (filters.developer !== undefined) clauses.push(`p."developer" = ${bind(filters.developer)}`);
  if (filters.q !== undefined) {
    const pattern = bind(`%${escapeLike(filters.q)}%`);
    clauses.push(
      `(p."token_name" ILIKE ${pattern} ESCAPE '\\' OR p."token_symbol" ILIKE ${pattern} ESCAPE '\\')`
    );
  }
  if (filters.category !== undefined) clauses.push(`s.category = ${bind(filters.category)}`);
  if (filters.hasProfile !== undefined) {
    clauses.push(filters.hasProfile ? "s.project_id IS NOT NULL" : "s.project_id IS NULL");
  }

  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export async function findProjects(
  filters: ProjectFilters,
  sort: ProjectSort,
  order: SortOrder,
  limit: number,
  offset: number
): Promise<{ rows: ProjectRow[]; total: number }> {
  const where = buildWhere(filters);
  const n = where.params.length;

  const listSql = `${PROJECT_SELECT}${PROJECT_FROM}
  ${where.sql}
  ORDER BY ${SORT_COLUMNS[sort]} ${SORT_DIRECTIONS[order]}, p."id" ASC
  LIMIT $${n + 1} OFFSET $${n + 2}`;
  const countSql = `SELECT count(*) AS total${PROJECT_FROM}
  ${where.sql}`;

  const [list, count] = await Promise.all([
    pool.query<ProjectRow>(listSql, [...where.params, limit, offset]),
    pool.query<{ total: string }>(countSql, where.params),
  ]);

  return { rows: list.rows, total: Number(count.rows[0]?.total ?? 0) };
}

export async function findProjectById(id: string): Promise<ProjectRow | null> {
  const sql = `${PROJECT_SELECT}${PROJECT_FROM}
  WHERE p."id" = $1`;
  const result = await pool.query<ProjectRow>(sql, [id]);
  return result.rows[0] ?? null;
}

/** Splits a validated composite id `<chainId>:<escrow>` into its parts. */
function splitProjectId(projectId: string): { chainId: number; escrowAddress: string } {
  const [chain = "", escrow = ""] = projectId.split(":");
  return { chainId: Number(chain), escrowAddress: escrow.toLowerCase() };
}

export interface WalletBinding {
  walletId: string;
  /** Lowercase address, stored in shadow_wallet so it never disagrees with the wallet row. */
  address: string;
}

export interface ProfileActor {
  userId: string;
  ip: string | null;
}

/** Wallet currently bound to the profile, or null when the profile or its binding is absent. */
export async function findProfileWalletId(projectId: string): Promise<string | null> {
  const result = await pool.query<{ founder_wallet_id: string | null }>(
    "SELECT founder_wallet_id FROM app.startup_profiles WHERE project_id = $1",
    [projectId]
  );
  return result.rows[0]?.founder_wallet_id ?? null;
}

/**
 * Upserts the profile; chain_id and escrow_address are derived from the id, never from the body.
 * The wallet binding is written in the same statement (COALESCE keeps an existing binding when
 * none is supplied) and a 'shadow_wallet.bind' audit row is added only when the binding changed.
 */
export async function upsertProfile(
  body: CreateProfileBody,
  binding: WalletBinding | null,
  actor: ProfileActor
): Promise<ProfileRow> {
  const { chainId, escrowAddress } = splitProjectId(body.projectId);
  const projectId = `${chainId}:${escrowAddress}`;

  const sql = `
    WITH prev AS (
      SELECT founder_wallet_id FROM app.startup_profiles WHERE project_id = $1::text
    ),
    saved AS (
      INSERT INTO app.startup_profiles
        (project_id, chain_id, escrow_address, name, description, logo_url, pitch_deck_url,
         founder_bio, website_url, category, founder_wallet_id, shadow_wallet)
      VALUES
        ($1::text, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid, $12::text)
      ON CONFLICT (project_id) DO UPDATE SET
        name              = EXCLUDED.name,
        description       = EXCLUDED.description,
        logo_url          = EXCLUDED.logo_url,
        pitch_deck_url    = EXCLUDED.pitch_deck_url,
        founder_bio       = EXCLUDED.founder_bio,
        website_url       = EXCLUDED.website_url,
        category          = EXCLUDED.category,
        founder_wallet_id = COALESCE(EXCLUDED.founder_wallet_id, app.startup_profiles.founder_wallet_id),
        shadow_wallet     = COALESCE(EXCLUDED.shadow_wallet, app.startup_profiles.shadow_wallet)
      RETURNING name, description, logo_url, pitch_deck_url, founder_bio, website_url, category,
        updated_at, founder_wallet_id
    ),
    audited AS (
      INSERT INTO app.audit_log (action, actor_user_id, target, before_value, after_value, ip)
      SELECT 'shadow_wallet.bind', $13::uuid, $12::text, NULL, 'bound', $14::text
      FROM saved
      WHERE $11::uuid IS NOT NULL
        AND saved.founder_wallet_id IS DISTINCT FROM (SELECT founder_wallet_id FROM prev)
      RETURNING id
    )
    SELECT name, description, logo_url, pitch_deck_url, founder_bio, website_url, category, updated_at
    FROM saved`;

  const result = await pool.query<ProfileRow>(sql, [
    projectId,
    chainId,
    escrowAddress,
    body.name,
    body.description,
    body.logoUrl ?? null,
    body.pitchDeckUrl ?? null,
    body.founderBio ?? null,
    body.websiteUrl ?? null,
    body.category ?? null,
    binding?.walletId ?? null,
    binding?.address ?? null,
    actor.userId,
    actor.ip,
  ]);

  // the upsert always yields the saved row
  return result.rows[0] as ProfileRow;
}
