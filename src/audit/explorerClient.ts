import { config } from "../config/env.js";
import { logger } from "../logger.js";

export type InflowKind = "native" | "internal" | "erc20";

export interface InflowEntry {
  kind: InflowKind;
  entryRef: string;
  txHash: string;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  amount: bigint;
  fromAddress: string;
  blockNumber: bigint;
  blockTime: bigint;
}

export interface FetchInflowsRequest {
  chainId: number;
  wallet: string;
  kind: InflowKind;
  fromBlock: bigint;
}

export interface FetchInflowsResult {
  entries: InflowEntry[];
  /** Highest block among every row the explorer returned (not only incoming ones); null when it returned none. */
  maxBlock: bigint | null;
  dropped: number;
}

export interface ExplorerOptions {
  /** Never logged, never part of an error message. */
  apiKey: string;
  baseUrl: string;
  minIntervalMs: number;
  /** First rate-limit retry delay; doubles on each retry. */
  backoffMs: number;
  timeoutMs: number;
}

/** Messages are fixed strings: they never carry the request URL, the key or explorer text. */
export class ExplorerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExplorerError";
  }
}

const PAGE_SIZE = 1000;
const MAX_PAGES = 10;
const MAX_RATE_LIMIT_RETRIES = 3;
const END_BLOCK = "99999999";
const ACTIONS: Record<InflowKind, string> = { native: "txlist", internal: "txlistinternal", erc20: "tokentx" };
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;
const AMOUNT_RE = /^[0-9]{1,78}$/;
const NUMBER_RE = /^[0-9]{1,15}$/;
const SYMBOL_MAX = 32;

export function explorerOptionsFromConfig(): ExplorerOptions | null {
  if (config.ETHERSCAN_API_KEY === undefined) return null;
  return {
    apiKey: config.ETHERSCAN_API_KEY,
    baseUrl: config.EXPLORER_BASE_URL,
    minIntervalMs: config.EXPLORER_MIN_INTERVAL_MS,
    backoffMs: 1000,
    timeoutMs: 10_000,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

let lastCallAt = 0;

async function throttle(minIntervalMs: number): Promise<void> {
  const wait = lastCallAt + minIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

type RawRow = Record<string, unknown>;

function buildUrl(req: FetchInflowsRequest, startBlock: bigint, page: number, options: ExplorerOptions): string {
  const url = new URL(options.baseUrl);
  const params: Record<string, string> = {
    chainid: String(req.chainId),
    module: "account",
    action: ACTIONS[req.kind],
    address: req.wallet,
    startblock: startBlock.toString(),
    endblock: END_BLOCK,
    sort: "asc",
    page: String(page),
    offset: String(PAGE_SIZE),
    apikey: options.apiKey,
  };
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
}

function isRateLimited(message: unknown, result: unknown): boolean {
  const text = `${typeof message === "string" ? message : ""} ${typeof result === "string" ? result : ""}`;
  return /rate limit/i.test(text);
}

async function requestJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new ExplorerError(`explorer request failed (HTTP ${response.status})`);
    return await response.json();
  } catch (err) {
    if (err instanceof ExplorerError) throw err;
    if (controller.signal.aborted) throw new ExplorerError("explorer request timed out");
    throw new ExplorerError("explorer request failed");
  } finally {
    clearTimeout(timer);
  }
}

/** One explorer call: throttled, with bounded rate-limit retries. Returns the raw row list. */
async function fetchPage(url: string, options: ExplorerOptions): Promise<RawRow[]> {
  for (let attempt = 0; ; attempt += 1) {
    await throttle(options.minIntervalMs);
    const body = await requestJson(url, options.timeoutMs);
    if (body === null || typeof body !== "object") throw new ExplorerError("explorer returned an unexpected response");
    const { status, message, result } = body as { status?: unknown; message?: unknown; result?: unknown };
    if (status === "1" && Array.isArray(result)) {
      return result.filter((row): row is RawRow => row !== null && typeof row === "object" && !Array.isArray(row));
    }
    if (isRateLimited(message, result)) {
      if (attempt >= MAX_RATE_LIMIT_RETRIES) throw new ExplorerError("explorer rate limit persisted");
      await sleep(options.backoffMs * 2 ** attempt);
      continue;
    }
    if (status === "0" && typeof message === "string" && /no transactions found/i.test(message)) return [];
    throw new ExplorerError("explorer rejected the request");
  }
}

const text = (row: RawRow, key: string): string | null => {
  const value = row[key];
  return typeof value === "string" ? value : null;
};

function blockOf(row: RawRow): bigint | null {
  const value = text(row, "blockNumber");
  return value !== null && NUMBER_RE.test(value) ? BigInt(value) : null;
}

type ParseOutcome = InflowEntry | "skip" | "invalid";

/** Occurrence counters keyed by tx + discriminator, in response order. */
type Occurrences = Map<string, number>;

function nextOccurrence(counters: Occurrences, key: string): number {
  const n = counters.get(key) ?? 0;
  counters.set(key, n + 1);
  return n;
}

function parseRow(row: RawRow, req: FetchInflowsRequest, counters: Occurrences): ParseOutcome {
  const to = text(row, "to");
  if (to === null || to.toLowerCase() !== req.wallet.toLowerCase()) return "skip";

  const hash = text(row, "hash");
  const from = text(row, "from");
  const value = text(row, "value");
  const time = text(row, "timeStamp");
  const block = blockOf(row);
  if (hash === null || !TX_HASH_RE.test(hash)) return "invalid";
  if (from === null || !ADDRESS_RE.test(from)) return "invalid";
  if (value === null || !AMOUNT_RE.test(value)) return "invalid";
  if (time === null || !NUMBER_RE.test(time) || block === null) return "invalid";
  const amount = BigInt(value);
  if (amount === 0n) return "skip";
  if (req.kind !== "erc20" && text(row, "isError") === "1") return "skip";

  const txHash = hash.toLowerCase();
  const fromAddress = from.toLowerCase();
  const base = { kind: req.kind, txHash, amount, fromAddress, blockNumber: block, blockTime: BigInt(time) };

  if (req.kind === "native") return { ...base, entryRef: "", tokenAddress: null, tokenSymbol: null };
  if (req.kind === "internal") {
    const trace = text(row, "traceId");
    const entryRef =
      trace !== null && trace !== "" ? trace.slice(0, 64) : `idx:${nextOccurrence(counters, `${txHash}:internal`)}`;
    return { ...base, entryRef, tokenAddress: null, tokenSymbol: null };
  }

  const contract = text(row, "contractAddress");
  if (contract === null || !ADDRESS_RE.test(contract)) return "invalid";
  const tokenAddress = contract.toLowerCase();
  const logIndex = text(row, "logIndex");
  const entryRef =
    logIndex !== null && NUMBER_RE.test(logIndex)
      ? logIndex
      : `${tokenAddress}:${fromAddress}:${value}:${nextOccurrence(counters, `${txHash}:${tokenAddress}:${fromAddress}:${value}`)}`;
  const symbol = text(row, "tokenSymbol");
  return { ...base, entryRef, tokenAddress, tokenSymbol: symbol === null ? null : symbol.slice(0, SYMBOL_MAX) };
}

/**
 * Reads every incoming transfer of one kind for one wallet from `fromBlock`. Pages of 1000 rows,
 * at most 10 pages per window (the explorer's 10000-row limit); a full window restarts from the
 * last block seen (overlap is safe because entries are de-duplicated by key), and a window that
 * makes no progress fails the call. Invalid rows are dropped and counted.
 */
export async function fetchInflows(
  req: FetchInflowsRequest,
  options: ExplorerOptions | null = explorerOptionsFromConfig()
): Promise<FetchInflowsResult> {
  if (options === null) throw new ExplorerError("explorer is not configured");
  const entries = new Map<string, InflowEntry>();
  let maxBlock: bigint | null = null;
  let dropped = 0;
  let startBlock = req.fromBlock;

  for (;;) {
    const counters: Occurrences = new Map();
    let windowFull = true;
    let windowMax: bigint | null = null;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const rows = await fetchPage(buildUrl(req, startBlock, page, options), options);
      for (const row of rows) {
        const block = blockOf(row);
        if (block !== null && (windowMax === null || block > windowMax)) windowMax = block;
        const outcome = parseRow(row, req, counters);
        if (outcome === "invalid") dropped += 1;
        else if (outcome !== "skip") entries.set(`${outcome.txHash}|${outcome.kind}|${outcome.entryRef}`, outcome);
      }
      if (rows.length < PAGE_SIZE) {
        windowFull = false;
        break;
      }
    }
    if (windowMax !== null && (maxBlock === null || windowMax > maxBlock)) maxBlock = windowMax;
    if (!windowFull) break;
    if (windowMax === null || windowMax <= startBlock) throw new ExplorerError("explorer window made no progress");
    startBlock = windowMax;
  }

  if (dropped > 0) {
    logger.warn({ chainId: req.chainId, wallet: req.wallet, kind: req.kind, dropped }, "explorer rows dropped as invalid");
  }
  return { entries: [...entries.values()], maxBlock, dropped };
}
