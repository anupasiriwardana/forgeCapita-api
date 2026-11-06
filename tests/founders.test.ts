/**
 * Founder agreement, shadow wallet and launch-eligibility tests. The pg module is mocked
 * and answers are queued per test (see authHelpers), so SQL itself is not executed here.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import { Wallet, getAddress } from "ethers";
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
const { buildAgreementMessage, loadAgreement } = await import("../src/founders/agreement.js");
const app = createApp();

const founder = new Wallet("0x" + "00".repeat(31) + "03");
const other = new Wallet("0x" + "00".repeat(31) + "04");
const SESSION_USER_ID = "11111111-1111-1111-1111-111111111111";
const WALLET_ID = "bbbbbbbb-0000-4000-8000-000000000001";
const SHADOW = "0x" + "ab".repeat(20);

beforeEach(() => {
  mockQuery.mockReset();
});

function issuedNow(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function signedBody(
  signer: Wallet,
  overrides: { typedName?: string; issuedAt?: string; signedName?: string } = {}
): Promise<{ typedName: string; issuedAt: string; signature: string }> {
  const issuedAt = overrides.issuedAt ?? issuedNow();
  const message = buildAgreementMessage({
    name: overrides.signedName ?? overrides.typedName ?? "Ada Founder",
    wallet: getAddress(founder.address),
    issuedAt,
  });
  return { typedName: overrides.typedName ?? "Ada Founder", issuedAt, signature: await signer.signMessage(message) };
}

function post(path: string, body: unknown) {
  return request(app).post(path).set("Origin", ALLOWED_ORIGIN).set("Cookie", SESSION_COOKIE_HEADER).send(body as object);
}

function walletRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: WALLET_ID,
    user_id: "22222222-2222-2222-2222-222222222222",
    founder_wallet: founder.address.toLowerCase(),
    address: SHADOW,
    status: "pending",
    review_note: null,
    reviewed_by: null,
    reviewed_at: null,
    created_at: new Date(1_700_000_000_000),
    ...overrides,
  };
}

describe("GET /api/v1/agreement", () => {
  it("is public and pins the message template format", async () => {
    const res = await request(app).get("/api/v1/agreement");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const { textHash, text } = loadAgreement();
    expect(res.body.data).toEqual({
      version: "0.1",
      textHash,
      text,
      messageTemplate: [
        "ForgeCapita Revenue Share Agreement",
        "Version: 0.1",
        `Agreement SHA-256: ${textHash}`,
        "Name: {name}",
        "Wallet: {wallet}",
        "Issued At: {issuedAt}",
      ].join("\n"),
    });
    expect(text.split("\n")[0]).toBe("DRAFT - not legal advice - to be reviewed by a qualified lawyer before production use");
  });
});

describe("RBAC", () => {
  it("rejects anonymous callers and wrong roles", async () => {
    const paths: Array<[string, string, object]> = [
      ["post", "/api/v1/founders/me/agreement", { typedName: "Ada", issuedAt: issuedNow(), signature: "0x" + "1".repeat(130) }],
      ["post", "/api/v1/founders/me/shadow-wallet", { address: SHADOW }],
      ["get", "/api/v1/founders/me", {}],
      ["get", "/api/v1/founders/me/launch-eligibility", {}],
      ["get", "/api/v1/admin/shadow-wallets", {}],
      ["post", `/api/v1/admin/shadow-wallets/${WALLET_ID}/approve`, {}],
      ["post", `/api/v1/admin/shadow-wallets/${WALLET_ID}/reject`, { note: "no" }],
    ];
    const send = (method: string, path: string, body: object, cookie: boolean) => {
      const req = method === "post" ? request(app).post(path).set("Origin", ALLOWED_ORIGIN) : request(app).get(path);
      return (cookie ? req.set("Cookie", SESSION_COOKIE_HEADER) : req).send(method === "post" ? body : undefined);
    };

    for (const [method, path, body] of paths) {
      expect((await send(method, path, body, false)).status).toBe(401);
    }
    mockSession(mockQuery, "investor", founder.address);
    for (const [method, path, body] of paths) {
      const expected = path.endsWith("launch-eligibility") ? 200 : 403;
      expect((await send(method, path, body, true)).status).toBe(expected);
    }
    mockSession(mockQuery, "founder", founder.address);
    for (const [method, path, body] of paths.filter(([, p]) => p.includes("/admin/"))) {
      expect((await send(method, path, body, true)).status).toBe(403);
    }
  });
});

describe("POST /api/v1/founders/me/agreement", () => {
  const acceptedRow = { agreement_version: "0.1", text_hash: "a".repeat(64), accepted_at: new Date(1_700_000_000_000) };

  it("stores a valid signature with an audit-bearing single statement", async () => {
    const dataCalls = mockSession(mockQuery, "founder", founder.address, { rows: [acceptedRow], rowCount: 1 });
    const res = await post("/api/v1/founders/me/agreement", await signedBody(founder));
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ version: "0.1", textHash: "a".repeat(64), acceptedAt: "2023-11-14T22:13:20.000Z" });
    const calls = dataCalls();
    expect(calls).toHaveLength(1);
    const [sql, params] = calls[0] as [string, unknown[]];
    expect(sql).toContain("'agreement.accept'");
    expect(params[1]).toBe(founder.address.toLowerCase());
    expect(params[2]).toBe("0.1");
  });

  it("returns 409 on replay (unique violation)", async () => {
    mockSession(mockQuery, "founder", founder.address, Object.assign(new Error("dup"), { code: "23505" }));
    const res = await post("/api/v1/founders/me/agreement", await signedBody(founder));
    expect(res.status).toBe(409);
  });

  it("rejects stale and future issuedAt, wrong signer and tampered name without touching the database", async () => {
    const dataCalls = mockSession(mockQuery, "founder", founder.address);
    expect((await post("/api/v1/founders/me/agreement", await signedBody(founder, { issuedAt: issuedNow(-11 * 60_000) }))).status).toBe(400);
    expect((await post("/api/v1/founders/me/agreement", await signedBody(founder, { issuedAt: issuedNow(11 * 60_000) }))).status).toBe(400);
    expect((await post("/api/v1/founders/me/agreement", await signedBody(other))).status).toBe(400);
    expect((await post("/api/v1/founders/me/agreement", await signedBody(founder, { typedName: "Mallory", signedName: "Ada Founder" }))).status).toBe(400);
    expect(dataCalls()).toHaveLength(0);
  });

  it("rejects unknown keys and malformed fields", async () => {
    mockSession(mockQuery, "founder", founder.address);
    const good = await signedBody(founder);
    for (const body of [
      { ...good, extra: 1 },
      { ...good, typedName: "A" },
      { ...good, issuedAt: "yesterday" },
      { ...good, signature: "0x12" },
    ]) {
      expect((await post("/api/v1/founders/me/agreement", body)).status).toBe(400);
    }
  });
});

describe("shadow wallet", () => {
  it("requests a wallet, normalising the address and auditing the founder wallet", async () => {
    const dataCalls = mockSession(mockQuery, "founder", founder.address, { rows: [walletRow()], rowCount: 1 });
    const ok = await post("/api/v1/founders/me/shadow-wallet", { address: "0x" + "AB".repeat(20) });
    expect(ok.status).toBe(201);
    expect(ok.body.data.shadowWallet).toEqual({ id: WALLET_ID, address: SHADOW, status: "pending", reviewNote: null });
    const [sql, params] = dataCalls()[0] as [string, unknown[]];
    expect(sql).toContain("'shadow_wallet.request'");
    expect(params[1]).toBe(founder.address.toLowerCase());
    expect(params[2]).toBe(SHADOW);
  });

  it("rejects the zero address, bad input and duplicates", async () => {
    mockSession(mockQuery, "founder", founder.address);
    expect((await post("/api/v1/founders/me/shadow-wallet", { address: "0x" + "00".repeat(20) })).status).toBe(400);
    expect((await post("/api/v1/founders/me/shadow-wallet", { address: "nope" })).status).toBe(400);
    expect((await post("/api/v1/founders/me/shadow-wallet", { address: SHADOW, extra: 1 })).status).toBe(400);
    mockSession(mockQuery, "founder", founder.address, Object.assign(new Error("dup"), { code: "23505" }));
    expect((await post("/api/v1/founders/me/shadow-wallet", { address: SHADOW })).status).toBe(409);
  });

  it("allows a new request after a rejection (insert is attempted again)", async () => {
    const dataCalls = mockSession(
      mockQuery,
      "founder",
      founder.address,
      { rows: [walletRow({ status: "rejected" })], rowCount: 1 },
      { rows: [walletRow()], rowCount: 1 }
    );
    expect((await post("/api/v1/founders/me/shadow-wallet", { address: SHADOW })).status).toBe(201);
    expect((await post("/api/v1/founders/me/shadow-wallet", { address: SHADOW })).status).toBe(201);
    expect(dataCalls()).toHaveLength(2);
  });

  it("approves and rejects as staff, with audit parameters", async () => {
    const outcome = { id: WALLET_ID, user_id: "22222222-2222-2222-2222-222222222222", transitioned: true };
    const dataCalls = mockSession(
      mockQuery,
      "staff",
      other.address,
      { rows: [outcome], rowCount: 1 },
      { rows: [walletRow({ status: "approved" })], rowCount: 1 },
      { rows: [outcome], rowCount: 1 },
      { rows: [walletRow({ status: "rejected", review_note: "bad" })], rowCount: 1 }
    );
    const approved = await post(`/api/v1/admin/shadow-wallets/${WALLET_ID}/approve`, {});
    expect(approved.status).toBe(200);
    expect(approved.body.data.shadowWallet.status).toBe("approved");
    const rejected = await post(`/api/v1/admin/shadow-wallets/${WALLET_ID}/reject`, { note: "bad" });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.shadowWallet.reviewNote).toBe("bad");
    const calls = dataCalls();
    expect((calls[0] as [string, unknown[]])[1].slice(0, 3)).toEqual([WALLET_ID, SESSION_USER_ID, "approved"]);
    expect((calls[2] as [string, unknown[]])[1].slice(0, 3)).toEqual([WALLET_ID, SESSION_USER_ID, "rejected"]);
    expect((calls[0] as [string, unknown[]])[0]).toContain("'shadow_wallet.'");
  });

  it("maps review edge cases: self-review 403, unknown 404, not pending 409, address clash 409, note required", async () => {
    mockSession(
      mockQuery,
      "staff",
      other.address,
      { rows: [{ id: WALLET_ID, user_id: SESSION_USER_ID, transitioned: false }], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [{ id: WALLET_ID, user_id: "22222222-2222-2222-2222-222222222222", transitioned: false }], rowCount: 1 },
      Object.assign(new Error("dup"), { code: "23505" })
    );
    const url = `/api/v1/admin/shadow-wallets/${WALLET_ID}`;
    expect((await post(`${url}/approve`, {})).status).toBe(403);
    expect((await post(`${url}/approve`, {})).status).toBe(404);
    expect((await post(`${url}/approve`, {})).status).toBe(409);
    expect((await post(`${url}/approve`, {})).status).toBe(409);
    expect((await post(`${url}/reject`, {})).status).toBe(400);
    expect((await post(`/api/v1/admin/shadow-wallets/not-a-uuid/approve`, {})).status).toBe(400);
  });

  it("lists with bounded pagination", async () => {
    const dataCalls = mockSession(
      mockQuery,
      "admin",
      other.address,
      { rows: [walletRow()], rowCount: 1 },
      { rows: [{ total: "1" }], rowCount: 1 }
    );
    const res = await request(app).get("/api/v1/admin/shadow-wallets?status=pending").set("Cookie", SESSION_COOKIE_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ total: 1, limit: 20, offset: 0 });
    expect(res.body.data.items[0].founderWallet).toBe(founder.address.toLowerCase());
    expect(dataCalls()).toHaveLength(2);
    expect((await request(app).get("/api/v1/admin/shadow-wallets?limit=101").set("Cookie", SESSION_COOKIE_HEADER)).status).toBe(400);
    expect((await request(app).get("/api/v1/admin/shadow-wallets?x=1").set("Cookie", SESSION_COOKIE_HEADER)).status).toBe(400);
  });
});

describe("GET /api/v1/founders/me", () => {
  it("returns the agreement and latest shadow wallet, or nulls", async () => {
    mockSession(
      mockQuery,
      "founder",
      founder.address,
      { rows: [{ agreement_version: "0.1", text_hash: "a".repeat(64), accepted_at: new Date(1_700_000_000_000) }], rowCount: 1 },
      { rows: [walletRow()], rowCount: 1 }
    );
    const res = await request(app).get("/api/v1/founders/me").set("Cookie", SESSION_COOKIE_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      agreement: { version: "0.1", acceptedAt: "2023-11-14T22:13:20.000Z" },
      shadowWallet: { id: WALLET_ID, address: SHADOW, status: "pending", reviewNote: null },
    });
    mockSession(mockQuery, "founder", founder.address);
    const empty = await request(app).get("/api/v1/founders/me").set("Cookie", SESSION_COOKIE_HEADER);
    expect(empty.body.data).toEqual({ agreement: null, shadowWallet: null });
  });
});

describe("GET /api/v1/founders/me/launch-eligibility", () => {
  const cases: Array<[boolean, boolean, boolean, boolean]> = [
    [true, true, true, true],
    [true, true, false, false],
    [true, false, true, false],
    [false, true, true, false],
    [false, false, false, false],
  ];

  it.each(cases)("app=%s agreement=%s wallet=%s -> eligible=%s", async (a, b, c, eligible) => {
    mockSession(mockQuery, "founder", founder.address, {
      rows: [{ application_approved: a, agreement_accepted: b, shadow_wallet_approved: c }],
      rowCount: 1,
    });
    const res = await request(app).get("/api/v1/founders/me/launch-eligibility").set("Cookie", SESSION_COOKIE_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      eligible,
      checks: { applicationApproved: a, agreementAccepted: b, shadowWalletApproved: c },
    });
  });

  it("gives a plain investor all false", async () => {
    mockSession(mockQuery, "investor", founder.address, {
      rows: [{ application_approved: false, agreement_accepted: false, shadow_wallet_approved: false }],
      rowCount: 1,
    });
    const res = await request(app).get("/api/v1/founders/me/launch-eligibility").set("Cookie", SESSION_COOKIE_HEADER);
    expect(res.body.data).toEqual({
      eligible: false,
      checks: { applicationApproved: false, agreementAccepted: false, shadowWalletApproved: false },
    });
  });
});
