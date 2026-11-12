import { config, type AppConfig } from "../config/env.js";
import { pool } from "../db/pool.js";
import { logger } from "../logger.js";
import { toLoggableError } from "../middlewares/errorHandler.js";
import { computeShortfall, WINDOW_DAYS } from "./complianceLogic.js";
import {
  applyCheck,
  listCheckableProjects,
  sumObservedNative,
  sumRouted,
  walletCursorsHealthy,
  type CheckableProject,
} from "./complianceRepository.js";

/**
 * Advisory lock registry (one id per background job so overlapping instances never double-run):
 * 727361004 = inflow job (inflowJob.ts), 727361005 = compliance job (this file),
 * 727361006 = gas sampler (gas/gasJob.ts).
 */
export const COMPLIANCE_LOCK_ID = 727361005;

export type ComplianceSettings = Pick<
  AppConfig,
  | "NODE_ENV"
  | "REVENUE_AUDIT_ENABLED"
  | "ETHERSCAN_API_KEY"
  | "REVENUE_AUDIT_CHAINS"
  | "EXPLORER_POLL_INTERVAL_MS"
  | "REVENUE_TOLERANCE_BPS"
>;

let stopping = false;

/**
 * One reconciliation of one project over the trailing window. Skipped (no case touched) when the
 * wallet's explorer cursors were never polled or last failed, so an outage cannot raise a flag.
 */
export async function checkProject(project: CheckableProject, toleranceBps: number, now: Date = new Date()): Promise<boolean> {
  if (!(await walletCursorsHealthy(project.chainId, project.wallet))) return false;
  const windowEndSec = Math.floor(now.getTime() / 1000);
  const windowStartSec = windowEndSec - WINDOW_DAYS * 86_400;
  const observed = await sumObservedNative(project.chainId, project.wallet, windowStartSec, windowEndSec);
  const routed = await sumRouted(project.projectId, project.chainId, windowStartSec, windowEndSec);
  const { shortfallBps, flagged } = computeShortfall(observed, routed, toleranceBps);
  await applyCheck({ project, observed, routed, shortfallBps, flagged, windowStartSec, windowEndSec, now });
  return true;
}

let inFlight: Promise<void> | null = null;

/** One scheduled pass under a session advisory lock; never throws. */
export async function runComplianceOnce(
  chainIds: readonly number[] = config.REVENUE_AUDIT_CHAINS,
  toleranceBps: number = config.REVENUE_TOLERANCE_BPS
): Promise<void> {
  try {
    const client = await pool.connect();
    try {
      const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS locked", [
        COMPLIANCE_LOCK_ID,
      ]);
      if (lock.rows[0]?.locked !== true) return;
      try {
        for (const project of await listCheckableProjects(chainIds)) {
          if (stopping) break;
          try {
            await checkProject(project, toleranceBps);
          } catch (err) {
            logger.error({ projectId: project.projectId, err: toLoggableError(err) }, "compliance check failed");
          }
        }
      } finally {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [COMPLIANCE_LOCK_ID]);
      }
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error({ err: toLoggableError(err) }, "compliance run failed");
  }
}

/**
 * Starts the interval job (not under test) with the same gating as the inflow job: only when
 * REVENUE_AUDIT_ENABLED=true AND an explorer key is set. Returns a stop function that resolves once
 * any in-flight run ends.
 */
export function startComplianceJob(settings: ComplianceSettings = config): (() => Promise<void>) | null {
  if (settings.NODE_ENV === "test") return null;
  if (!settings.REVENUE_AUDIT_ENABLED || settings.ETHERSCAN_API_KEY === undefined) return null;
  logger.info("compliance reconciliation enabled");
  stopping = false;
  const tick = (): void => {
    if (stopping || inFlight) return;
    inFlight = runComplianceOnce(settings.REVENUE_AUDIT_CHAINS, settings.REVENUE_TOLERANCE_BPS).finally(() => {
      inFlight = null;
    });
  };
  const timer = setInterval(tick, settings.EXPLORER_POLL_INTERVAL_MS);
  timer.unref();
  tick();
  return async () => {
    stopping = true;
    clearInterval(timer);
    await inFlight;
  };
}
