/**
 * Takeover case preparation (WS-11.4a): indexer /status parsing with a mocked fetch, lag check,
 * snapshot sum, eligibility rules, env parsing and route guards. No network, mocked pg.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import { ALLOWED_ORIGIN, SESSION_COOKIE_HEADER, mockSession } from "./authHelpers.js";

const mockQuery = jest.fn();

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: mockQuery,
    connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
    end: jest.fn(), on: jest.fn(),
  })),
}));

const { createApp } = await import("../src/app.js");
const { envSchema } = await import("../src/config/env.js");
const { fetchIndexedHead, lagSeconds } = await import("../src/takeover/indexerStatus.js");
const { assertFreshHead, assertProjectEligible, summariseSnapshot } = await import("../src/takeover/takeoverService.js");
const { prepareCaseBodySchema } = await import("../src/takeover/takeoverSchemas.js");

const app = createApp();
const WALLET = "0x" + "11".repeat(20);
const CASE_ID = "22222222-2222-2222-2222-222222222222";
const STATUS = { arbitrumSepolia: { id: 421614, block: { number: 500, timestamp: 1_000_000 } }, bscTestnet: { id: 97, block: { number: 9, timestamp: 5 } } };

beforeEach(() => {
  mockQuery.mockReset();
});

function fetchReturning(body: unknown, ok = true): typeof fetchIndexedHead extends (a: number, b?: string, c?: infer F) => unknown ? F : never {
  return (async () => ({ ok, json: async () => body })) as never;
}

describe("indexer status", () => {
  it("picks the entry of the requested chain and tolerates a trailing slash", async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => STATUS };
    }) as never;
    const head = await fetchIndexedHead(421614, "http://indexer:42069/", fake);
    expect(head).toEqual({ blockNumber: 500n, blockTimestamp: 1_000_000 });
    expect(calls).toEqual(["http://indexer:42069/status"]);
  });

  it("fails closed (503, safe message) when unset, unreachable, not ok, malformed or the chain is missing", async () => {
    const base = "http://indexer:42069";
    await expect(fetchIndexedHead(421614, undefined)).rejects.toMatchObject({ status: 503 });
    const boom = (async () => {
      throw new Error("ECONNREFUSED secret-host");
    }) as never;
    const unreachable = await fetchIndexedHead(421614, base, boom).catch((e: Error) => e);
    expect(unreachable).toMatchObject({ status: 503 });
    expect((unreachable as Error).message).not.toContain("secret-host");
    await expect(fetchIndexedHead(421614, base, fetchReturning(STATUS, false))).rejects.toMatchObject({ status: 503 });
    await expect(fetchIndexedHead(421614, base, fetchReturning({ x: { id: "a" } }))).rejects.toMatchObject({ status: 503 });
    await expect(fetchIndexedHead(1, base, fetchReturning(STATUS))).rejects.toMatchObject({ status: 503 });
  });

  it("computes lag and refuses a head older than the maximum", () => {
    const head = { blockNumber: 1n, blockTimestamp: 1000 };
    expect(lagSeconds(head, 1_100_000)).toBe(100);
    expect(lagSeconds(head, 500_000)).toBe(0);
    expect(assertFreshHead(head, 1_100_000, 300)).toBe(100);
    expect(() => assertFreshHead(head, 1_400_000, 300)).toThrow(expect.objectContaining({ status: 503 }));
  });
});

describe("snapshot and eligibility rules", () => {
  it("sums staked balances as bigint and flags a difference from the project total", () => {
    const holders = [
      { investor: "a", staked: 10n ** 30n, unstaked: null },
      { investor: "b", staked: 5n, unstaked: 1n },
    ];
    expect(summariseSnapshot(holders, 10n ** 30n + 5n)).toEqual({ total: 10n ** 30n + 5n, mismatch: false });
    expect(summariseSnapshot(holders, 1n).mismatch).toBe(true);
    expect(summariseSnapshot([], 0n)).toEqual({ total: 0n, mismatch: false });
  });

  it("allows only ACTIVE, non-invalidated projects and rejects the sitting developer", () => {
    const project = { id: "1:0x", chainId: 1, escrowAddress: "0x", developer: "0xdev", state: "ACTIVE", isInvalidated: false };
    expect(() => assertProjectEligible(project, "0xcand")).not.toThrow();
    for (const bad of [{ state: "SHUTDOWN" }, { state: "FUNDING" }, { isInvalidated: true }]) {
      expect(() => assertProjectEligible({ ...project, ...bad }, "0xcand")).toThrow(expect.objectContaining({ status: 409 }));
    }
    expect(() => assertProjectEligible(project, "0xdev")).toThrow(expect.objectContaining({ status: 422 }));
  });
});

describe("env and schemas", () => {
  const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };

  it("treats INDEXER_URL as optional, accepts http and strips a trailing slash; bounds the lag", () => {
    expect(envSchema.parse({ ...base, INDEXER_URL: "", TAKEOVER_MAX_LAG_SECONDS: "" })).toMatchObject({ INDEXER_URL: undefined, TAKEOVER_MAX_LAG_SECONDS: 300 });
    expect(envSchema.parse({ ...base, INDEXER_URL: "http://indexer:42069/" }).INDEXER_URL).toBe("http://indexer:42069");
    expect(envSchema.safeParse({ ...base, INDEXER_URL: "ftp://x" }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, TAKEOVER_MAX_LAG_SECONDS: "10" }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, TAKEOVER_MAX_LAG_SECONDS: "86401" }).success).toBe(false);
  });

  it("validates the prepare body strictly", () => {
    const ok = { chainId: 421614, projectAddress: WALLET.toUpperCase().replace("0X", "0x"), candidateWallet: WALLET, reason: "why", evidenceLinks: ["https://e.example"] };
    expect(prepareCaseBodySchema.parse(ok).projectAddress).toBe(WALLET);
    expect(prepareCaseBodySchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(prepareCaseBodySchema.safeParse({ ...ok, evidenceLinks: ["http://e.example"] }).success).toBe(false);
    expect(prepareCaseBodySchema.safeParse({ ...ok, evidenceLinks: Array(11).fill("https://e.example") }).success).toBe(false);
    expect(prepareCaseBodySchema.safeParse({ ...ok, reason: "x".repeat(2001) }).success).toBe(false);
  });
});

describe("route guards", () => {
  const PREPARE = "/api/v1/admin/takeover-cases";
  const send = (method: "post" | "get", url: string, role: string, body: object = {}, origin = ALLOWED_ORIGIN) => {
    mockSession(mockQuery, role, WALLET);
    const req = request(app)[method](url).set("Origin", origin).set("Cookie", SESSION_COOKIE_HEADER);
    return method === "post" ? req.send(body) : req;
  };

  it("anonymous is 401, a bad Origin is 403 and a non-staff user is 403 on every route", async () => {
    for (const url of [PREPARE, `${PREPARE}/${CASE_ID}/open`, `${PREPARE}/${CASE_ID}/cancel`]) {
      expect((await request(app).post(url).set("Origin", ALLOWED_ORIGIN).send({})).status).toBe(401);
      expect((await send("post", url, "admin", {}, "https://evil.example")).status).toBe(403);
      expect((await send("post", url, "founder")).status).toBe(403);
    }
    expect((await request(app).get(PREPARE)).status).toBe(401);
    expect((await send("get", PREPARE, "investor")).status).toBe(403);
    expect((await send("get", `${PREPARE}/${CASE_ID}`, "founder")).status).toBe(403);
  });

  it("staff may prepare (reaches validation) but only admin may open or cancel", async () => {
    expect((await send("post", PREPARE, "staff", {})).status).toBe(400);
    expect((await send("post", `${PREPARE}/${CASE_ID}/open`, "staff")).status).toBe(403);
    expect((await send("post", `${PREPARE}/${CASE_ID}/cancel`, "staff")).status).toBe(403);
    expect((await send("post", `${PREPARE}/not-a-uuid/open`, "admin")).status).toBe(400);
  });

  it("opening fails closed with 503 when INDEXER_URL is unset", async () => {
    mockSession(mockQuery, "admin", WALLET, { rows: [], rowCount: 0 }, { rows: [{ id: CASE_ID, chain_id: 421614, project_id: `421614:${WALLET}`, candidate_wallet: WALLET, candidate_user_id: CASE_ID, reason: "r", evidence_links: [], status: "prepared", created_by: CASE_ID, opened_by: null, created_at: new Date(), opened_at: null, cancelled_at: null, snapshot_block: null, snapshot_block_timestamp: null, snapshot_taken_at: null, snapshot_lag_seconds: null, snapshot_total_staked: null, snapshot_holder_count: null, candidate_accepted_at: new Date(), developer_at_open: null, ends_at: null, closed_at: null, result: null, yes_weight: null, no_weight: null, voted_weight: null, voter_count: null, quorum_percent: null, voting_ended: false }], rowCount: 1 });
    const res = await request(app).post(`${PREPARE}/${CASE_ID}/open`).set("Origin", ALLOWED_ORIGIN).set("Cookie", SESSION_COOKIE_HEADER).send({});
    expect(res.status).toBe(503);
  });

  it("the public by-project read is open and validates its params", async () => {
    expect((await request(app).get(`/api/v1/takeover-cases/by-project/abc/${WALLET}`)).status).toBe(400);
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    expect((await request(app).get(`/api/v1/takeover-cases/by-project/421614/${WALLET}`)).status).toBe(404);
  });
});
