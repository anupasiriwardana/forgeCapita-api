import { config } from "../config/env.js";
import { pool } from "../db/pool.js";
import { logger } from "../logger.js";
import { toLoggableError } from "../middlewares/errorHandler.js";
import { escrowInterface, readView, relayChains, type RelayChain } from "./chains.js";
import { RelayError } from "./relayErrors.js";
import {
  executeHistory,
  insertRelayRequest,
  listExecuteCandidates,
  recordExecuteFailure,
  type ExecuteCandidate,
} from "./relayRepository.js";
import { simulate } from "./relayService.js";

/** Advisory lock id so overlapping instances never run the job at the same time. */
export const AUTOEXEC_LOCK_ID = 727361003;
const BATCH_SIZE = 50;
/** Seconds past the voting end before acting, absorbing clock skew and indexer lag. */
const END_MARGIN_S = 15n;
const RETRY_SPACING_MS = 60 * 60 * 1000;
const REQUEST_TTL_MS = 30 * 60 * 1000;

const nowSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000));

function requestFor(candidate: ExecuteCandidate, key: string, relayer: string, data: string) {
  return {
    chainId: candidate.chainId,
    projectId: candidate.projectId,
    account: relayer.toLowerCase(),
    payload: { milestoneIndex: candidate.milestoneIndex },
    args: { to: candidate.escrowAddress, data },
    idemKey: key,
  };
}

/** Reads the chain: true only when this very milestone is open, unexecuted, the project is live and the vote has ended. */
async function isExecutableOnChain(chain: RelayChain, candidate: ExecuteCandidate): Promise<boolean> {
  const escrow = candidate.escrowAddress;
  const read = (fn: string, args: unknown[] = []) => readView(chain.provider, escrowInterface, escrow, fn, args);
  const [cancelled] = await read("projectCancelled");
  const [completed] = await read("completed");
  if (cancelled !== false || completed !== false) return false;
  const [index] = await read("currentMilestoneIndex");
  if (index !== BigInt(candidate.milestoneIndex)) return false;
  const milestone = await read("milestones", [index]);
  if (milestone[2] !== true || milestone[3] !== false) return false;
  const [end] = await read("votingEndTime", [index]);
  return typeof end === "bigint" && nowSeconds() >= end + END_MARGIN_S;
}

async function processCandidate(chain: RelayChain, candidate: ExecuteCandidate): Promise<void> {
  const key = `execute:${candidate.chainId}:${candidate.escrowAddress}:${candidate.milestoneIndex}`;
  const history = await executeHistory(key);
  if (history.live || history.selfPay || history.failures >= config.MILESTONE_AUTOEXEC_MAX_ATTEMPTS) return;
  if (history.lastAttemptAt !== null && Date.now() - history.lastAttemptAt.getTime() < RETRY_SPACING_MS) return;
  if (!(await isExecutableOnChain(chain, candidate))) return;

  const data = escrowInterface.encodeFunctionData("executeMilestone");
  const request = requestFor(candidate, key, chain.sender.address, data);
  try {
    await simulate(chain, candidate.escrowAddress, data);
  } catch (err) {
    if (!(err instanceof RelayError)) throw err;
    if (err.code === "RELAY_UNAVAILABLE" || err.message.includes("Milestones frozen")) return;
    if (err.code === "SELF_PAY") {
      await recordExecuteFailure(request, "SELF_PAY", "The project gas budget is exhausted; execute the milestone manually.");
      logger.warn({ projectId: candidate.projectId, milestoneIndex: candidate.milestoneIndex }, "milestone auto-execution needs self-pay");
      return;
    }
    await recordExecuteFailure(request, "SIMULATION_FAILED", err.message);
    logger.warn(
      { projectId: candidate.projectId, milestoneIndex: candidate.milestoneIndex, reason: err.message },
      "milestone auto-execution simulation failed"
    );
    return;
  }
  const record = await insertRelayRequest({
    ...request,
    kind: "execute",
    userId: null,
    expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
  });
  if (record !== null) {
    logger.info(
      { projectId: candidate.projectId, milestoneIndex: candidate.milestoneIndex },
      "milestone auto-execution queued"
    );
  }
}

async function processChain(chain: RelayChain): Promise<void> {
  const candidates = await listExecuteCandidates(chain.chainId, nowSeconds() - END_MARGIN_S, BATCH_SIZE);
  for (const candidate of candidates) {
    try {
      await processCandidate(chain, candidate);
    } catch (err) {
      logger.warn(
        { projectId: candidate.projectId, milestoneIndex: candidate.milestoneIndex, err: toLoggableError(err) },
        "milestone auto-execution candidate failed"
      );
    }
  }
}

let inFlight: Promise<void> | null = null;

/** One scheduled pass under a session advisory lock; never throws. */
export async function runAutoExecOnce(): Promise<void> {
  try {
    const client = await pool.connect();
    try {
      const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS locked", [
        AUTOEXEC_LOCK_ID,
      ]);
      if (lock.rows[0]?.locked !== true) return;
      try {
        for (const chain of relayChains()) {
          try {
            await processChain(chain);
          } catch (err) {
            logger.error({ chainId: chain.chainId, err: toLoggableError(err) }, "milestone auto-execution failed");
          }
        }
      } finally {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [AUTOEXEC_LOCK_ID]);
      }
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error({ err: toLoggableError(err) }, "milestone auto-execution run failed");
  }
}

/**
 * Starts the interval job (not under test) when MILESTONE_AUTOMATIC_EXECUTION=true and the relayer has
 * at least one enabled chain. Returns a stop function that resolves once any in-flight run ends.
 */
export function startMilestoneAutoExec(): (() => Promise<void>) | null {
  if (config.NODE_ENV === "test") return null;
  if (!config.MILESTONE_AUTOMATIC_EXECUTION || relayChains().length === 0) {
    logger.info("milestone auto-execution disabled");
    return null;
  }
  logger.info("milestone auto-execution enabled");
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = runAutoExecOnce().finally(() => {
      inFlight = null;
    });
  }, config.MILESTONE_AUTOEXEC_INTERVAL_MS);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await inFlight;
  };
}
