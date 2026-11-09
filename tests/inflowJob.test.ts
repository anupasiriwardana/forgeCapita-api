/**
 * Revenue audit step A unit tests: explorer client with a mocked fetch, job gating and wiring,
 * admin query schema. No network; the SQL is covered by tests/integration/inflows.itest.ts.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { readFileSync } from "node:fs";

const mockQuery = jest.fn();

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: mockQuery,
    connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
    end: jest.fn(),
  })),
}));

const { fetchInflows, ExplorerError } = await import("../src/audit/explorerClient.js");
const { INFLOW_LOCK_ID, startInflowJob } = await import("../src/audit/inflowJob.js");
const { inflowsQuerySchema } = await import("../src/schemas/adminSchemas.js");
const { logger } = await import("../src/logger.js");

const KEY = "SECRETKEY123456";
const WALLET = "0x" + "aa".repeat(20);
const OTHER = "0x" + "bb".repeat(20);
const SENDER = "0x" + "cc".repeat(20);
const TOKEN = "0x" + "dd".repeat(20);
const OPTIONS = {
  apiKey: KEY,
  baseUrl: "https://explorer.example/v2/api",
  minIntervalMs: 0,
  backoffMs: 1,
  timeoutMs: 1000,
};
const hash = (n: number): string => "0x" + n.toString(16).padStart(64, "0");

function native(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    blockNumber: String(100 + n),
    timeStamp: String(1_700_000_000 + n),
    hash: hash(n),
    from: SENDER,
    to: WALLET,
    value: "1000000000000000001",
    isError: "0",
    ...overrides,
  };
}

const ok = (rows: unknown[]): unknown => ({ status: "1", message: "OK", result: rows });
const fetchMock = jest.fn<typeof fetch>();

function queue(...bodies: unknown[]): void {
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
  }
}

function urlOf(call: number): URL {
  return new URL(String(fetchMock.mock.calls[call]?.[0]));
}

const req = (kind: "native" | "internal" | "erc20" = "native", fromBlock = 0n) => ({
  chainId: 421614,
  wallet: WALLET,
  kind,
  fromBlock,
});

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("explorer client", () => {
  it("builds the V2 request and keeps only incoming, successful, non-zero native rows with BigInt amounts", async () => {
    queue(
      ok([
        native(1),
        native(2, { to: OTHER }),
        native(3, { isError: "1" }),
        native(4, { value: "0" }),
        native(5, { to: WALLET.toUpperCase().replace("0X", "0x"), value: "123456789012345678901234567890" }),
      ])
    );
    const result = await fetchInflows(req("native", 7n), OPTIONS);
    const url = urlOf(0);
    expect(url.searchParams.get("chainid")).toBe("421614");
    expect(url.searchParams.get("module")).toBe("account");
    expect(url.searchParams.get("action")).toBe("txlist");
    expect(url.searchParams.get("startblock")).toBe("7");
    expect(url.searchParams.get("endblock")).toBe("99999999");
    expect(url.searchParams.get("sort")).toBe("asc");
    expect(url.searchParams.get("offset")).toBe("1000");
    expect(result.entries.map((e) => e.amount)).toEqual([1000000000000000001n, 123456789012345678901234567890n]);
    expect(result.entries[0]).toMatchObject({ kind: "native", entryRef: "", tokenAddress: null, txHash: hash(1) });
    expect(result.maxBlock).toBe(105n);
    expect(result.dropped).toBe(0);
  });

  it("treats 'No transactions found' as an empty result", async () => {
    queue({ status: "0", message: "No transactions found", result: [] });
    const result = await fetchInflows(req(), OPTIONS);
    expect(result).toEqual({ entries: [], maxBlock: null, dropped: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("paginates until a page has fewer than 1000 rows", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => native(i + 1));
    queue(ok(full), ok([native(2000), native(2001)]));
    const result = await fetchInflows(req(), OPTIONS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlOf(1).searchParams.get("page")).toBe("2");
    expect(result.entries).toHaveLength(1002);
  });

  it("restarts from the last block after 10 full pages and fails when no progress is made", async () => {
    const page = (block: number): unknown[] =>
      Array.from({ length: 1000 }, (_, i) => native(block * 10_000 + i, { blockNumber: String(block) }));
    for (let i = 0; i < 10; i += 1) queue(ok(page(50)));
    for (let i = 0; i < 10; i += 1) queue(ok(page(50)));
    await expect(fetchInflows(req("native", 10n), OPTIONS)).rejects.toThrow("explorer window made no progress");
    // 10 pages in the first window, then 10 more from block 50, which stays on block 50: no progress.
    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(urlOf(10).searchParams.get("startblock")).toBe("50");
    expect(urlOf(10).searchParams.get("page")).toBe("1");
  });

  it("retries a rate limit with backoff at most 3 times", async () => {
    queue({ status: "0", message: "NOTOK", result: "Max rate limit reached" }, ok([native(1)]));
    const result = await fetchInflows(req(), OPTIONS);
    expect(result.entries).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    for (let i = 0; i < 4; i += 1) queue({ status: "0", message: "NOTOK", result: "Max rate limit reached" });
    await expect(fetchInflows(req(), OPTIONS)).rejects.toThrow("explorer rate limit persisted");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("drops invalid rows, counts them and logs no values", async () => {
    const warn = jest.spyOn(logger, "warn");
    queue(
      ok([
        native(1),
        native(2, { hash: "0x12" }),
        native(3, { value: "12.5" }),
        native(4, { from: "nope" }),
        native(5, { blockNumber: "abc" }),
        native(6, { timeStamp: undefined }),
      ])
    );
    const result = await fetchInflows(req(), OPTIONS);
    expect(result.entries).toHaveLength(1);
    expect(result.dropped).toBe(5);
    expect(JSON.stringify(warn.mock.calls)).toContain('"dropped":5');
    expect(JSON.stringify(warn.mock.calls)).not.toContain("12.5");
  });

  it("records internal transfers by traceId, with an index fallback", async () => {
    queue(ok([native(1, { traceId: "0_1" }), native(2), native(2)]));
    const result = await fetchInflows(req("internal"), OPTIONS);
    expect(urlOf(0).searchParams.get("action")).toBe("txlistinternal");
    expect(result.entries.map((e) => e.entryRef)).toEqual(["0_1", "idx:0", "idx:1"]);
  });

  it("records ERC-20 transfers with logIndex or a derived entry_ref, truncating the symbol", async () => {
    const token = (n: number, extra: Record<string, unknown>): Record<string, unknown> => ({
      ...native(n),
      contractAddress: TOKEN,
      tokenSymbol: "S".repeat(100),
      ...extra,
    });
    queue(ok([token(1, { logIndex: "7" }), token(2, {}), token(2, {}), token(3, { contractAddress: "bad" })]));
    const result = await fetchInflows(req("erc20"), OPTIONS);
    expect(urlOf(0).searchParams.get("action")).toBe("tokentx");
    const value = "1000000000000000001";
    expect(result.entries.map((e) => e.entryRef)).toEqual([
      "7",
      `${TOKEN}:${SENDER}:${value}:0`,
      `${TOKEN}:${SENDER}:${value}:1`,
    ]);
    expect(result.entries[0]?.tokenSymbol).toHaveLength(32);
    expect(result.entries[0]?.tokenAddress).toBe(TOKEN);
    expect(result.dropped).toBe(1);
  });

  it("never leaks the API key or URL in errors or logs", async () => {
    const warn = jest.spyOn(logger, "warn");
    const messages: string[] = [];
    const capture = async (): Promise<void> => {
      try {
        await fetchInflows(req(), OPTIONS);
      } catch (err) {
        expect(err).toBeInstanceOf(ExplorerError);
        messages.push(String((err as Error).message), String((err as Error).stack));
      }
    };
    fetchMock.mockRejectedValueOnce(new Error(`connect failed https://explorer.example/v2/api?apikey=${KEY}`));
    await capture();
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    await capture();
    queue({ status: "0", message: `NOTOK ${KEY}`, result: "Invalid API Key" });
    await capture();
    queue("not an object");
    await capture();
    expect(messages).toHaveLength(8);
    const all = messages.join("\n") + JSON.stringify(warn.mock.calls);
    expect(all).not.toContain(KEY);
    expect(all).not.toContain("apikey");
    expect(all).not.toContain("explorer.example");
  });

  it("fails when the explorer is not configured", async () => {
    await expect(fetchInflows(req(), null)).rejects.toThrow("explorer is not configured");
  });
});

describe("inflow job", () => {
  const base = {
    NODE_ENV: "development" as const,
    REVENUE_AUDIT_ENABLED: true,
    ETHERSCAN_API_KEY: KEY as string | undefined,
    REVENUE_AUDIT_CHAINS: [421614],
    EXPLORER_POLL_INTERVAL_MS: 900_000,
  };

  it("uses the reserved advisory lock id", () => {
    expect(INFLOW_LOCK_ID).toBe(727361004);
  });

  it("is not started under NODE_ENV=test", () => {
    expect(startInflowJob()).toBeNull();
    expect(startInflowJob({ ...base, NODE_ENV: "test" })).toBeNull();
  });

  it("is off without the flag or without the key (fail-closed)", () => {
    const info = jest.spyOn(logger, "info");
    expect(startInflowJob({ ...base, REVENUE_AUDIT_ENABLED: false })).toBeNull();
    expect(startInflowJob({ ...base, ETHERSCAN_API_KEY: undefined })).toBeNull();
    expect(info).toHaveBeenCalledWith("revenue audit disabled");
  });

  it("src/index.ts imports and calls the job and awaits its stop before pool.end()", () => {
    const text = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(text).toMatch(/import \{ startInflowJob \} from "\.\/audit\/inflowJob\.js"/);
    expect(text).toContain("const stopInflow = startInflowJob();");
    const stopAt = text.indexOf("stopInflow ? stopInflow()");
    expect(stopAt).toBeGreaterThan(text.indexOf("Promise.all(["));
    expect(stopAt).toBeLessThan(text.indexOf("pool.end()"));
  });
});

describe("admin inflows query schema", () => {
  const parse = (query: Record<string, string>) => inflowsQuerySchema.safeParse(query);

  it("applies defaults and accepts valid filters", () => {
    expect(parse({})).toMatchObject({ success: true, data: { limit: 20, offset: 0 } });
    const project = `421614:${WALLET}`;
    expect(parse({ chainId: "97", kind: "erc20", projectId: project, limit: "100", offset: "10000" })).toMatchObject({
      success: true,
      data: { chainId: 97, kind: "erc20", projectId: project },
    });
  });

  it("rejects unknown keys, bad values and out-of-range paging", () => {
    for (const query of [
      { x: "1" },
      { limit: "101" },
      { limit: "0" },
      { offset: "10001" },
      { chainId: "1" },
      { kind: "eth" },
      { projectId: "421614:0xABC" },
      { projectId: `421614:${WALLET.toUpperCase()}` },
    ]) {
      expect(parse(query).success).toBe(false);
    }
  });
});
