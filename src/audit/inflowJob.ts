import { config, type AppConfig } from "../config/env.js";
import { INFLOW_LOCK_ID, withTransactionLock } from "../db/advisoryLock.js";
import { logger } from "../logger.js";
import { toLoggableError } from "../middlewares/errorHandler.js";
import { ExplorerError, fetchInflows, type InflowKind } from "./explorerClient.js";
import { insertInflows, listAuditWallets, readCursor, writeCursor, type AuditWallet } from "./inflowRepository.js";

export { INFLOW_LOCK_ID };
const BATCH_SIZE = 50;
/** Blocks re-read before the cursor so a shallow reorg cannot hide a transfer. */
const REORG_MARGIN = 20n;
const KINDS: readonly InflowKind[] = ["native", "internal", "erc20"];

export type InflowSettings = Pick<
  AppConfig,
  | "NODE_ENV"
  | "REVENUE_AUDIT_ENABLED"
  | "ETHERSCAN_API_KEY"
  | "REVENUE_AUDIT_CHAINS"
  | "EXPLORER_POLL_INTERVAL_MS"
>;

let stopping = false;

/** Short, fixed-text reason for the cursor row: explorer errors are already sanitised, anything else is generic. */
function shortReason(err: unknown): string {
  return err instanceof ExplorerError ? err.message : "inflow processing failed";
}

async function pollKind(wallet: AuditWallet, kind: InflowKind): Promise<void> {
  const cursor = await readCursor(wallet.chainId, wallet.address, kind);
  const fromBlock = cursor > REORG_MARGIN ? cursor - REORG_MARGIN : 0n;
  try {
    const result = await fetchInflows({ chainId: wallet.chainId, wallet: wallet.address, kind, fromBlock });
    await insertInflows(wallet.chainId, wallet.address, result.entries);
    await writeCursor(wallet.chainId, wallet.address, kind, result.maxBlock ?? cursor, null);
  } catch (err) {
    logger.warn(
      { chainId: wallet.chainId, wallet: wallet.address, kind, err: toLoggableError(err) },
      "inflow poll failed"
    );
    await writeCursor(wallet.chainId, wallet.address, kind, cursor, shortReason(err));
  }
}

async function processWallet(wallet: AuditWallet): Promise<void> {
  for (const kind of KINDS) {
    if (stopping) return;
    try {
      await pollKind(wallet, kind);
    } catch (err) {
      logger.error({ chainId: wallet.chainId, wallet: wallet.address, kind, err: toLoggableError(err) }, "inflow cursor update failed");
    }
  }
}

let inFlight: Promise<void> | null = null;

/** One scheduled pass under a transaction advisory lock; never throws. */
export async function runInflowOnce(): Promise<void> {
  try {
    await withTransactionLock(INFLOW_LOCK_ID, "inflow", async () => {
      const wallets = await listAuditWallets(config.REVENUE_AUDIT_CHAINS, BATCH_SIZE);
      for (const wallet of wallets) {
        if (stopping) break;
        await processWallet(wallet);
      }
    });
  } catch (err) {
    logger.error({ err: toLoggableError(err) }, "inflow run failed");
  }
}

/**
 * Starts the interval job (not under test) only when REVENUE_AUDIT_ENABLED=true AND an explorer
 * key is set (fail-closed). Returns a stop function that resolves once any in-flight run ends.
 */
export function startInflowJob(settings: InflowSettings = config): (() => Promise<void>) | null {
  if (settings.NODE_ENV === "test") return null;
  if (!settings.REVENUE_AUDIT_ENABLED || settings.ETHERSCAN_API_KEY === undefined) {
    logger.info("revenue audit disabled");
    return null;
  }
  logger.info("revenue audit enabled");
  logger.info(`revenue audit chains: ${settings.REVENUE_AUDIT_CHAINS.join(",")}`);
  stopping = false;
  const tick = (): void => {
    if (stopping || inFlight) return;
    inFlight = runInflowOnce().finally(() => {
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
