/**
 * Admin role-management and session-hardening tests. The pg module is replaced by an
 * in-memory fake that answers queries by SQL text, so no database is touched.
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

interface FakeAudit {
  action: string;
  actor_user_id: string;
  target: string;
  before_value: string;
  after_value: string;
  ip: string | null;
}

const nonces = new Map<string, { message: string; expires_at: Date }>();
const users = new Map<string, FakeUser>();
const sessions = new Map<string, string>();
const audit: FakeAudit[] = [];
let failSessionLookup = false;
let failCleanup = false;

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
      created_at: new Date(1_700_000_000_000 + users.size * 1000),
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
  if (text.includes("INSERT INTO app.audit_log")) {
    const target = users.get(p[0] as string);
    if (!target) return { rows: [], rowCount: 0 };
    const changed = target.role !== "admin" && target.role !== p[1];
    const previous = target.role;
    if (changed) {
      target.role = p[1] as string;
      audit.push({
        action: "role.change",
        actor_user_id: p[2] as string,
        target: target.wallet_address,
        before_value: previous,
        after_value: target.role,
        ip: p[3] as string | null,
      });
      for (const [hash, userId] of sessions) if (userId === target.id) sessions.delete(hash);
    }
    return {
      rows: [{ id: target.id, wallet_address: target.wallet_address, previous_role: previous, changed }],
      rowCount: 1,
    };
  }
  if (text.includes("DELETE FROM app.sessions WHERE expires_at")) {
    if (failCleanup) throw new Error("cleanup failed");
    return { rows: [], rowCount: 0 };
  }
  if (text.includes("DELETE FROM app.sessions WHERE id_hash")) {
    sessions.delete(p[0] as string);
    return { rows: [], rowCount: 1 };
  }
  if (text.includes("FROM app.sessions s")) {
    if (failSessionLookup) throw new Error("db down");
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
  if (text.includes("FROM app.users")) {
    const role = p[0] as string | null;
    const prefix = p[1] as string | null;
    const matching = [...users.values()]
      .filter((u) => (role === null || u.role === role) && (prefix === null || u.wallet_address.startsWith(prefix)))
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    if (text.includes("count(*)")) return { rows: [{ total: String(matching.length) }], rowCount: 1 };
    const page = matching.slice(p[3] as number, (p[3] as number) + (p[2] as number));
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
const targetWallet = new Wallet("0x" + "00".repeat(31) + "03");
const otherAdminWallet = new Wallet("0x" + "00".repeat(31) + "04");

const ORIGIN = "http://localhost:3000";

beforeEach(() => {
  nonces.clear();
  users.clear();
  sessions.clear();
  audit.length = 0;
  failSessionLookup = false;
  failCleanup = false;
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

function setRole(wallet: Wallet, role: string): FakeUser {
  const user = users.get(wallet.address.toLowerCase());
  if (!user) throw new Error("user not seeded");
  user.role = role;
  return user;
}

function patchRole(cookie: string | null, address: string, body: unknown, origin: string = ORIGIN) {
  const req = request(app).patch(`/api/v1/admin/users/${address}/role`).set("Origin", origin);
  return (cookie ? req.set("Cookie", cookie) : req).send(body as object);
}

describe("PATCH /api/v1/admin/users/:address/role", () => {
  it("changes the role, revokes the target's sessions and writes one audit row", async () => {
    const adminCookie = await signIn(adminWallet);
    await signIn(targetWallet);
    const target = users.get(targetWallet.address.toLowerCase());
    expect(sessions.size).toBe(2);

    const res = await patchRole(adminCookie, targetWallet.address, { role: "founder" });

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({
      success: true,
      data: { user: { id: target?.id, address: targetWallet.address.toLowerCase(), role: "founder" } },
    });
    expect(target?.role).toBe("founder");
    expect([...sessions.values()]).not.toContain(target?.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "role.change",
      actor_user_id: users.get(adminWallet.address.toLowerCase())?.id,
      target: targetWallet.address.toLowerCase(),
      before_value: "investor",
      after_value: "founder",
    });
  });

  it("returns 200 without an audit row when the role is unchanged", async () => {
    const adminCookie = await signIn(adminWallet);
    await signIn(targetWallet);
    const res = await patchRole(adminCookie, targetWallet.address, { role: "investor" });
    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe("investor");
    expect(audit).toHaveLength(0);
  });

  it("rejects non-admins and anonymous callers", async () => {
    const staffCookie = await signIn(staffWallet);
    await signIn(targetWallet);
    setRole(staffWallet, "staff");
    expect((await patchRole(staffCookie, targetWallet.address, { role: "founder" })).status).toBe(403);
    expect((await patchRole(null, targetWallet.address, { role: "founder" })).status).toBe(401);
    expect(audit).toHaveLength(0);
  });

  it("rejects a cookie request from a disallowed origin", async () => {
    const adminCookie = await signIn(adminWallet);
    await signIn(targetWallet);
    const res = await patchRole(adminCookie, targetWallet.address, { role: "founder" }, "https://evil.example.com");
    expect(res.status).toBe(403);
    expect(audit).toHaveLength(0);
  });

  it("never assigns admin and rejects unknown fields and malformed addresses", async () => {
    const adminCookie = await signIn(adminWallet);
    await signIn(targetWallet);
    expect((await patchRole(adminCookie, targetWallet.address, { role: "admin" })).status).toBe(400);
    expect(
      (await patchRole(adminCookie, targetWallet.address, { role: "staff", extra: true })).status
    ).toBe(400);
    expect((await patchRole(adminCookie, "0x123", { role: "staff" })).status).toBe(400);
    expect(users.get(targetWallet.address.toLowerCase())?.role).toBe("investor");
    expect(audit).toHaveLength(0);
  });

  it("rejects self-change, ADMIN_WALLETS and other admin targets, and unknown users", async () => {
    const adminCookie = await signIn(adminWallet);
    await signIn(otherAdminWallet);
    setRole(otherAdminWallet, "admin");

    expect((await patchRole(adminCookie, adminWallet.address, { role: "investor" })).status).toBe(403);
    expect((await patchRole(adminCookie, otherAdminWallet.address, { role: "investor" })).status).toBe(403);
    expect((await patchRole(adminCookie, targetWallet.address, { role: "staff" })).status).toBe(404);
    expect(users.get(otherAdminWallet.address.toLowerCase())?.role).toBe("admin");
    expect(users.has(targetWallet.address.toLowerCase())).toBe(false);
    expect(audit).toHaveLength(0);
  });
});

describe("GET /api/v1/admin/users", () => {
  it("allows staff and applies paging, filters and total", async () => {
    const staffCookie = await signIn(staffWallet);
    setRole(staffWallet, "staff");
    await signIn(targetWallet);
    await signIn(otherAdminWallet);

    const all = await request(app).get("/api/v1/admin/users").set("Cookie", staffCookie);
    expect(all.status).toBe(200);
    expect(all.headers["cache-control"]).toBe("no-store");
    expect(all.body.data).toMatchObject({ total: 3, limit: 20, offset: 0 });
    expect(all.body.data.items[0]).toEqual({
      id: expect.any(String),
      address: otherAdminWallet.address.toLowerCase(),
      role: "investor",
      createdAt: expect.any(String),
      lastLoginAt: null,
    });

    const page = await request(app).get("/api/v1/admin/users?limit=1&offset=1").set("Cookie", staffCookie);
    expect(page.body.data.items).toHaveLength(1);
    expect(page.body.data.total).toBe(3);

    const byRole = await request(app).get("/api/v1/admin/users?role=staff").set("Cookie", staffCookie);
    expect(byRole.body.data.total).toBe(1);

    const prefix = targetWallet.address.toLowerCase().slice(0, 10);
    const byPrefix = await request(app).get(`/api/v1/admin/users?q=${prefix}`).set("Cookie", staffCookie);
    expect(byPrefix.body.data.items.map((u: { address: string }) => u.address)).toEqual([
      targetWallet.address.toLowerCase(),
    ]);
  });

  it("rejects investors and anonymous callers and out-of-range or unknown params", async () => {
    const cookie = await signIn(targetWallet);
    expect((await request(app).get("/api/v1/admin/users").set("Cookie", cookie)).status).toBe(403);
    expect((await request(app).get("/api/v1/admin/users")).status).toBe(401);

    const adminCookie = await signIn(adminWallet);
    for (const query of ["limit=101", "limit=0", "offset=10001", "q=0xABC", "role=root", "x=1"]) {
      const res = await request(app).get(`/api/v1/admin/users?${query}`).set("Cookie", adminCookie);
      expect(res.status).toBe(400);
    }
  });
});

describe("session hardening", () => {
  it("treats a failing session lookup as anonymous instead of a 500", async () => {
    const cookie = await signIn(targetWallet);
    failSessionLookup = true;
    expect((await request(app).get("/api/v1/openapi.json").set("Cookie", cookie)).status).toBe(200);
    expect((await request(app).get("/api/v1/auth/me").set("Cookie", cookie)).status).toBe(401);
  });

  it("runs expired-session cleanup on login and signs in even when it fails", async () => {
    await signIn(targetWallet);
    const cleanupCalls = (): number =>
      mockQuery.mock.calls.filter((call) => String(call[0]).includes("DELETE FROM app.sessions WHERE expires_at")).length;
    expect(cleanupCalls()).toBe(1);

    failCleanup = true;
    const cookie = await signIn(staffWallet);
    expect(cleanupCalls()).toBe(2);
    expect((await request(app).get("/api/v1/auth/me").set("Cookie", cookie)).status).toBe(200);
  });
});
