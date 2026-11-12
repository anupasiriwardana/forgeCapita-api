import { config, type AppConfig } from "../config/env.js";
import { pool } from "../db/pool.js";
import { logger } from "../logger.js";
import { toLoggableError } from "../middlewares/errorHandler.js";
import { GAS_CHAIN_IDS, hasGasRpc, readGasPrice } from "./gasOracle.js";
import { insertGasSample, pruneGasSamples } from "./gasRepository.js";

/** Advisory lock id so overlapping instances never sample at the same time. */
export const GAS_LOCK_ID = 727361006;
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

/** One scheduled pass under a session advisory lock; never throws. */
export async function runGasOnce(): Promise<void> {
  try {
    const client = await pool.connect();
    try {
      const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS locked", [
        GAS_LOCK_ID,
      ]);
      if (lock.rows[0]?.locked !== true) return;
      try {
        for (const chainId of GAS_CHAIN_IDS) {
          if (stopping) break;
          if (hasGasRpc(chainId)) await sampleChain(chainId);
        }
        await pruneGasSamples(RETENTION_HOURS);
      } finally {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [GAS_LOCK_ID]);
      }
    } finally {
      client.release();
    }
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
