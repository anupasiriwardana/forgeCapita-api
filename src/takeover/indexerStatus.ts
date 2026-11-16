import { z } from "zod";
import { config } from "../config/env.js";
import { AppError } from "../errors.js";

const TIMEOUT_MS = 5000;

/** Shape of the indexer's GET /status: `{ chainName: { id, block: { number, timestamp } } }`. */
const statusSchema = z.record(
  z.string(),
  z.object({
    id: z.number().int(),
    block: z.object({
      number: z.number().int().nonnegative(),
      timestamp: z.number().int().nonnegative(),
    }),
  })
);

export interface IndexedHead {
  blockNumber: bigint;
  /** Unix seconds of the head block. */
  blockTimestamp: number;
}

type FetchLike = (url: string, init: { signal: AbortSignal; redirect: "error"; headers: Record<string, string> }) => Promise<Pick<Response, "ok" | "json">>;

function unavailable(): AppError {
  return new AppError(503, "Indexer status is unavailable", true);
}

/**
 * Latest indexed block of one chain, from the indexer's /status. Fails closed (503) when INDEXER_URL
 * is unset, the indexer is unreachable, answers an error, or the answer is malformed or lacks the
 * chain. Response bodies and the URL are never logged or echoed.
 */
export async function fetchIndexedHead(
  chainId: number,
  baseUrl: string | undefined = config.INDEXER_URL,
  fetchImpl: FetchLike = fetch
): Promise<IndexedHead> {
  if (baseUrl === undefined) throw new AppError(503, "Takeover votes are not configured", true);
  let body: unknown;
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/status`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw unavailable();
    body = await response.json();
  } catch {
    throw unavailable();
  }
  const parsed = statusSchema.safeParse(body);
  if (!parsed.success) throw unavailable();
  const chain = Object.values(parsed.data).find((entry) => entry.id === chainId);
  if (!chain) throw unavailable();
  return { blockNumber: BigInt(chain.block.number), blockTimestamp: chain.block.timestamp };
}

/** Seconds the indexed head lags behind `nowMs` (never negative). */
export function lagSeconds(head: IndexedHead, nowMs: number): number {
  return Math.max(0, Math.floor(nowMs / 1000) - head.blockTimestamp);
}
