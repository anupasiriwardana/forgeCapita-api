/**
 * Wallet sign-in and session tests. The pg module is replaced by a small in-memory
 * fake that answers the auth queries by SQL text, so no database is touched.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import { Wallet } from "ethers";

interface FakeUser {
  id: string;
  wallet_address: string;
  role: string;
}

const nonces = new Map<string, { message: string; expires_at: Date }>();
const users = new Map<string, FakeUser>();
const sessions = new Map<string, string>();
const projects = new Map<string, { developer: string }>();

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
    const existing = users.get(address);
    const user: FakeUser = existing ?? {
      id: `00000000-0000-0000-0000-${String(users.size + 1).padStart(12, "0")}`,
      wallet_address: address,
      role: "investor",
    };
    if (p[1] === true) user.role = "admin";
    users.set(address, user);
    return { rows: [user], rowCount: 1 };
  }
  if (text.includes("INSERT INTO app.sessions")) {
    sessions.set(p[0] as string, p[1] as string);
    return { rows: [], rowCount: 1 };
  }
  if (text.includes("DELETE FROM app.sessions WHERE user_id")) return { rows: [], rowCount: 0 };
  if (text.includes("DELETE FROM app.sessions WHERE id_hash")) {
    sessions.delete(p[0] as string);
    return { rows: [], rowCount: 1 };
  }
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
  if (text.includes('WHERE p."id" = $1')) {
    const project = projects.get(p[0] as string);
    return project ? { rows: [{ id: p[0], developer: project.developer }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (text.includes("INSERT INTO app.startup_profiles")) {
    return { rows: [{ name: "n", description: "d", updated_at: new Date(0) }], rowCount: 1 };
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

// Well-known test key 0x00..01; its address is the ADMIN_WALLETS value in tests/setupEnv.ts.
const adminWallet = new Wallet("0x" + "00".repeat(31) + "01");
const userWallet = new Wallet("0x" + "00".repeat(31) + "02");
const otherWallet = new Wallet("0x" + "00".repeat(31) + "03");

const ORIGIN = "http://localhost:3000";
const ESCROW = "0x" + "ab".repeat(20);
const PROJECT_ID = `421614:${ESCROW}`;
const profileBody = { projectId: PROJECT_ID, name: "Demo", description: "A demo startup." };

beforeEach(() => {
  nonces.clear();
  users.clear();
  sessions.clear();
  projects.clear();
  mockQuery.mockClear();
});

async function signIn(wallet: Wallet, signer: Wallet = wallet): Promise<request.Response> {
  const nonceRes = await request(app)
    .post("/api/v1/auth/nonce")
    .send({ address: wallet.address });
  const { message } = nonceRes.body.data as { message: string };
  const signature = await signer.signMessage(message);
  return request(app).post("/api/v1/auth/verify").send({ address: wallet.address, signature });
}

function cookieOf(res: request.Response): string {
  const header = res.headers["set-cookie"];
  const first = Array.isArray(header) ? header[0] : header;
  return (first ?? "").split(";")[0] ?? "";
}

describe("wallet sign-in", () => {
  it("issues a nonce message, sets an httpOnly cookie on verify and serves /me", async () => {
    const nonceRes = await request(app)
      .post("/api/v1/auth/nonce")
      .send({ address: userWallet.address.toLowerCase() });
    expect(nonceRes.status).toBe(200);
    expect(nonceRes.body.data.message).toContain("Sign in to ForgeCapita");
    expect(nonceRes.body.data.message).toContain(userWallet.address);
    expect(nonceRes.body.data.message).not.toMatch(/Chain ID/);

    const res = await signIn(userWallet);
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({
      address: userWallet.address.toLowerCase(),
      role: "investor",
    });
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toMatch(/^fc_session=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Max-Age=2592000");

    const me = await request(app).get("/api/v1/auth/me").set("Cookie", cookieOf(res));
    expect(me.status).toBe(200);
    expect(me.body.data.user.address).toBe(userWallet.address.toLowerCase());
    expect([...sessions.keys()].every((k) => /^[0-9a-f]{64}$/.test(k))).toBe(true);
  });

  it("rejects a replayed nonce", async () => {
    const nonceRes = await request(app)
      .post("/api/v1/auth/nonce")
      .send({ address: userWallet.address });
    const signature = await userWallet.signMessage(nonceRes.body.data.message as string);
    const body = { address: userWallet.address, signature };
    expect((await request(app).post("/api/v1/auth/verify").send(body)).status).toBe(200);
    const replay = await request(app).post("/api/v1/auth/verify").send(body);
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe("Sign-in failed");
  });

  it("rejects a signature from another wallet with the generic error", async () => {
    const res = await signIn(userWallet, otherWallet);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Sign-in failed");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects an expired nonce", async () => {
    await request(app).post("/api/v1/auth/nonce").send({ address: userWallet.address });
    const row = nonces.get(userWallet.address.toLowerCase());
    if (row) row.expires_at = new Date(Date.now() - 1000);
    const signature = await userWallet.signMessage(row?.message ?? "");
    const res = await request(app)
      .post("/api/v1/auth/verify")
      .send({ address: userWallet.address, signature });
    expect(res.status).toBe(401);
  });

  it("grants admin to an ADMIN_WALLETS wallet", async () => {
    const res = await signIn(adminWallet);
    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe("admin");
  });

  it("logout deletes the session and clears the cookie", async () => {
    const login = await signIn(userWallet);
    const cookie = cookieOf(login);
    const out = await request(app)
      .post("/api/v1/auth/logout")
      .set("Cookie", cookie)
      .set("Origin", ORIGIN);
    expect(out.status).toBe(204);
    expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");
    const me = await request(app).get("/api/v1/auth/me").set("Cookie", cookie);
    expect(me.status).toBe(401);
  });

  it("rejects malformed nonce and verify bodies", async () => {
    expect(
      (await request(app).post("/api/v1/auth/nonce").send({ address: "0x123" })).status
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/v1/auth/verify")
          .send({ address: userWallet.address, signature: "0x12", extra: 1 })
      ).status
    ).toBe(400);
  });
});

describe("POST /api/v1/projects/profile authorisation", () => {
  const post = (cookie: string | null, origin: string = ORIGIN) => {
    const req = request(app).post("/api/v1/projects/profile").set("Origin", origin);
    return (cookie ? req.set("Cookie", cookie) : req).send(profileBody);
  };

  it("returns 401 without a session", async () => {
    expect((await post(null)).status).toBe(401);
  });

  it("returns 403 for a non-owner and 404 for an unindexed project", async () => {
    const cookie = cookieOf(await signIn(userWallet));
    expect((await post(cookie)).status).toBe(404);
    projects.set(`421614:${ESCROW}`, { developer: otherWallet.address.toLowerCase() });
    expect((await post(cookie)).status).toBe(403);
  });

  it("allows the project developer", async () => {
    const cookie = cookieOf(await signIn(userWallet));
    projects.set(`421614:${ESCROW}`, { developer: userWallet.address.toLowerCase() });
    expect((await post(cookie)).status).toBe(201);
  });

  it("allows an admin without an ownership lookup", async () => {
    const cookie = cookieOf(await signIn(adminWallet));
    expect((await post(cookie)).status).toBe(201);
  });

  it("returns 403 for a cookie request from a disallowed Origin", async () => {
    const cookie = cookieOf(await signIn(userWallet));
    const res = await post(cookie, "https://evil.example.com");
    expect(res.status).toBe(403);
  });

  it("returns 403 for a cookie request without an Origin", async () => {
    const cookie = cookieOf(await signIn(userWallet));
    const res = await request(app)
      .post("/api/v1/projects/profile")
      .set("Cookie", cookie)
      .send(profileBody);
    expect(res.status).toBe(403);
  });
});

describe("CORS credentials", () => {
  it("preflight allows credentials for an allowed origin", async () => {
    const res = await request(app)
      .options("/api/v1/auth/verify")
      .set("Origin", ORIGIN)
      .set("Access-Control-Request-Method", "POST");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });
});
