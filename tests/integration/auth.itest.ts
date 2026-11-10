import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import {
  consumeNonce,
  deleteExpiredNonces,
  deleteExpiredSessions,
  deleteSession,
  findSession,
  insertSession,
  listUsers,
  pruneSessions,
  touchSession,
  upsertNonce,
  upsertUser,
} from "../../src/auth/authRepository.js";
import { addr, bootstrapDatabase, closePool, pool, resetData } from "./db.js";

beforeAll(bootstrapDatabase);
beforeEach(resetData);
afterAll(closePool);

const FUTURE = () => new Date(Date.now() + 60_000);

describe("nonces", () => {
  it("upsert replaces the previous nonce and consume is single use", async () => {
    await upsertNonce(addr(1), "n1", "msg1", FUTURE());
    await upsertNonce(addr(1), "n2", "msg2", FUTURE());
    const count = await pool.query("SELECT 1 FROM app.auth_nonces");
    expect(count.rowCount).toBe(1);

    const first = await consumeNonce(addr(1));
    expect(first?.message).toBe("msg2");
    expect(await consumeNonce(addr(1))).toBeNull();
  });

  it("deleteExpiredNonces removes only expired rows", async () => {
    await upsertNonce(addr(1), "old", "m", new Date(Date.now() - 1000));
    await upsertNonce(addr(2), "new", "m", FUTURE());
    await deleteExpiredNonces();
    const rows = await pool.query<{ address: string }>("SELECT address FROM app.auth_nonces");
    expect(rows.rows.map((r) => r.address)).toEqual([addr(2)]);
  });
});

describe("users and sessions", () => {
  it("upsertUser creates an investor, keeps the role on re-login and promotes on makeAdmin", async () => {
    const created = await upsertUser(addr(1), false);
    expect(created.role).toBe("investor");
    const again = await upsertUser(addr(1), false);
    expect(again.id).toBe(created.id);
    const admin = await upsertUser(addr(1), true);
    expect(admin).toMatchObject({ id: created.id, role: "admin" });
    const stays = await upsertUser(addr(1), false);
    expect(stays.role).toBe("admin");
    const fresh = await upsertUser(addr(2), true);
    expect(fresh.role).toBe("admin");
    const login = await pool.query<{ last_login_at: Date | null }>(
      "SELECT last_login_at FROM app.users WHERE id = $1",
      [created.id]
    );
    expect(login.rows[0]?.last_login_at).toBeInstanceOf(Date);
  });

  it("insert, find, touch and delete a session", async () => {
    const user = await upsertUser(addr(1), false);
    await insertSession("hash-1", user.id, FUTURE(), "1.2.3.4", "agent");
    const found = await findSession("hash-1");
    expect(found?.user).toEqual({ id: user.id, address: addr(1), role: "investor", profileComplete: false });
    expect(found?.expiresAt).toBeInstanceOf(Date);

    await pool.query("UPDATE app.sessions SET last_seen_at = now() - interval '1 hour' WHERE id_hash = 'hash-1'");
    const before = (await findSession("hash-1"))?.lastSeenAt.getTime() ?? 0;
    await touchSession("hash-1");
    const after = (await findSession("hash-1"))?.lastSeenAt.getTime() ?? 0;
    expect(after).toBeGreaterThan(before);

    await deleteSession("hash-1");
    expect(await findSession("hash-1")).toBeNull();
  });

  it("pruneSessions keeps the newest N", async () => {
    const user = await upsertUser(addr(1), false);
    for (let i = 1; i <= 4; i += 1) {
      await insertSession(`h${i}`, user.id, FUTURE(), null, null);
      await pool.query("UPDATE app.sessions SET created_at = now() - make_interval(mins => $2) WHERE id_hash = $1", [
        `h${i}`,
        10 - i,
      ]);
    }
    await pruneSessions(user.id, 2);
    const left = await pool.query<{ id_hash: string }>("SELECT id_hash FROM app.sessions ORDER BY id_hash");
    expect(left.rows.map((r) => r.id_hash)).toEqual(["h3", "h4"]);
  });

  it("deleteExpiredSessions removes expired and idle sessions only", async () => {
    const user = await upsertUser(addr(1), false);
    await insertSession("live", user.id, FUTURE(), null, null);
    await insertSession("expired", user.id, new Date(Date.now() - 1000), null, null);
    await insertSession("idle", user.id, FUTURE(), null, null);
    await pool.query("UPDATE app.sessions SET last_seen_at = now() - interval '10 days' WHERE id_hash = 'idle'");
    await deleteExpiredSessions(7 * 24 * 3600);
    const left = await pool.query<{ id_hash: string }>("SELECT id_hash FROM app.sessions");
    expect(left.rows.map((r) => r.id_hash)).toEqual(["live"]);
  });

  it("listUsers filters by role and address prefix and counts", async () => {
    await upsertUser(addr(1), false);
    await upsertUser(addr(2), true);
    await upsertUser(addr(0xabc), false);
    const admins = await listUsers({ role: "admin", addressPrefix: undefined, limit: 10, offset: 0 });
    expect(admins.total).toBe(1);
    const prefixed = await listUsers({ role: undefined, addressPrefix: addr(0xabc).slice(0, 40), limit: 10, offset: 0 });
    expect(prefixed.items.map((u) => u.address)).toEqual([addr(0xabc)]);
    const all = await listUsers({ role: undefined, addressPrefix: undefined, limit: 2, offset: 0 });
    expect(all.items).toHaveLength(2);
    expect(all.total).toBe(3);
  });
});
