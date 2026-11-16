import { config, type AppConfig } from "../config/env.js";
import { GAS_LOCK_ID, withTransactionLock } from "../db/advisoryLock.js";
import { logger } from "../logger.js";
import { toLoggableError } from "../middlewares/errorHandler.js";
import { GAS_CHAIN_IDS, hasGasRpc, readGasPrice } from "./gasOracle.js";
import { insertGasSample, pruneGasSamples } from "./gasRepository.js";

export { GAS_LOCK_ID };
const RETENTION_HOURS = 48;

export type GasJobSettings = Pick<AppConfig, "NODE_ENV" | "GAS_SAMPLE_INTERVAL_MS">;

let stopping = false;
let inFlight: Promise<void> | null = null;

async function sampleChain(chainId: number): Promise<void> {
  try {
    const price = await readGasPrice(chainId);
    if (price === null) {
      logger.warn({ chainId }, "gas sample unavailable");
      return;
    }
    await insertGasSample(chainId, price);
  } catch (err) {
    logger.warn({ chainId, err: toLoggableError(err) }, "gas sample failed");
  }
}

/** One scheduled pass under a transaction advisory lock; never throws. */
export async function runGasOnce(): Promise<void> {
  try {
    await withTransactionLock(GAS_LOCK_ID, "gas-sampler", async () => {
      for (const chainId of GAS_CHAIN_IDS) {
        if (stopping) break;
        if (hasGasRpc(chainId)) await sampleChain(chainId);
      }
      await pruneGasSamples(RETENTION_HOURS);
    });
  } catch (err) {
    logger.error({ err: toLoggableError(err) }, "gas job run failed");
  }
}

/** Starts the sampling interval (never under test). The returned stop function awaits any in-flight run. */
export function startGasJob(settings: GasJobSettings = config): (() => Promise<void>) | null {
  if (settings.NODE_ENV === "test") return null;
  logger.info("gas sampling enabled");
  stopping = false;
  const tick = (): void => {
    if (stopping || inFlight) return;
    inFlight = runGasOnce().finally(() => {
      inFlight = null;
    });
  };
  const timer = setInterval(tick, settings.GAS_SAMPLE_INTERVAL_MS);
  timer.unref();
  tick();
  return async () => {
    stopping = true;
    clearInterval(timer);
    await inFlight;
  };
}
