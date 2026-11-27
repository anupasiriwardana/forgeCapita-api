/**
 * Founder auto-approval (FOUNDER_APPROVAL=AUTO, testing aid). The mode is assigned before the app is
 * imported (config is parsed at import). The pg module is mocked and answers are queued per test
 * (see authHelpers), so SQL itself is not executed here; MANUAL behaviour is covered by
 * tests/applications.test.ts and tests/founders.test.ts.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import { Wallet } from "ethers";
import { ALLOWED_ORIGIN, SESSION_COOKIE_HEADER, mockSession } from "./authHelpers.js";

process.env["FOUNDER_APPROVAL"] = "AUTO";

const mockQuery = jest.fn();

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: mockQuery,
    connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
    end: jest.fn(), on: jest.fn(),
  })),
}));

const { envSchema } = await import("../src/config/env.js");
const { createApp } = await import("../src/app.js");
const app = createApp();

const applicant = new Wallet("0x" + "00".repeat(31) + "03");
const SESSION_USER_ID = "11111111-1111-1111-1111-111111111111";
const APP_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const WALLET_ID = "bbbbbbbb-0000-4000-8000-000000000001";
const SHADOW = "0x" + "ab".repeat(20);
const NOTE = "Auto-approved (testing mode)";

const APPLICATION_BODY = {
  resumeUrl: "https://drive.google.com/file/d/1resume/view?usp=sharing",
  about: "I have built and shipped subscription software for six years and want to launch my own.",
  githubUrl: "https://github.com/jane-doe",
  kycDocsUrl: "https://drive.google.com/drive/folders/1AbC?usp=sharing",
};

beforeEach(() => {
  mockQuery.mockReset();
});

function post(path: string, body: unknown) {
  return request(app).post(path).set("Origin", ALLOWED_ORIGIN).set("Cookie", SESSION_COOKIE_HEADER).send(body as object);
}

function approvedApplicationRow(roleChanged: boolean): Record<string, unknown> {
  const now = new Date(1_700_000_000_000);
  return {
    id: APP_ID,
    user_id: SESSION_USER_ID,
    wallet_address: applicant.address.toLowerCase(),
    resume_url: APPLICATION_BODY.resumeUrl,
    about: APPLICATION_BODY.about,
    linkedin_url: null,
    github_url: APPLICATION_BODY.githubUrl,
    portfolio_url: null,
    other_links: null,
    project_name: null,
    summary: null,
    website_url: null,
    pitch_deck_url: null,
    repo_url: null,
    contact: null,
    kyc_docs_url: APPLICATION_BODY.kycDocsUrl,
    kyc_note: null,
    status: "approved",
    review_note: NOTE,
    reviewed_by: null,
    reviewed_at: now,
    kyc_verified_at: now,
    kyc_verified_by: null,
    auto_approved: true,
    created_at: now,
    updated_at: now,
    role_changed: roleChanged,
  };
}

function approvedWalletRow(): Record<string, unknown> {
  return {
    id: WALLET_ID,
    user_id: SESSION_USER_ID,
    founder_wallet: applicant.address.toLowerCase(),
    address: SHADOW,
    status: "approved",
    review_note: NOTE,
    reviewed_by: null,
    reviewed_at: new Date(1_700_000_000_000),
    auto_approved: true,
    created_at: new Date(1_700_000_000_000),
  };
}

describe("FOUNDER_APPROVAL env", () => {
  const base = { DATABASE_URL: "postgresql://x:y@localhost:5432/z" };

  it("defaults to MANUAL, also when empty, and accepts AUTO", () => {
    expect(envSchema.parse(base).FOUNDER_APPROVAL).toBe("MANUAL");
    expect(envSchema.parse({ ...base, FOUNDER_APPROVAL: "" }).FOUNDER_APPROVAL).toBe("MANUAL");
    expect(envSchema.parse({ ...base, FOUNDER_APPROVAL: "AUTO" }).FOUNDER_APPROVAL).toBe("AUTO");
  });

  it("rejects any other value", () => {
    for (const value of ["auto", "yes", "true", "Manual"]) {
      expect(envSchema.safeParse({ ...base, FOUNDER_APPROVAL: value }).success).toBe(false);
    }
  });
});

describe("GET /api/v1/settings", () => {
  it("answers founderApproval auto without a session, with a short public cache", async () => {
    const res = await request(app).get("/api/v1/settings");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=30");
    expect(res.body).toEqual({ success: true, data: { founderApproval: "auto" } });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("application submit in AUTO", () => {
  it("approves in one statement, promotes an investor and keeps the sessions", async () => {
    const dataCalls = mockSession(mockQuery, "investor", applicant.address, {
      rows: [approvedApplicationRow(true)],
      rowCount: 1,
    });
    const res = await post("/api/v1/applications", APPLICATION_BODY);
    expect(res.status).toBe(201);
    expect(res.body.data.roleChanged).toBe(true);
    expect(res.body.data.application).toMatchObject({
      status: "approved",
      autoApproved: true,
      reviewNote: NOTE,
      kycVerifiedAt: "2023-11-14T22:13:20.000Z",
    });
    expect(res.body.data.application).not.toHaveProperty("reviewedBy");

    const calls = dataCalls();
    expect(calls).toHaveLength(1);
    const [sql, params] = calls[0] as [string, unknown[]];
    expect(sql).toContain("'application.auto_approve'");
    expect(sql).toContain("'role.change'");
    expect(sql).toContain("a.role = 'investor'");
    expect(sql).not.toContain("DELETE FROM app.sessions");
    expect(params[0]).toBe(SESSION_USER_ID);
    expect(params[1]).toBe(applicant.address.toLowerCase());
    expect(params[10]).toBe(NOTE);
  });

  it("reports roleChanged false when the role was not promoted and maps an open application to 409", async () => {
    mockSession(
      mockQuery,
      "founder",
      applicant.address,
      { rows: [approvedApplicationRow(false)], rowCount: 1 },
      Object.assign(new Error("dup"), { code: "23505", constraint: "founder_applications_open_wallet_idx" })
    );
    const first = await post("/api/v1/applications", APPLICATION_BODY);
    expect(first.status).toBe(201);
    expect(first.body.data.roleChanged).toBe(false);
    const second = await post("/api/v1/applications", APPLICATION_BODY);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("An open application already exists");
  });
});

describe("shadow wallet request in AUTO", () => {
  it("inserts the wallet approved with its auto_approve audit row", async () => {
    const dataCalls = mockSession(mockQuery, "founder", applicant.address, { rows: [approvedWalletRow()], rowCount: 1 });
    const res = await post("/api/v1/founders/me/shadow-wallet", { address: "0x" + "AB".repeat(20) });
    expect(res.status).toBe(201);
    expect(res.body.data.shadowWallet).toEqual({
      id: WALLET_ID,
      address: SHADOW,
      status: "approved",
      reviewNote: NOTE,
      autoApproved: true,
    });
    const [sql, params] = dataCalls()[0] as [string, unknown[]];
    expect(sql).toContain("'shadow_wallet.auto_approve'");
    expect(sql).toContain("p.status = 'pending'");
    expect(params.slice(0, 4)).toEqual([SESSION_USER_ID, applicant.address.toLowerCase(), SHADOW, NOTE]);
  });

  it("keeps the existing validations", async () => {
    mockSession(mockQuery, "founder", applicant.address);
    expect((await post("/api/v1/founders/me/shadow-wallet", { address: "0x" + "00".repeat(20) })).status).toBe(400);
    expect((await post("/api/v1/founders/me/shadow-wallet", { address: applicant.address })).status).toBe(400);
    expect((await post("/api/v1/founders/me/shadow-wallet", { address: SHADOW, extra: 1 })).status).toBe(400);
  });

  it("answers 409 for a pending request, and a distinct 409 for an address approved elsewhere", async () => {
    mockSession(
      mockQuery,
      "founder",
      applicant.address,
      { rows: [], rowCount: 0 },
      Object.assign(new Error("dup"), { code: "23505", constraint: "founder_wallets_approved_address_idx" })
    );
    const pending = await post("/api/v1/founders/me/shadow-wallet", { address: SHADOW });
    expect(pending.status).toBe(409);
    expect(pending.body.error).toBe("An open shadow wallet request already exists");
    const taken = await post("/api/v1/founders/me/shadow-wallet", { address: SHADOW });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe("Address is already approved for another founder");
  });
});
