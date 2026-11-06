import { config } from "../config/env.js";
import { pool, qualified } from "../db/pool.js";
import { logger } from "../logger.js";
import { toLoggableError } from "../middlewares/errorHandler.js";

/** Advisory lock id so overlapping instances never run the job at the same time. */
export const RECONCILE_LOCK_ID = 727361002;
const BATCH_SIZE = 50;
const PENDING_TTL = "7 days";

export interface ReconcileResult {
  applied: number;
  conflicts: number;
  expired: number;
}

/**
 * ONE statement: locks attached drafts whose project is indexed with a matching developer
 * (SKIP LOCKED), inserts the profile unless one already exists (any unique violation counts as
 * a conflict), moves each draft to applied or conflict, and writes the audit rows.
 * The payload keys map to the same columns as projectRepository.upsertProfile.
 */
function reconcileSql(): string {
  return `
    WITH due AS (
      SELECT d.id, d.user_id, d.wallet_address, d.chain_id, d.escrow_address, d.project_id,
        d.payload, d.founder_wallet_id
      FROM app.launch_drafts d
      JOIN ${qualified("project")} p ON p."id" = d.project_id AND lower(p."developer") = d.wallet_address
      WHERE d.status = 'attached' AND ($1::uuid IS NULL OR d.id = $1::uuid)
      ORDER BY d.created_at
      LIMIT ${BATCH_SIZE}
      FOR UPDATE OF d SKIP LOCKED
    ),
    inserted AS (
      INSERT INTO app.startup_profiles
        (project_id, chain_id, escrow_address, name, description, logo_url, pitch_deck_url,
         founder_bio, website_url, category, founder_wallet_id, shadow_wallet)
      SELECT d.project_id, d.chain_id, d.escrow_address, d.payload->>'name', d.payload->>'description',
        d.payload->>'logoUrl', d.payload->>'pitchDeckUrl', d.payload->>'founderBio',
        d.payload->>'websiteUrl', d.payload->>'category', d.founder_wallet_id, w.address
      FROM due d
      LEFT JOIN app.founder_wallets w ON w.id = d.founder_wallet_id
      ON CONFLICT DO NOTHING
      RETURNING project_id
    ),
    applied AS (
      UPDATE app.launch_drafts d SET status = 'applied', applied_at = now(), updated_at = now()
      FROM due
      WHERE d.id = due.id AND due.project_id IN (SELECT project_id FROM inserted)
      RETURNING d.id, d.user_id, d.wallet_address
    ),
    conflicted AS (
      UPDATE app.launch_drafts d SET status = 'conflict', updated_at = now()
      FROM due
      WHERE d.id = due.id AND due.project_id NOT IN (SELECT project_id FROM inserted)
      RETURNING d.id, d.user_id, d.wallet_address
    ),
    audit_applied AS (
      INSERT INTO app.audit_log (action, actor_user_id, target, before_value, after_value, ip)
      SELECT 'launch_draft.apply', a.user_id, a.wallet_address, 'attached', 'applied', NULL FROM applied a
      RETURNING id
    ),
    audit_conflict AS (
      INSERT INTO app.audit_log (action, actor_user_id, target, before_value, after_value, ip)
      SELECT 'launch_draft.conflict', c.user_id, c.wallet_address, 'attached', 'conflict', NULL FROM conflicted c
      RETURNING id
    )
    SELECT (SELECT count(*) FROM applied) AS applied, (SELECT count(*) FROM conflicted) AS conflicts`;
}

/** Releases wallets held by drafts that were never attached. */
const EXPIRE_SQL = `
  UPDATE app.launch_drafts SET status = 'expired', updated_at = now()
  WHERE status = 'pending' AND created_at < now() - interval '${PENDING_TTL}'`;

interface CountRow {
  applied: string;
  conflicts: string;
}

/** Applies attached drafts whose project is indexed; with no draftId it also expires stale drafts. */
export async function reconcileDrafts(options: { draftId?: string } = {}): Promise<ReconcileResult> {
  const result = await pool.query<CountRow>(reconcileSql(), [options.draftId ?? null]);
  const row = result.rows[0];
  const applied = Number(row?.applied ?? 0);
  const conflicts = Number(row?.conflicts ?? 0);
  if (options.draftId !== undefined) return { applied, conflicts, expired: 0 };
  const expired = await pool.query(EXPIRE_SQL);
  return { applied, conflicts, expired: expired.rowCount ?? 0 };
}

let inFlight: Promise<void> | null = null;

/** One scheduled run under a session advisory lock; never throws. */
export async function runReconcileOnce(): Promise<void> {
  try {
    const client = await pool.connect();
    try {
      const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS locked", [
        RECONCILE_LOCK_ID,
      ]);
      if (lock.rows[0]?.locked !== true) return;
      try {
        const outcome = await reconcileDrafts();
        if (outcome.applied + outcome.conflicts + outcome.expired > 0) {
          logger.info(outcome, "launch drafts reconciled");
        }
      } finally {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [RECONCILE_LOCK_ID]);
      }
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error({ err: toLoggableError(err) }, "launch draft reconcile failed");
  }
}

/** Starts the interval job (not under test); returns a stop function that resolves once any in-flight run ends. */
export function startReconcileJob(): (() => Promise<void>) | null {
  if (config.NODE_ENV === "test") return null;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = runReconcileOnce().finally(() => {
      inFlight = null;
    });
  }, config.DRAFT_RECONCILE_INTERVAL_MS);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await inFlight;
  };
}
