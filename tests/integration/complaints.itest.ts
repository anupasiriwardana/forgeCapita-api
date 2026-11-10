import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import type { Express } from "express";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { hashSessionToken } from "../../src/auth/session.js";
import {
  addr,
  auditRows,
  bootstrapDatabase,
  closePool,
  createSession,
  createUser,
  insertPonderProject,
  pool,
  resetData,
} from "./db.js";

beforeAll(bootstrapDatabase);
beforeEach(resetData);
afterAll(closePool);

const CHAIN = 421614;
const ORIGIN = "http://localhost:3000";
const BODY_TEXT = "The roadmap claims shipped features that do not exist.";
const NOTE_TEXT = "Confirmed with the founder, fixed on the site.";

let app: Express;
beforeEach(() => {
  app = createApp();
});

async function cookieFor(n: number, role: "investor" | "founder" | "staff" | "admin" = "investor"): Promise<string> {
  const user = await createUser(n, role);
  const token = String(n).padStart(43, "c");
  await createSession(user.id, hashSessionToken(token));
  return `fc_session=${token}`;
}

async function project(n: number): Promise<string> {
  return insertPonderProject({ chainId: CHAIN, escrow: addr(8000 + n) });
}

function file(cookie: string | null, body: unknown, origin: string | null = ORIGIN) {
  let req = request(app).post("/api/v1/complaints");
  if (origin) req = req.set("Origin", origin);
  if (cookie) req = req.set("Cookie", cookie);
  return req.send(body as object);
}

function valid(projectId: string, category = "MISREPRESENTATION"): Record<string, unknown> {
  return { projectId, category, body: BODY_TEXT };
}

function patch(cookie: string | null, id: string, body: unknown, origin: string | null = ORIGIN) {
  let req = request(app).patch(`/api/v1/admin/complaints/${id}`);
  if (origin) req = req.set("Origin", origin);
  if (cookie) req = req.set("Cookie", cookie);
  return req.send(body as object);
}

describe("filing a complaint", () => {
  it("rejects signed-out requests and invalid input", async () => {
    const pid = await project(1);
    const cookie = await cookieFor(1);
    expect((await file(null, valid(pid))).status).toBe(401);
    const bad: unknown[] = [
      { ...valid(pid), projectId: "nope" },
      { ...valid(pid), projectId: `1:${addr(8001)}` },
      { ...valid(pid), body: "too short" },
      { ...valid(pid), evidenceUrl: "http://example.com/x" },
      { ...valid(pid), category: "RUDE" },
      { ...valid(pid), extra: true },
    ];
    for (const body of bad) expect((await file(cookie, body)).status).toBe(400);
    expect((await file(cookie, valid(pid), null)).status).toBe(403);
    expect((await file(cookie, valid(`${CHAIN}:${addr(9999)}`))).status).toBe(404);
    expect(await auditRows()).toEqual([]);
  });

  it("creates a complaint and writes one audit row without the text", async () => {
    const pid = await project(1);
    const cookie = await cookieFor(1);
    const res = await file(cookie, { ...valid(pid), evidenceUrl: "https://example.com/proof" });
    expect(res.status).toBe(201);
    const id = (res.body as { data: { complaint: { id: string } } }).data.complaint.id;
    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "complaint.create",
      target: addr(8001),
      before_value: "NONE",
      after_value: `OPEN#${id}`,
    });
    expect(JSON.stringify(audit)).not.toContain(BODY_TEXT);
  });

  it("blocks a duplicate active complaint, allows another category and a new one after closing", async () => {
    const pid = await project(1);
    const cookie = await cookieFor(1);
    const staff = await cookieFor(2, "staff");
    const first = await file(cookie, valid(pid));
    expect(first.status).toBe(201);
    expect((await file(cookie, valid(pid))).status).toBe(409);
    expect((await file(cookie, valid(pid, "SECURITY"))).status).toBe(201);
    const id = (first.body as { data: { complaint: { id: string } } }).data.complaint.id;
    expect((await patch(staff, id, { status: "DISMISSED", note: NOTE_TEXT })).status).toBe(200);
    expect((await file(cookie, valid(pid))).status).toBe(201);
  });

  it("answers 429 on the sixth complaint within 24 hours", async () => {
    const cookie = await cookieFor(1);
    for (let i = 1; i <= 5; i++) expect((await file(cookie, valid(await project(i)))).status).toBe(201);
    const sixth = await file(cookie, valid(await project(6)));
    expect(sixth.status).toBe(429);
    await pool.query("UPDATE app.complaints SET created_at = now() - interval '25 hours'");
    expect((await file(cookie, valid(await project(7)))).status).toBe(201);
  });
});

describe("reading complaints", () => {
  it("GET /mine returns the caller's rows with the staff note, to nobody else, and leaks no staff identity", async () => {
    const pid = await project(1);
    const mine = await cookieFor(1);
    const other = await cookieFor(2);
    const staff = await cookieFor(3, "staff");
    const created = await file(mine, valid(pid));
    await file(other, valid(pid));
    const id = (created.body as { data: { complaint: { id: string } } }).data.complaint.id;
    await patch(staff, id, { status: "RESOLVED", note: NOTE_TEXT });

    const res = await request(app).get("/api/v1/complaints/mine").set("Cookie", mine);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const items = (res.body as { data: { items: Array<Record<string, unknown>> } }).data.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id, status: "RESOLVED", staffNote: NOTE_TEXT });
    expect(typeof items[0]?.["updatedAt"]).toBe("string");
    expect(typeof items[0]?.["resolvedAt"]).toBe("string");
    const staffRow = (await pool.query<{ id: string }>("SELECT id FROM app.users WHERE wallet_address = $1", [addr(3)])).rows[0];
    const serialized = JSON.stringify(res.body);
    expect(items[0]).not.toHaveProperty("reporterAddress");
    expect(serialized.toLowerCase()).not.toContain(addr(3).toLowerCase());
    expect(serialized).not.toContain(`"${staffRow?.id ?? "missing"}"`);

    const others = await request(app).get("/api/v1/complaints/mine").set("Cookie", other);
    const otherItems = (others.body as { data: { items: Array<Record<string, unknown>> } }).data.items;
    expect(otherItems).toHaveLength(1);
    expect(otherItems[0]?.["staffNote"]).toBeNull();
    expect(JSON.stringify(others.body)).not.toContain(NOTE_TEXT);
    expect((await request(app).get("/api/v1/complaints/mine")).status).toBe(401);
  });
});

describe("staff handling", () => {
  it("forbids non-staff and lists with reporter address and note for staff", async () => {
    const pid = await project(1);
    const reporter = await cookieFor(1);
    const staff = await cookieFor(2, "staff");
    const investor = await cookieFor(3);
    const created = await file(reporter, valid(pid));
    const id = (created.body as { data: { complaint: { id: string } } }).data.complaint.id;

    expect((await request(app).get("/api/v1/admin/complaints").set("Cookie", investor)).status).toBe(403);
    expect((await patch(investor, id, { status: "INVESTIGATING" })).status).toBe(403);

    const list = await request(app).get("/api/v1/admin/complaints?status=OPEN").set("Cookie", staff);
    expect(list.status).toBe(200);
    const data = (list.body as { data: { total: number; items: Array<Record<string, unknown>> } }).data;
    expect(data.total).toBe(1);
    expect(data.items[0]).toMatchObject({ reporterAddress: addr(1), staffNote: null, body: BODY_TEXT });
    expect((await request(app).get("/api/v1/admin/complaints?limit=101").set("Cookie", staff)).status).toBe(400);
  });

  it("changes status transactionally with an audit row and enforces transitions", async () => {
    const pid = await project(1);
    const reporter = await cookieFor(1);
    const staff = await cookieFor(2, "staff");
    const created = await file(reporter, valid(pid));
    const id = (created.body as { data: { complaint: { id: string } } }).data.complaint.id;

    expect((await patch(staff, id, { status: "RESOLVED" })).status).toBe(400);
    expect((await patch(staff, id, { status: "DISMISSED", note: " " })).status).toBe(400);
    expect((await patch(staff, id, { status: "INVESTIGATING" }, null)).status).toBe(403);
    expect((await patch(null, id, { status: "INVESTIGATING" })).status).toBe(401);
    expect((await patch(staff, "999999", { status: "INVESTIGATING" })).status).toBe(404);
    expect((await patch(staff, id, { status: "OPEN" })).status).toBe(409);

    const inv = await patch(staff, id, { status: "INVESTIGATING" });
    expect(inv.status).toBe(200);
    const done = await patch(staff, id, { status: "RESOLVED", note: NOTE_TEXT });
    expect(done.status).toBe(200);
    expect((done.body as { data: { complaint: Record<string, unknown> } }).data.complaint).toMatchObject({
      status: "RESOLVED",
      staffNote: NOTE_TEXT,
    });
    expect((await patch(staff, id, { status: "INVESTIGATING" })).status).toBe(409);

    const staffId = (await pool.query<{ id: string }>("SELECT id FROM app.users WHERE wallet_address = $1", [addr(2)])).rows[0]?.id;
    const audit = (await auditRows()).filter((r) => r.action === "complaint.status");
    expect(audit.map((r) => [r.before_value, r.after_value, r.actor_user_id, r.target])).toEqual([
      ["OPEN", `INVESTIGATING#${id}`, staffId, addr(8001)],
      ["INVESTIGATING", `RESOLVED#${id}`, staffId, addr(8001)],
    ]);
    const everything = JSON.stringify(await auditRows());
    expect(everything).not.toContain(BODY_TEXT);
    expect(everything).not.toContain(NOTE_TEXT);
  });
});
