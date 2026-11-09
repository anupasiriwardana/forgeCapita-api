/**
 * Admin read endpoints (audit log, launch drafts, relay requests) and the public relay status.
 * The pg module is mocked; the SQL itself is covered by tests/integration/adminReads.itest.ts.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import { SESSION_COOKIE_HEADER, mockSession } from "./authHelpers.js";

const mockQuery = jest.fn();

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: mockQuery,
    connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
    end: jest.fn(),
  })),
}));

const { createApp } = await import("../src/app.js");
const { registerRelayChain, clearRelayChains } = await import("../src/relay/chains.js");
const { resetRelayStatusCache } = await import("../src/relay/relayStatus.js");
const app = createApp();

const ADDRESS = "0x" + "11".repeat(20);
const RELAYER = "0x" + "99".repeat(20);
const USER_ID = "11111111-1111-1111-1111-111111111111";
const FORBIDDEN_KEYS = ["args", "payload", "signature", "calldata", "privateKey"];

const PATHS = ["/api/v1/admin/audit-log", "/api/v1/admin/launch-drafts", "/api/v1/admin/relay-requests"];

const auditRow = {
  id: "7",
  actor_user_id: USER_ID,
  action: "role.change",
  target: ADDRESS,
  before_value: "investor",
  after_value: "staff",
  ip: "1.2.3.4",
  created_at: new Date(1_700_000_000_000),
};
const draftRow = {
  id: USER_ID,
  user_id: USER_ID,
  status: "pending",
  chain_id: 421614,
  founder_wallet_id: null,
  escrow_address: null,
  project_id: null,
  name: "Acme",
  created_at: new Date(1_700_000_000_000),
  applied_at: null,
  wallet_address: ADDRESS,
};
const relayRow = {
  id: USER_ID,
  kind: "execute",
  chain_id: 97,
  project_id: `97:${ADDRESS}`,
  status: "FAILED",
  error_code: "SELF_PAY",
  error_message: "m",
  tx_hash: null,
  gas_used: null,
  effective_gas_price: null,
  created_at: new Date(1_700_000_000_000),
  sent_at: null,
  confirmed_at: null,
  expires_at: new Date(1_700_000_100_000),
  user_id: null,
  account: ADDRESS,
};

function get(path: string, signedIn = true) {
  const req = request(app).get(path);
  return signedIn ? req.set("Cookie", SESSION_COOKIE_HEADER) : req;
}

function collectKeys(value: unknown, keys: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => collectKeys(v, keys));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      keys.add(k);
      collectKeys(v, keys);
    }
  }
  return keys;
}

beforeEach(() => {
  mockQuery.mockReset();
  clearRelayChains();
  resetRelayStatusCache();
});

describe("admin read endpoints access control and validation", () => {
  it("answers 401 signed out", async () => {
    for (const path of PATHS) expect((await get(path, false)).status).toBe(401);
  });

  it("answers 403 to investors and founders", async () => {
    for (const role of ["investor", "founder"]) {
      for (const path of PATHS) {
        mockSession(mockQuery, role, ADDRESS);
        expect((await get(path)).status).toBe(403);
      }
    }
  });

  it("rejects unknown keys, bad enums and out-of-range paging with 400", async () => {
    const bad: Record<string, string[]> = {
      "/api/v1/admin/audit-log": ["x=1", "limit=101", "offset=10001", "action=Role.Change", "target=0xABC", "actor=nope"],
      "/api/v1/admin/launch-drafts": ["x=1", "limit=101", "offset=10001", "status=done", "chainId=1", "userId=nope"],
      "/api/v1/admin/relay-requests": [
        "x=1",
        "limit=0",
        "offset=10001",
        "kind=mint",
        "status=queued",
        "chainId=1",
        "system=false",
        "projectId=nope",
      ],
    };
    for (const [path, queries] of Object.entries(bad)) {
      for (const query of queries) {
        mockSession(mockQuery, "staff", ADDRESS);
        expect((await get(`${path}?${query}`)).status).toBe(400);
      }
    }
  });
});

describe("admin read endpoints responses", () => {
  it("serves the audit log to staff with the envelope and no extra fields", async () => {
    mockSession(mockQuery, "staff", ADDRESS, { rows: [auditRow] }, { rows: [{ total: "1" }] });
    const res = await get(`/api/v1/admin/audit-log?action=role.change&target=${ADDRESS}&actor=aaaaaaaa-0000-4000-8000-000000000001`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({
      success: true,
      data: {
        items: [
          {
            id: "7",
            actorUserId: USER_ID,
            action: "role.change",
            target: ADDRESS,
            before: "investor",
            after: "staff",
            ip: "1.2.3.4",
            createdAt: "2023-11-14T22:13:20.000Z",
          },
        ],
        total: 1,
        limit: 20,
        offset: 0,
      },
    });
  });

  it("serves launch drafts to admin without any payload content", async () => {
    mockSession(mockQuery, "admin", ADDRESS, { rows: [draftRow] }, { rows: [{ total: "1" }] });
    const res = await get("/api/v1/admin/launch-drafts?status=pending&chainId=421614");
    expect(res.status).toBe(200);
    expect(res.body.data.items[0]).toMatchObject({ walletAddress: ADDRESS, name: "Acme", appliedAt: null });
    expect(res.body.data.total).toBe(1);
    const keys = collectKeys(res.body);
    for (const key of FORBIDDEN_KEYS) expect(keys.has(key)).toBe(false);
  });

  it("serves relay requests to staff without args or payload", async () => {
    const calls = mockSession(mockQuery, "staff", ADDRESS, { rows: [relayRow] }, { rows: [{ total: "1" }] });
    const res = await get(`/api/v1/admin/relay-requests?system=true&chainId=97&projectId=97:${ADDRESS}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items[0]).toMatchObject({ kind: "execute", userId: null, account: ADDRESS, chainId: 97 });
    const keys = collectKeys(res.body);
    for (const key of FORBIDDEN_KEYS) expect(keys.has(key)).toBe(false);
    for (const [sql] of calls()) expect(String(sql)).not.toMatch(/\bargs\b|\bpayload\b/);
    expect(calls()[0]?.[1]).toEqual([null, null, 97, true, `97:${ADDRESS}`, 20, 0]);
  });
});

function fakeChain(chainId: number, getBalance: () => Promise<bigint>, minBalanceWei = 1000n): void {
  registerRelayChain({
    chainId,
    provider: { getBalance } as never,
    sender: { address: RELAYER, getNonce: async () => 0, send: async () => "0x" } as never,
    maxGasPriceWei: 1n,
    minBalanceWei,
  });
}

describe("GET /api/v1/relay/status", () => {
  it("is public, no-store and reports disabled when no chain is registered", async () => {
    const res = await get("/api/v1/relay/status", false);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({
      success: true,
      data: { enabled: false, chains: [{ chainId: 421614, enabled: false }, { chainId: 97, enabled: false }] },
    });
  });

  it("buckets the balance and never leaks an address for a disabled chain or the exact balance", async () => {
    fakeChain(421614, async () => 999n);
    fakeChain(97, async () => 5000n);
    let res = await get("/api/v1/relay/status", false);
    expect(res.body.data.chains).toEqual([
      { chainId: 421614, enabled: true, relayerAddress: RELAYER, balance: "low" },
      { chainId: 97, enabled: true, relayerAddress: RELAYER, balance: "ok" },
    ]);
    expect(JSON.stringify(res.body)).not.toContain("5000");

    resetRelayStatusCache();
    clearRelayChains();
    fakeChain(421614, async () => 0n);
    res = await get("/api/v1/relay/status", false);
    expect(res.body.data.enabled).toBe(true);
    expect(res.body.data.chains[0].balance).toBe("empty");
    expect(res.body.data.chains[1]).toEqual({ chainId: 97, enabled: false });
  });

  it("caches per chain so a second call does not hit the provider", async () => {
    const getBalance = jest.fn(async () => 5000n);
    fakeChain(421614, getBalance);
    await get("/api/v1/relay/status", false);
    await get("/api/v1/relay/status", false);
    expect(getBalance).toHaveBeenCalledTimes(1);
  });

  it("reports unknown (not 500) when the RPC fails", async () => {
    fakeChain(421614, async () => {
      throw new Error("rpc down");
    });
    const res = await get("/api/v1/relay/status", false);
    expect(res.status).toBe(200);
    expect(res.body.data.chains[0].balance).toBe("unknown");
  });
});
