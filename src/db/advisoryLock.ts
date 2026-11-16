import { logger } from "../logger.js";
import { pool } from "./pool.js";

/**
 * Advisory lock registry (single source of truth; one id per background job so overlapping instances
 * never double-run). Keys share one namespace across session and transaction level.
 *
 *   727361001 = migration runner (src/db/migrationRunner.ts, xact lock; id kept unchanged)
 *   727361101 = migration (documented only, reserved)
 *   727361102 = RECONCILE_LOCK_ID  (drafts/reconcile.ts)
 *   727361103 = AUTOEXEC_LOCK_ID   (relay/milestoneAutoExec.ts)
 *   727361104 = INFLOW_LOCK_ID     (audit/inflowJob.ts)
 *   727361105 = COMPLIANCE_LOCK_ID (audit/complianceJob.ts)
 *   727361106 = GAS_LOCK_ID        (gas/gasJob.ts)
 *
 * Abandoned: 727361002/003/004/005/006 were SESSION locks that leaked behind Neon's pgbouncer; new
 * ids make any leaked holders irrelevant.
 */
export const RECONCILE_LOCK_ID = 727361102;
export const AUTOEXEC_LOCK_ID = 727361103;
export const INFLOW_LOCK_ID = 727361104;
export const COMPLIANCE_LOCK_ID = 727361105;
export const GAS_LOCK_ID = 727361106;

/**
 * Runs `fn` while holding a transaction-level advisory lock. The open transaction pins the pooler's
 * server connection, so the lock is taken and released on the same backend (session locks leak
 * behind transaction pooling). Returns false, without running `fn`, when another holder has the lock.
 * `fn` should use the shared pool for its own queries. Holds one pool connection for the whole pass.
 */
export async function withTransactionLock(lockId: number, name: string, fn: () => Promise<void>): Promise<boolean> {
  const client = await pool.connect();
  let broken: Error | undefined;
  let fnFailed = false;
  try {
    await client.query("BEGIN");
    const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock($1::bigint) AS locked", [lockId]);
    if (lock.rows[0]?.locked !== true) {
      await client.query("ROLLBACK");
      logger.info({ job: name, lockId }, "job pass skipped, lock held elsewhere");
      return false;
    }
    try {
      await fn();
    } catch (err) {
      fnFailed = true;
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        broken = toError(rollbackErr);
      }
      throw err;
    }
    try {
      await client.query("COMMIT");
    } catch (err) {
      broken = toError(err);
      throw err;
    }
    return true;
  } catch (err) {
    if (!fnFailed) broken ??= toError(err);
    throw err;
  } finally {
    client.release(broken);
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error("lock transaction failed");
}
