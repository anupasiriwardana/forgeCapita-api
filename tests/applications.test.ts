/**
 * Founder application tests. The pg module is replaced by an in-memory fake that answers
 * queries by SQL text, so no database is touched.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import { Wallet } from "ethers";

interface FakeUser {
  id: string;
  wallet_address: string;
  role: string;
  created_at: Date;
  last_login_at: Date | null;
}

interface FakeApp {
  id: string;
  user_id: string;
  wallet_address: string;
  project_name: string;
  summary: string;
  website_url: string;
  pitch_deck_url: string;
  repo_url: string | null;
  contact: string | null;
  kyc_docs_url: string | null;
  kyc_note: string | null;
  status: string;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  kyc_verified_at: Date | null;
  kyc_verified_by: string | null;
  created_at: Date;
  updated_at: Date;
}

interface FakeAudit {
  action: string;
  actor_user_id: string;
  target: string;
  before_value: string;
  after_value: string;
}

const nonces = new Map<string, { message: string; expires_at: Date }>();
const users = new Map<string, FakeUser>();
const sessions = new Map<string, string>();
const apps: FakeApp[] = [];
const audit: FakeAudit[] = [];

function transition(
  id: string,
  actor: string,
  status: "approved" | "rejected",
  note: string | null
): { app: FakeApp; transitioned: boolean } | null {
  const app = apps.find((a) => a.id === id);
  if (!app) return null;
  const transitioned = app.status === "pending" && app.user_id !== actor;
  if (transitioned) {
    const now = new Date();
    Object.assign(app, { status, review_note: note, reviewed_by: actor, reviewed_at: now, updated_at: now });
    if (status === "approved") Object.assign(app, { kyc_verified_at: now, kyc_verified_by: actor });
    audit.push({
      action: status === "approved" ? "application.approve" : "application.reject",
      actor_user_id: actor,
      target: app.wallet_address,
      before_value: "pending",
      after_value: status,
    });
  }
  return { app, transitioned };
}

const mockQuery = jest.fn(async (sql: unknown, params?: unknown) => {
  const text = String(sql);
  const p = (params ?? []) as unknown[];
  if (text.includes("INSERT INTO app.auth_nonces")) {
    nonces.set(p[0] as string, { message: p[2] as string, expires_at: p[3] as Date });
    return { rows: [], rowCount: 1 };
  }
  if (text.includes("DELETE FROM app.auth_nonces WHERE expires_at")) return { rows: [], rowCount: 0 };
  if (text.includes("DELETE FROM app.auth_nonces WHERE address")) {
    const row = nonces.get(p[0] as string);
    nonces.delete(p[0] as string);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  if (text.includes("INSERT INTO app.users")) {
    const address = p[0] as string;
    const user: FakeUser = users.get(address) ?? {
      id: `00000000-0000-0000-0000-${String(users.size + 1).padStart(12, "0")}`,
      wallet_address: address,
      role: "investor",
      created_at: new Date(),
      last_login_at: null,
    };
    if (p[1] === true) user.role = "admin";
    users.set(address, user);
    return { rows: [user], rowCount: 1 };
  }
  if (text.includes("INSERT INTO app.sessions")) {
    sessions.set(p[0] as string, p[1] as string);
    return { rows: [], rowCount: 1 };
  }
  if (text.includes("DELETE FROM app.sessions WHERE expires_at")) return { rows: [], rowCount: 0 };
  if (text.includes("FROM app.sessions s")) {
    const userId = sessions.get(p[0] as string);
    const user = [...users.values()].find((u) => u.id === userId);
    return user
      ? {
          rows: [
            {
              user_id: user.id,
              wallet_address: user.wallet_address,
              role: user.role,
              last_seen_at: new Date(),
              expires_at: new Date(Date.now() + 86_400_000),
            },
          ],
          rowCount: 1,
        }
      : { rows: [], rowCount: 0 };
  }
  if (text.includes("'application.approve'")) {
    const result = transition(p[0] as string, p[1] as string, "approved", p[2] as string | null);
    if (!result) return { rows: [], rowCount: 0 };
    const applicant = [...users.values()].find((u) => u.id === result.app.user_id);
    const roleChanged = result.transitioned && applicant?.role === "investor";
    if (applicant && roleChanged) {
      applicant.role = "founder";
      audit.push({
        action: "role.change",
        actor_user_id: p[1] as string,
        target: applicant.wallet_address,
        before_value: "investor",
        after_value: "founder",
      });
      for (const [hash, userId] of sessions) if (userId === applicant.id) sessions.delete(hash);
    }
    return {
      rows: [
        {
          id: result.app.id,
          user_id: result.app.user_id,
          wallet_address: result.app.wallet_address,
          previous_status: "pending",
          transitioned: result.transitioned,
          role_changed: roleChanged,
        },
      ],
      rowCount: 1,
    };
  }
  if (text.includes("'application.reject'")) {
    const result = transition(p[0] as string, p[1] as string, "rejected", p[2] as string);
    if (!result) return { rows: [], rowCount: 0 };
    return {
      rows: [
        {
          id: result.app.id,
          user_id: result.app.user_id,
          wallet_address: result.app.wallet_address,
          previous_status: "pending",
          transitioned: result.transitioned,
          role_changed: false,
        },
      ],
      rowCount: 1,
    };
  }
  if (text.includes("INSERT INTO app.founder_applications")) {
    if (apps.some((a) => a.wallet_address === p[1] && a.status !== "rejected")) {
      throw Object.assign(new Error("duplicate key value"), { code: "23505" });
    }
    const app: FakeApp = {
      id: `aaaaaaaa-0000-4000-8000-${String(apps.length + 1).padStart(12, "0")}`,
      user_id: p[0] as string,
      wallet_address: p[1] as string,
      project_name: p[2] as string,
      summary: p[3] as string,
      website_url: p[4] as string,
      pitch_deck_url: p[5] as string,
      repo_url: p[6] as string | null,
      contact: p[7] as string | null,
      kyc_docs_url: p[8] as string | null,
      kyc_note: p[9] as string | null,
      status: "pending",
      review_note: null,
      reviewed_by: null,
      reviewed_at: null,
      kyc_verified_at: null,
      kyc_verified_by: null,
      created_at: new Date(1_700_000_000_000 + apps.length * 1000),
      updated_at: new Date(1_700_000_000_000 + apps.length * 1000),
    };
    apps.push(app);
    return { rows: [app], rowCount: 1 };
  }
  if (text.includes("WHERE user_id = $1")) {
    const mine = apps.filter((a) => a.user_id === p[0]).sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    return { rows: mine.slice(0, 1), rowCount: Math.min(mine.length, 1) };
  }
  if (text.includes("WHERE id = $1")) {
    const found = apps.filter((a) => a.id === p[0]);
    return { rows: found, rowCount: found.length };
  }
  if (text.includes("FROM app.founder_applications")) {
    const matching = apps
      .filter((a) => p[0] === null || a.status === p[0])
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    if (text.includes("count(*)")) return { rows: [{ total: String(matching.length) }], rowCount: 1 };
    const page = matching.slice(p[2] as number, (p[2] as number) + (p[1] as number));
    return { rows: page, rowCount: page.length };
  }
  return { rows: [], rowCount: 0 };
});

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: mockQuery,
    connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
    end: jest.fn(),
  })),
}));

const { createApp } = await import("../src/app.js");
const app = createApp();

// Test key 0x00..01 is the ADMIN_WALLETS value in tests/setupEnv.ts.
const adminWallet = new Wallet("0x" + "00".repeat(31) + "01");
const staffWallet = new Wallet("0x" + "00".repeat(31) + "02");
const applicantWallet = new Wallet("0x" + "00".repeat(31) + "03");
const otherWallet = new Wallet("0x" + "00".repeat(31) + "04");

const ORIGIN = "http://localhost:3000";
const VALID_BODY = {
  projectName: "  Acme SaaS ",
  summary: "A subscription product.",
  websiteUrl: "https://acme.example.com",
  pitchDeckUrl: "https://acme.example.com/deck.pdf",
  repoUrl: "https://github.com/acme/app",
  contact: "founder@acme.example.com",
  kycDocsUrl: "https://drive.google.com/drive/folders/1AbC?usp=sharing",
  kycNote: "Passport and utility bill",
};

beforeEach(() => {
  nonces.clear();
  users.clear();
  sessions.clear();
  apps.length = 0;
  audit.length = 0;
  mockQuery.mockClear();
});

async function signIn(wallet: Wallet): Promise<string> {
  const nonceRes = await request(app).post("/api/v1/auth/nonce").send({ address: wallet.address });
  const signature = await wallet.signMessage((nonceRes.body.data as { message: string }).message);
  const res = await request(app).post("/api/v1/auth/verify").send({ address: wallet.address, signature });
  const header = res.headers["set-cookie"];
  const first = Array.isArray(header) ? header[0] : header;
  return (first ?? "").split(";")[0] ?? "";
}

function userOf(wallet: Wallet): FakeUser {
  const user = users.get(wallet.address.toLowerCase());
  if (!user) throw new Error("user not seeded");
  return user;
}

function submit(cookie: string | null, body: unknown) {
  const req = request(app).post("/api/v1/applications").set("Origin", ORIGIN);
  return (cookie ? req.set("Cookie", cookie) : req).send(body as object);
}

function review(cookie: string | null, id: string, action: "approve" | "reject", body: unknown) {
  const req = request(app).post(`/api/v1/admin/applications/${id}/${action}`).set("Origin", ORIGIN);
  return (cookie ? req.set("Cookie", cookie) : req).send(body as object);
}

async function applyAs(wallet: Wallet): Promise<{ cookie: string; id: string }> {
  const cookie = await signIn(wallet);
  const res = await submit(cookie, VALID_BODY);
  expect(res.status).toBe(201);
  return { cookie, id: res.body.data.application.id as string };
}

describe("RBAC", () => {
  it("rejects anonymous callers and wrong roles", async () => {
    const { id } = await applyAs(applicantWallet);
    const investorCookie = await signIn(otherWallet);
    const staffCookie = await signIn(staffWallet);
    userOf(staffWallet).role = "staff";
    const adminCookie = await signIn(adminWallet);

    expect((await submit(null, VALID_BODY)).status).toBe(401);
    expect((await request(app).get("/api/v1/applications/mine")).status).toBe(401);
    expect((await request(app).get("/api/v1/admin/applications")).status).toBe(401);
    expect((await review(null, id, "approve", { kycVerified: true })).status).toBe(401);

    expect((await request(app).get("/api/v1/admin/applications").set("Cookie", investorCookie)).status).toBe(403);
    expect((await request(app).get(`/api/v1/admin/applications/${id}`).set("Cookie", investorCookie)).status).toBe(403);
    expect((await review(investorCookie, id, "approve", { kycVerified: true })).status).toBe(403);
    expect((await review(investorCookie, id, "reject", { note: "no" })).status).toBe(403);

    expect((await submit(staffCookie, VALID_BODY)).status).toBe(403);
    expect((await submit(adminCookie, VALID_BODY)).status).toBe(403);
  });
});

describe("validation", () => {
  it("rejects bad URLs, repo hosts, extra keys and oversize strings", async () => {
    const cookie = await signIn(applicantWallet);
    const bad: Array<Record<string, unknown>> = [
      { ...VALID_BODY, websiteUrl: "http://acme.example.com" },
      { ...VALID_BODY, pitchDeckUrl: "javascript:alert(1)" },
      { ...VALID_BODY, repoUrl: "https://bitbucket.org/acme/app" },
      { ...VALID_BODY, extra: true },
      { ...VALID_BODY, kycDocsUrl: undefined },
      { ...VALID_BODY, kycDocsUrl: "javascript:alert(1)" },
      { ...VALID_BODY, kycDocsUrl: "data:text/html,x" },
      { ...VALID_BODY, kycDocsUrl: "http://drive.google.com/x" },
      { ...VALID_BODY, kycDocsUrl: "https://u:p@drive.google.com/x" },
      { ...VALID_BODY, kycDocsUrl: `https://drive.google.com/${"x".repeat(500)}` },
      { ...VALID_BODY, kycDocsUrl: "https://drive.google.com/a b" },
      { ...VALID_BODY, kycNote: "x".repeat(501) },
      { ...VALID_BODY, projectName: "x".repeat(81) },
      { ...VALID_BODY, summary: "x".repeat(1001) },
      { ...VALID_BODY, websiteUrl: `https://acme.example.com/${"x".repeat(300)}` },
    ];
    for (const body of bad) expect((await submit(cookie, body)).status).toBe(400);
    expect(apps).toHaveLength(0);
  });
});

describe("submit and read", () => {
  it("creates a pending application, trims input and returns the latest on /mine", async () => {
    const cookie = await signIn(applicantWallet);
    const created = await submit(cookie, VALID_BODY);
    expect(created.status).toBe(201);
    expect(created.body.data.application).not.toHaveProperty("kycDocsUrl");
    expect(created.body.data.application).not.toHaveProperty("kycNote");
    expect(apps[0]).toMatchObject({ project_name: "Acme SaaS", status: "pending" });

    const mine = await request(app).get("/api/v1/applications/mine").set("Cookie", cookie);
    expect(mine.status).toBe(200);
    expect(mine.headers["cache-control"]).toBe("no-store");
    expect(mine.body.data.application).toMatchObject({
      projectName: "Acme SaaS",
      contact: "founder@acme.example.com",
      status: "pending",
    });
    expect(mine.body.data.application).not.toHaveProperty("reviewedBy");
    expect(mine.body.data.application).not.toHaveProperty("kycDocsUrl");
    expect(mine.body.data.application).not.toHaveProperty("kycNote");

    const none = await request(app).get("/api/v1/applications/mine").set("Cookie", await signIn(otherWallet));
    expect(none.body.data.application).toBeNull();
  });

  it("answers 409 for a second open application and allows reapplying after rejection", async () => {
    const { cookie, id } = await applyAs(applicantWallet);
    expect((await submit(cookie, VALID_BODY)).status).toBe(409);

    const staffCookie = await signIn(adminWallet);
    expect((await review(staffCookie, id, "reject", { note: "Incomplete" })).status).toBe(200);
    expect((await submit(cookie, VALID_BODY)).status).toBe(201);
    const mine = await request(app).get("/api/v1/applications/mine").set("Cookie", cookie);
    expect(mine.body.data.application.status).toBe("pending");
  });

  it("lets staff list and fetch applications with reviewer fields", async () => {
    const { id } = await applyAs(applicantWallet);
    const adminCookie = await signIn(adminWallet);
    const list = await request(app).get("/api/v1/admin/applications?status=pending").set("Cookie", adminCookie);
    expect(list.status).toBe(200);
    expect(list.body.data).toMatchObject({ total: 1, limit: 20, offset: 0 });
    expect(list.body.data.items[0]).toMatchObject({ kycDocsUrl: VALID_BODY.kycDocsUrl, kycNote: VALID_BODY.kycNote });
    const one = await request(app).get(`/api/v1/admin/applications/${id}`).set("Cookie", adminCookie);
    expect(one.body.data.application).toHaveProperty("reviewedBy", null);
    expect(one.body.data.application).toMatchObject({ kycDocsUrl: VALID_BODY.kycDocsUrl });
    expect((await request(app).get("/api/v1/admin/applications/not-a-uuid").set("Cookie", adminCookie)).status).toBe(400);
    expect((await request(app).get("/api/v1/admin/applications?limit=101").set("Cookie", adminCookie)).status).toBe(400);
  });
});

describe("approve and reject", () => {
  it("requires kycVerified true and rejects extra keys", async () => {
    const { id } = await applyAs(applicantWallet);
    const adminCookie = await signIn(adminWallet);
    for (const body of [{}, { kycVerified: false }, { kycVerified: true, extra: 1 }, { kycVerified: true, note: "x".repeat(501) }]) {
      expect((await review(adminCookie, id, "approve", body)).status).toBe(400);
    }
    expect(apps[0]?.status).toBe("pending");
  });

  it("approves a pending application, grants founder, revokes sessions and audits", async () => {
    const { id } = await applyAs(applicantWallet);
    const adminCookie = await signIn(adminWallet);

    const res = await review(adminCookie, id, "approve", { kycVerified: true, note: "KYC ok" });

    expect(res.status).toBe(200);
    expect(res.body.data.application).toMatchObject({ status: "approved", reviewNote: "KYC ok" });
    expect(apps[0]?.kyc_verified_by).toBe(userOf(adminWallet).id);
    expect(userOf(applicantWallet).role).toBe("founder");
    expect([...sessions.values()]).not.toContain(userOf(applicantWallet).id);
    expect(audit.map((a) => a.action)).toEqual(["application.approve", "role.change"]);
    expect(audit[0]).toMatchObject({
      target: applicantWallet.address.toLowerCase(),
      before_value: "pending",
      after_value: "approved",
    });
    const issued = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(issued.some((s) => s.includes("INSERT INTO app.audit_log") && s.includes("'application.approve'"))).toBe(true);
  });

  it("does not downgrade a staff applicant and answers 409 when approving twice", async () => {
    const { id } = await applyAs(staffWallet);
    userOf(staffWallet).role = "staff";
    const adminCookie = await signIn(adminWallet);

    expect((await review(adminCookie, id, "approve", { kycVerified: true })).status).toBe(200);
    expect(userOf(staffWallet).role).toBe("staff");
    expect(audit.map((a) => a.action)).toEqual(["application.approve"]);
    expect((await review(adminCookie, id, "approve", { kycVerified: true })).status).toBe(409);
    expect((await review(adminCookie, id, "reject", { note: "late" })).status).toBe(409);
  });

  it("rejects with a required note and writes an audit row", async () => {
    const { id } = await applyAs(applicantWallet);
    const adminCookie = await signIn(adminWallet);
    expect((await review(adminCookie, id, "reject", {})).status).toBe(400);
    expect((await review(adminCookie, id, "reject", { note: "   " })).status).toBe(400);

    const res = await review(adminCookie, id, "reject", { note: "Not a fit" });
    expect(res.status).toBe(200);
    expect(res.body.data.application).toMatchObject({ status: "rejected", reviewNote: "Not a fit" });
    expect(userOf(applicantWallet).role).toBe("investor");
    expect(audit.map((a) => a.action)).toEqual(["application.reject"]);
  });

  it("answers 404 for an unknown id and 403 when reviewing one's own application", async () => {
    const adminCookie = await signIn(adminWallet);
    expect(
      (await review(adminCookie, "bbbbbbbb-0000-4000-8000-000000000001", "approve", { kycVerified: true })).status
    ).toBe(404);

    const { id } = await applyAs(applicantWallet);
    userOf(applicantWallet).role = "staff";
    const ownCookie = await signIn(applicantWallet);
    expect((await review(ownCookie, id, "approve", { kycVerified: true })).status).toBe(403);
    expect(apps[0]?.status).toBe("pending");
    expect(audit).toHaveLength(0);
  });
});
