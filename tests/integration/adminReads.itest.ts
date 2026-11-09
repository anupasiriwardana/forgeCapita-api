import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { listAuditPage } from "../../src/auth/auditRepository.js";
import { listDraftsForAdmin } from "../../src/drafts/draftRepository.js";
import { listRelayRequestsForAdmin } from "../../src/relay/relayRepository.js";
import { addr, bootstrapDatabase, closePool, createUser, pool, resetData } from "./db.js";

beforeAll(bootstrapDatabase);
beforeEach(resetData);
afterAll(closePool);

const NO_FILTER = { limit: 50, offset: 0 };

async function insertAudit(action: string, target: string, actor: string | null, secondsAgo: number): Promise<void> {
  await pool.query(
    `INSERT INTO app.audit_log (action, actor_user_id, target, before_value, after_value, ip, created_at)
     VALUES ($1, $2, $3, 'a', 'b', '1.1.1.1', now() - make_interval(secs => $4))`,
    [action, actor, target, secondsAgo]
  );
}

describe("listAuditPage", () => {
  it("filters by action, target and actor, counts with the same filters, orders newest first and pages", async () => {
    const admin = await createUser(1, "admin");
    const other = await createUser(2, "staff");
    await insertAudit("role.change", addr(10), admin.id, 40);
    await insertAudit("role.change", addr(11), other.id, 30);
    await insertAudit("launch_draft.create", addr(10), admin.id, 20);
    await insertAudit("launch_draft.create", addr(12), admin.id, 10);

    const all = await listAuditPage({ ...NO_FILTER, action: undefined, target: undefined, actor: undefined });
    expect(all.total).toBe(4);
    expect(all.items.map((e) => e.target)).toEqual([addr(12), addr(10), addr(11), addr(10)]);
    expect(all.items[0]).toMatchObject({ action: "launch_draft.create", beforeValue: "a", afterValue: "b", ip: "1.1.1.1" });

    const byAction = await listAuditPage({ ...NO_FILTER, action: "role.change", target: undefined, actor: undefined });
    expect(byAction.total).toBe(2);
    const byTarget = await listAuditPage({ ...NO_FILTER, action: undefined, target: addr(10), actor: undefined });
    expect(byTarget.items.map((e) => e.action)).toEqual(["launch_draft.create", "role.change"]);
    const byActor = await listAuditPage({ ...NO_FILTER, action: undefined, target: undefined, actor: other.id });
    expect(byActor.total).toBe(1);
    const combined = await listAuditPage({ ...NO_FILTER, action: "role.change", target: addr(10), actor: admin.id });
    expect(combined.total).toBe(1);

    const page = await listAuditPage({ limit: 2, offset: 1, action: undefined, target: undefined, actor: undefined });
    expect(page.total).toBe(4);
    expect(page.items.map((e) => e.target)).toEqual([addr(10), addr(11)]);

    const rows = await pool.query("SELECT count(*)::int AS n FROM app.audit_log");
    expect(rows.rows[0]?.n).toBe(4);
  });
});

async function insertDraft(
  userId: string,
  wallet: string,
  chainId: number,
  status: string,
  name: string,
  secondsAgo: number
): Promise<void> {
  await pool.query(
    `INSERT INTO app.launch_drafts (user_id, wallet_address, chain_id, payload, status, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, now() - make_interval(secs => $6))`,
    [userId, wallet, chainId, JSON.stringify({ name, secretField: "do-not-leak" }), status, secondsAgo]
  );
}

describe("listDraftsForAdmin", () => {
  it("filters by status, user and chain, joins the wallet and exposes only the payload name", async () => {
    const a = await createUser(1, "founder");
    const b = await createUser(2, "founder");
    await insertDraft(a.id, a.address, 421614, "pending", "Alpha", 30);
    await insertDraft(a.id, a.address, 97, "cancelled", "Beta", 20);
    await insertDraft(b.id, b.address, 421614, "applied", "Gamma", 10);
    const none = { status: undefined, userId: undefined, chainId: undefined };

    const all = await listDraftsForAdmin({ ...NO_FILTER, ...none });
    expect(all.total).toBe(3);
    expect(all.items.map((d) => d.name)).toEqual(["Gamma", "Beta", "Alpha"]);
    expect(all.items[0]).toMatchObject({ walletAddress: b.address, userId: b.id, status: "applied", appliedAt: null });
    for (const item of all.items) {
      expect(Object.keys(item)).not.toContain("payload");
      expect(JSON.stringify(item)).not.toContain("do-not-leak");
    }

    expect((await listDraftsForAdmin({ ...NO_FILTER, ...none, status: "pending" })).items.map((d) => d.name)).toEqual(["Alpha"]);
    const byUser = await listDraftsForAdmin({ ...NO_FILTER, ...none, userId: a.id });
    expect(byUser.total).toBe(2);
    expect(byUser.items.every((d) => d.walletAddress === a.address)).toBe(true);
    expect((await listDraftsForAdmin({ ...NO_FILTER, ...none, chainId: 97 })).items.map((d) => d.name)).toEqual(["Beta"]);
    const page = await listDraftsForAdmin({ limit: 1, offset: 1, ...none });
    expect(page.total).toBe(3);
    expect(page.items.map((d) => d.name)).toEqual(["Beta"]);
  });
});

async function insertRelay(
  kind: string,
  chainId: number,
  projectId: string,
  userId: string | null,
  status: string,
  key: string,
  secondsAgo: number
): Promise<void> {
  await pool.query(
    `INSERT INTO app.relay_requests
       (kind, chain_id, project_id, user_id, account, payload, args, idem_key, status, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, '{"note":"x"}'::jsonb, '{"to":"0x","data":"0xdeadbeef"}'::jsonb, $6, $7,
             now() + interval '1 hour', now() - make_interval(secs => $8))`,
    [kind, chainId, projectId, userId, addr(0xacc), key, status, secondsAgo]
  );
}

describe("listRelayRequestsForAdmin", () => {
  it("filters by kind, status, chain, system and project and never returns args or payload", async () => {
    const user = await createUser(1, "investor");
    const p1 = `421614:${addr(0xe1)}`;
    const p2 = `97:${addr(0xe2)}`;
    await insertRelay("claim", 421614, p1, user.id, "QUEUED", "k1", 40);
    await insertRelay("vote", 421614, p1, user.id, "CONFIRMED", "k2", 30);
    await insertRelay("execute", 97, p2, null, "FAILED", "k3", 20);
    await insertRelay("execute", 421614, p1, null, "SENT", "k4", 10);
    const none = { kind: undefined, status: undefined, chainId: undefined, system: false, projectId: undefined };

    const all = await listRelayRequestsForAdmin({ ...NO_FILTER, ...none });
    expect(all.total).toBe(4);
    expect(all.items.map((r) => r.kind)).toEqual(["execute", "execute", "vote", "claim"]);
    expect(all.items[2]).toMatchObject({ userId: user.id, account: addr(0xacc), status: "CONFIRMED" });
    for (const item of all.items) {
      expect(Object.keys(item)).not.toContain("args");
      expect(Object.keys(item)).not.toContain("payload");
      expect(JSON.stringify(item)).not.toContain("deadbeef");
    }

    expect((await listRelayRequestsForAdmin({ ...NO_FILTER, ...none, kind: "claim" })).total).toBe(1);
    expect((await listRelayRequestsForAdmin({ ...NO_FILTER, ...none, status: "SENT" })).items.map((r) => r.kind)).toEqual(["execute"]);
    expect((await listRelayRequestsForAdmin({ ...NO_FILTER, ...none, chainId: 97 })).total).toBe(1);
    const system = await listRelayRequestsForAdmin({ ...NO_FILTER, ...none, system: true });
    expect(system.total).toBe(2);
    expect(system.items.every((r) => r.userId === null)).toBe(true);
    const byProject = await listRelayRequestsForAdmin({ ...NO_FILTER, ...none, projectId: p2 });
    expect(byProject.items.map((r) => r.status)).toEqual(["FAILED"]);
    const combined = await listRelayRequestsForAdmin({ ...NO_FILTER, ...none, system: true, chainId: 421614 });
    expect(combined.total).toBe(1);

    const page = await listRelayRequestsForAdmin({ limit: 2, offset: 2, ...none });
    expect(page.total).toBe(4);
    expect(page.items.map((r) => r.kind)).toEqual(["vote", "claim"]);
  });
});
