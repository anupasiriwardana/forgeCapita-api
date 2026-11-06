/**
 * Launch draft tests. The pg module is mocked and answers are queued per test (see authHelpers),
 * so SQL itself is not executed here; statements and parameters are asserted instead.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import { ALLOWED_ORIGIN, SESSION_COOKIE_HEADER, mockSession } from "./authHelpers.js";

const mockQuery = jest.fn();

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: mockQuery,
    connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
    end: jest.fn(),
  })),
}));

const { createApp } = await import("../src/app.js");
const { reconcileDrafts, startReconcileJob } = await import("../src/drafts/reconcile.js");
const app = createApp();

const ADDRESS = "0x" + "11".repeat(20);
const ESCROW = "0x" + "AB".repeat(20);
const ESCROW_LOWER = ESCROW.toLowerCase();
const DRAFT_ID = "dddddddd-0000-4000-8000-000000000001";
const WALLET_ID = "bbbbbbbb-0000-4000-8000-000000000001";
const USER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_USER_ID = "22222222-2222-2222-2222-222222222222";

const validBody = { chainId: 421614, name: "Acme", description: "A SaaS", shadowWalletId: WALLET_ID };

beforeEach(() => {
  mockQuery.mockReset();
});

function post(path: string, body: unknown) {
  return request(app).post(path).set("Origin", ALLOWED_ORIGIN).set("Cookie", SESSION_COOKIE_HEADER).send(body as object);
}

function draftRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: DRAFT_ID,
    user_id: USER_ID,
    status: "pending",
    chain_id: 421614,
    founder_wallet_id: WALLET_ID,
    escrow_address: null,
    project_id: null,
    name: "Acme",
    created_at: new Date(1_700_000_000_000),
    applied_at: null,
    ...overrides,
  };
}

function checks(a: boolean, g: boolean, w: boolean) {
  return { rows: [{ application_approved: a, agreement_accepted: g, shadow_wallet_available: w }], rowCount: 1 };
}

function walletRow(overrides: Record<string, unknown> = {}) {
  return {
    rows: [{ id: WALLET_ID, user_id: USER_ID, address: "0x" + "ab".repeat(20), reserved: false, bound: false, ...overrides }],
    rowCount: 1,
  };
}

const rows = (...r: Array<Record<string, unknown>>) => ({ rows: r, rowCount: r.length });
const none = { rows: [], rowCount: 0 };
const reconcileOk = { rows: [{ applied: "0", conflicts: "0" }], rowCount: 1 };

describe("RBAC and validation", () => {
  it("rejects anonymous callers and investors", async () => {
    const paths = [
      ["/api/v1/launch-drafts", validBody],
      [`/api/v1/launch-drafts/${DRAFT_ID}/attach`, { escrowAddress: ESCROW }],
      [`/api/v1/launch-drafts/${DRAFT_ID}/cancel`, {}],
    ] as const;
    for (const [path, body] of paths) {
      expect((await request(app).post(path).set("Origin", ALLOWED_ORIGIN).send(body)).status).toBe(401);
    }
    expect((await request(app).get("/api/v1/launch-drafts/mine")).status).toBe(401);
    mockSession(mockQuery, "investor", ADDRESS);
    for (const [path, body] of paths) {
      expect((await post(path, body)).status).toBe(403);
    }
  });

  it("rejects unknown keys, bad chain and non-https-looking URLs", async () => {
    mockSession(mockQuery, "staff", ADDRESS);
    for (const body of [
      { ...validBody, extra: 1 },
      { ...validBody, projectId: "421614:" + ESCROW },
      { ...validBody, chainId: 1 },
      { ...validBody, logoUrl: "javascript:alert(1)" },
      { ...validBody, name: "" },
    ]) {
      expect((await post("/api/v1/launch-drafts", body)).status).toBe(400);
    }
    expect((await post(`/api/v1/launch-drafts/${DRAFT_ID}/attach`, { escrowAddress: "0x12" })).status).toBe(400);
    expect((await post("/api/v1/launch-drafts/not-a-uuid/cancel", {})).status).toBe(400);
  });
});

describe("POST /api/v1/launch-drafts", () => {
  it("returns 403 when the founder is not eligible", async () => {
    mockSession(mockQuery, "founder", ADDRESS, checks(false, true, true));
    expect((await post("/api/v1/launch-drafts", validBody)).status).toBe(403);
    mockSession(mockQuery, "founder", ADDRESS, checks(true, false, true));
    expect((await post("/api/v1/launch-drafts", validBody)).status).toBe(403);
    mockSession(mockQuery, "founder", ADDRESS, checks(true, true, false));
    expect((await post("/api/v1/launch-drafts", validBody)).status).toBe(403);
  });

  it("requires a shadow wallet for founders", async () => {
    mockSession(mockQuery, "founder", ADDRESS, checks(true, true, true));
    const { shadowWalletId: _omit, ...withoutWallet } = validBody;
    expect((await post("/api/v1/launch-drafts", withoutWallet)).status).toBe(400);
  });

  it("returns 400 for unknown, unapproved or foreign wallets", async () => {
    mockSession(mockQuery, "founder", ADDRESS, checks(true, true, true), none);
    expect((await post("/api/v1/launch-drafts", validBody)).status).toBe(400);
    mockSession(mockQuery, "founder", ADDRESS, checks(true, true, true), walletRow({ user_id: OTHER_USER_ID }));
    const res = await post("/api/v1/launch-drafts", validBody);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Shadow wallet not available");
  });

  it("returns 409 when the wallet is reserved, bound, or the reservation index is hit", async () => {
    mockSession(mockQuery, "founder", ADDRESS, checks(true, true, true), walletRow({ reserved: true }));
    expect((await post("/api/v1/launch-drafts", validBody)).status).toBe(409);
    mockSession(mockQuery, "founder", ADDRESS, checks(true, true, true), walletRow({ bound: true }));
    expect((await post("/api/v1/launch-drafts", validBody)).status).toBe(409);
    const violation = Object.assign(new Error("duplicate"), {
      code: "23505",
      constraint: "launch_drafts_active_wallet_uidx",
    });
    mockSession(mockQuery, "founder", ADDRESS, checks(true, true, true), walletRow(), violation);
    expect((await post("/api/v1/launch-drafts", validBody)).status).toBe(409);
  });

  it("creates a draft with an audit-bearing single statement", async () => {
    const calls = mockSession(mockQuery, "founder", ADDRESS, checks(true, true, true), walletRow(), rows(draftRow()));
    const res = await post("/api/v1/launch-drafts", validBody);
    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.data).toEqual({
      draft: {
        id: DRAFT_ID,
        status: "pending",
        chainId: 421614,
        shadowWalletId: WALLET_ID,
        createdAt: "2023-11-14T22:13:20.000Z",
      },
    });
    const [sql, params] = calls()[2] as [string, unknown[]];
    expect(sql).toContain("'launch_draft.create'");
    expect(params[1]).toBe(ADDRESS);
    expect(params[3]).toBe(WALLET_ID);
    expect(JSON.parse(params[4] as string)).toEqual({ name: "Acme", description: "A SaaS" });
  });

  it.each(["staff", "admin"])("lets %s create a draft without a wallet or eligibility", async (role) => {
    const calls = mockSession(mockQuery, role, ADDRESS, rows(draftRow({ founder_wallet_id: null })));
    const { shadowWalletId: _omit, ...withoutWallet } = validBody;
    const res = await post("/api/v1/launch-drafts", withoutWallet);
    expect(res.status).toBe(201);
    expect(calls()).toHaveLength(1);
    expect((calls()[0] as [string, unknown[]])[1][3]).toBeNull();
  });
});

describe("POST /api/v1/launch-drafts/:id/attach", () => {
  const attachedRow = draftRow({ status: "attached", escrow_address: ESCROW_LOWER, project_id: `421614:${ESCROW_LOWER}` });

  it("attaches for the owner, lowercases the escrow and reconciles once", async () => {
    const calls = mockSession(mockQuery, "founder", ADDRESS, rows(attachedRow), reconcileOk, rows(attachedRow));
    const res = await post(`/api/v1/launch-drafts/${DRAFT_ID}/attach`, { escrowAddress: ESCROW });
    expect(res.status).toBe(200);
    expect(res.body.data.draft).toMatchObject({ status: "attached", projectId: `421614:${ESCROW_LOWER}`, escrowAddress: ESCROW_LOWER });
    const [attachSql, attachParams] = calls()[0] as [string, unknown[]];
    expect(attachSql).toContain("status = 'pending'");
    expect(attachParams).toEqual([DRAFT_ID, USER_ID, ESCROW_LOWER]);
    expect((calls()[1] as [string, unknown[]])[1]).toEqual([DRAFT_ID]);
  });

  it("returns 404 for another user's draft", async () => {
    mockSession(mockQuery, "founder", ADDRESS, none, none);
    expect((await post(`/api/v1/launch-drafts/${DRAFT_ID}/attach`, { escrowAddress: ESCROW })).status).toBe(404);
  });

  it("is idempotent for the same escrow and 409 for a different one", async () => {
    mockSession(mockQuery, "founder", ADDRESS, none, rows(attachedRow), reconcileOk, rows(attachedRow));
    expect((await post(`/api/v1/launch-drafts/${DRAFT_ID}/attach`, { escrowAddress: ESCROW })).status).toBe(200);
    mockSession(mockQuery, "founder", ADDRESS, none, rows(attachedRow));
    expect((await post(`/api/v1/launch-drafts/${DRAFT_ID}/attach`, { escrowAddress: "0x" + "cd".repeat(20) })).status).toBe(409);
  });

  it("returns 409 when the project is attached to another draft", async () => {
    const violation = Object.assign(new Error("duplicate"), { code: "23505", constraint: "launch_drafts_project_uidx" });
    mockSession(mockQuery, "founder", ADDRESS, violation);
    const res = await post(`/api/v1/launch-drafts/${DRAFT_ID}/attach`, { escrowAddress: ESCROW });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Project already attached to another draft");
  });

  it("still succeeds when the best-effort reconcile fails", async () => {
    mockSession(mockQuery, "founder", ADDRESS, rows(attachedRow), new Error("db down"), rows(attachedRow));
    expect((await post(`/api/v1/launch-drafts/${DRAFT_ID}/attach`, { escrowAddress: ESCROW })).status).toBe(200);
  });
});

describe("POST /api/v1/launch-drafts/:id/cancel", () => {
  it("cancels a pending draft with an audit row", async () => {
    const calls = mockSession(mockQuery, "founder", ADDRESS, rows(draftRow({ status: "cancelled" })));
    const res = await post(`/api/v1/launch-drafts/${DRAFT_ID}/cancel`, {});
    expect(res.status).toBe(200);
    expect(res.body.data.draft.status).toBe("cancelled");
    expect((calls()[0] as [string])[0]).toContain("'launch_draft.cancel'");
  });

  it("returns 409 once attached and 404 for foreign drafts", async () => {
    mockSession(mockQuery, "founder", ADDRESS, none, rows(draftRow({ status: "attached" })));
    const res = await post(`/api/v1/launch-drafts/${DRAFT_ID}/cancel`, {});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Draft already attached");
    mockSession(mockQuery, "founder", ADDRESS, none, none);
    expect((await post(`/api/v1/launch-drafts/${DRAFT_ID}/cancel`, {})).status).toBe(404);
  });
});

describe("GET /api/v1/launch-drafts/mine", () => {
  it("lists the caller's drafts without echoing the payload", async () => {
    const calls = mockSession(mockQuery, "investor", ADDRESS, rows(draftRow()));
    const res = await request(app).get("/api/v1/launch-drafts/mine").set("Cookie", SESSION_COOKIE_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([
      {
        id: DRAFT_ID,
        status: "pending",
        chainId: 421614,
        projectId: null,
        escrowAddress: null,
        name: "Acme",
        createdAt: "2023-11-14T22:13:20.000Z",
        appliedAt: null,
      },
    ]);
    const [sql, params] = calls()[0] as [string, unknown[]];
    expect(sql).toContain("LIMIT 20");
    expect(params).toEqual([USER_ID]);
  });
});

describe("reconcile", () => {
  it("applies matched drafts in one statement and expires stale pending drafts", async () => {
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ applied: "1", conflicts: "0" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 });
    const result = await reconcileDrafts();
    expect(result).toEqual({ applied: 1, conflicts: 0, expired: 2 });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("FOR UPDATE OF d SKIP LOCKED");
    expect(sql).toContain('"project"');
    expect(sql).toContain("lower(p.\"developer\") = d.wallet_address");
    expect(sql).toContain("'launch_draft.apply'");
    expect(sql).toContain("'launch_draft.conflict'");
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(params).toEqual([null]);
    expect((mockQuery.mock.calls[1] as [string])[0]).toContain("status = 'expired'");
  });

  it("reports conflicts and skips expiry for a single draft", async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [{ applied: "0", conflicts: "1" }], rowCount: 1 });
    expect(await reconcileDrafts({ draftId: DRAFT_ID })).toEqual({ applied: 0, conflicts: 1, expired: 0 });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect((mockQuery.mock.calls[0] as [string, unknown[]])[1]).toEqual([DRAFT_ID]);
  });

  it("does not schedule the job under NODE_ENV=test", () => {
    expect(startReconcileJob()).toBeNull();
  });
});
