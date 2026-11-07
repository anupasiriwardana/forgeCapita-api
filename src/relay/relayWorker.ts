import type { FeeData } from "ethers";
import { config } from "../config/env.js";
import { logger } from "../logger.js";
import { toLoggableError } from "../middlewares/errorHandler.js";
import { relayChains, type RelayChain } from "./chains.js";
import { RelayError } from "./relayErrors.js";
import {
  claimNextQueued,
  expireStale,
  failInterrupted,
  listSent,
  markConfirmed,
  markFailed,
  markSent,
} from "./relayRepository.js";
import { simulate } from "./relayService.js";
import type { SendRequest } from "./signer.js";

export const RELAY_TICK_MS = 3000;
const MAX_SENDS_PER_TICK = 5;
const MAX_CONFIRMS_PER_TICK = 20;
const GAS_LIMIT_NUMERATOR = 130n;
const GAS_LIMIT_DENOMINATOR = 100n;

/**
 * Fee fields for a transaction, or null when the current gas price is above the configured cap
 * (the request is failed instead of waiting for cheaper gas). The signed max fee never exceeds the cap.
 */
export function pickFees(fee: FeeData, capWei: bigint): SendRequest["fees"] | null {
  const current = fee.gasPrice ?? fee.maxFeePerGas;
  if (current === null || current > capWei) return null;
  if (fee.maxFeePerGas === null) return { gasPrice: current };
  const maxFeePerGas = fee.maxFeePerGas < capWei ? fee.maxFeePerGas : capWei;
  const priority = fee.maxPriorityFeePerGas ?? 0n;
  return { maxFeePerGas, maxPriorityFeePerGas: priority < maxFeePerGas ? priority : maxFeePerGas };
}

/** Sends the next queued request of a chain; returns false when there was nothing to send. */
async function sendNext(chain: RelayChain): Promise<boolean> {
  const balance = await chain.provider.getBalance(chain.sender.address);
  if (balance < chain.minBalanceWei) {
    logger.warn({ chainId: chain.chainId }, "relayer balance below minimum, sending paused");
    return false;
  }
  const row = await claimNextQueued(chain.chainId);
  if (row === null) return false;

  let txHash: string;
  try {
    const estimate = await simulate(chain, row.to, row.data);
    const fees = pickFees(await chain.provider.getFeeData(), chain.maxGasPriceWei);
    if (fees === null) {
      await markFailed(row.id, "GAS_TOO_HIGH", "Network fees were too high; please retry later.");
      return true;
    }
    txHash = await chain.sender.send({
      to: row.to,
      data: row.data,
      gasLimit: (estimate * GAS_LIMIT_NUMERATOR) / GAS_LIMIT_DENOMINATOR,
      nonce: await chain.sender.getNonce(),
      fees,
    });
  } catch (err) {
    if (err instanceof RelayError) await markFailed(row.id, err.code, err.message);
    else await markFailed(row.id, "SEND_FAILED", "The transaction could not be broadcast.");
    return true;
  }
  await markSent(row.id, txHash);
  return true;
}

/** Moves SENT rows to CONFIRMED after enough confirmations, or FAILED when the receipt reverted. */
async function confirmSent(chain: RelayChain): Promise<void> {
  const rows = await listSent(chain.chainId, MAX_CONFIRMS_PER_TICK);
  if (rows.length === 0) return;
  const head = await chain.provider.getBlockNumber();
  for (const row of rows) {
    try {
      const receipt = await chain.provider.getTransactionReceipt(row.txHash);
      if (receipt === null) continue;
      const gas = { gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.gasPrice };
      if (receipt.status === 0) {
        await markFailed(row.id, "REVERTED", "The transaction reverted on chain.", gas);
      } else if (head - receipt.blockNumber + 1 >= config.RELAYER_CONFIRMATIONS) {
        await markConfirmed(row.id, gas.gasUsed, gas.effectiveGasPrice);
      }
    } catch (err) {
      logger.warn({ id: row.id, err: toLoggableError(err) }, "relay receipt check failed");
    }
  }
}

async function processChain(chain: RelayChain): Promise<void> {
  await confirmSent(chain);
  for (let sent = 0; sent < MAX_SENDS_PER_TICK; sent += 1) {
    if (!(await sendNext(chain))) return;
  }
}

/** One pass over every enabled chain, serially; never throws. */
export async function runRelayTick(): Promise<void> {
  try {
    const expired = await expireStale();
    if (expired > 0) logger.info({ expired }, "relay requests expired");
  } catch (err) {
    logger.error({ err: toLoggableError(err) }, "relay expiry failed");
  }
  for (const chain of relayChains()) {
    try {
      await processChain(chain);
    } catch (err) {
      logger.error({ chainId: chain.chainId, err: toLoggableError(err) }, "relay tick failed");
    }
  }
}

/** Boot recovery; never throws. */
export async function recoverRelayState(): Promise<void> {
  try {
    const interrupted = await failInterrupted();
    if (interrupted > 0) logger.warn({ interrupted }, "relay requests interrupted by restart were failed");
  } catch (err) {
    logger.error({ err: toLoggableError(err) }, "relay recovery failed");
  }
}

let inFlight: Promise<void> | null = null;

/**
 * Starts the sender/confirmer loop (not under test, and only when a chain is enabled). Returns a stop
 * function that resolves once any in-flight run ends.
 */
export function startRelayWorker(): (() => Promise<void>) | null {
  if (config.NODE_ENV === "test" || relayChains().length === 0) return null;
  let stopped = false;
  inFlight = recoverRelayState().finally(() => {
    inFlight = null;
  });
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = runRelayTick().finally(() => {
      inFlight = null;
    });
  }, RELAY_TICK_MS);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await inFlight;
  };
}
