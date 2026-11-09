import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { checkProject } from "../../src/audit/complianceJob.js";
import { listCheckableProjects, type CheckableProject } from "../../src/audit/complianceRepository.js";
import { insertInflows, writeCursor } from "../../src/audit/inflowRepository.js";
import type { InflowEntry } from "../../src/audit/explorerClient.js";
import { hashSessionToken } from "../../src/auth/session.js";
import {
  addr,
  auditRows,
  bootstrapDatabase,
  closePool,
  createApprovedWallet,
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
const TOLERANCE = 400;
const app = createApp();
const nowSec = (): number => Math.floor(Date.now() / 1000);
const DAY = 86_400;
let counter = 0;
const hash = (): string => "0x" + (++counter).toString(16).padStart(64, "0");

async function bindProject(n: number, chainId = CHAIN): Promise<{ project: CheckableProject; wallet: string }> {
  const user = await createUser(n, "founder");
  const wallet = addr(7000 + n);
  const walletId = await createApprovedWallet(user.id, wallet);
  const escrow = addr(8000 + n);
  const projectId = `${chainId}:${escrow}`;
  await pool.query(
    `INSERT INTO app.startup_profiles (project_id, chain_id, escrow_address, name, description, founder_wallet_id, shadow_wallet)
     VALUES ($1, $2, $3, 'secret name', 'd', $4, $5)`,
    [projectId, chainId, escrow, walletId, addr(9999)]
  );
  return { project: { projectId, chainId, escrow, wallet }, wallet };
}

async function inflow(chainId: number, wallet: string, amount: bigint, ageSec = 100, kind: InflowEntry["kind"] = "native"): Promise<void> {
  await insertInflows(chainId, wallet, [
    {
      kind,
      entryRef: kind === "native" ? "" : "1",
      txHash: hash(),
      tokenAddress: kind === "erc20" ? addr(77) : null,
      tokenSymbol: kind === "erc20" ? "TKN" : null,
      amount,
      fromAddress: addr(500),
      blockNumber: 1n,
      blockTime: BigInt(nowSec() - ageSec),
    },
  ]);
}

async function routed(project: CheckableProject, gross: bigint, ageSec = 100): Promise<void> {
  await pool.query(
    `INSERT INTO ponder.revenue_record (id, chain_id, router_address, project_id, payer, tx_from, gross, creator_cut,
       investor_cut, platform_fee, routed_to_stakers, block_number, timestamp, tx_hash)
     VALUES ($1, $2, $3, $4, $5, $5, $6, 0, 0, 0, true, 1, $7, $8)`,
    [hash(), project.chainId, addr(600), project.projectId, addr(501), gross.toString(), nowSec() - ageSec, hash()]
  );
}

async function healthy(project: CheckableProject): Promise<void> {
  for (const kind of ["native", "internal", "erc20"] as const) {
    await writeCursor(project.chainId, project.wallet, kind, 1n, null);
  }
}

async function cases(): Promise<Array<{ state: string; shortfall: number | null; observed: string | null; routed: string | null }>> {
  const result = await pool.query(
    `SELECT state, last_shortfall_bps AS shortfall, last_inflow_wei::text AS observed, last_routed_wei::text AS routed
     FROM app.compliance_cases ORDER BY id`
  );
  return result.rows;
}

describe("reconciliation", () => {
  it("exactly the tolerance is OK, one bps more flags and writes an audit row", async () => {
    const { project, wallet } = await bindProject(1);
    await healthy(project);
    await inflow(CHAIN, wallet, 10_000n);
    await routed(project, 9_600n);
    await checkProject(project, TOLERANCE);
    expect(await cases()).toEqual([{ state: "OK", shortfall: 400, observed: "10000", routed: "9600" }]);
    expect(await auditRows()).toEqual([]);

    await pool.query("DELETE FROM ponder.revenue_record");
    await routed(project, 9_599n);
    await checkProject(project, TOLERANCE);
    expect(await cases()).toEqual([{ state: "WARNED", shortfall: 401, observed: "10000", routed: "9599" }]);
    expect(await auditRows()).toEqual([
      { action: "compliance.warn", target: project.escrow, before_value: "OK", after_value: "WARNED", actor_user_id: null },
    ]);
  });

  it("routed >= observed is OK", async () => {
    const { project, wallet } = await bindProject(1);
    await healthy(project);
    await inflow(CHAIN, wallet, 1_000n);
    await routed(project, 1_000n);
    await checkProject(project, TOLERANCE);
    expect((await cases())[0]?.state).toBe("OK");
  });

  it("counts only native inflow inside the 30 day window", async () => {
    const { project, wallet } = await bindProject(1);
    await healthy(project);
    await inflow(CHAIN, wallet, 1_000n);
    await inflow(CHAIN, wallet, 5_000n, 100, "internal");
    await inflow(CHAIN, wallet, 7_000n, 100, "erc20");
    await inflow(CHAIN, wallet, 9_000n, 31 * DAY);
    await routed(project, 1_000n);
    await routed(project, 4_000n, 31 * DAY);
    await checkProject(project, TOLERANCE);
    expect(await cases()).toEqual([{ state: "OK", shortfall: 0, observed: "1000", routed: "1000" }]);
  });

  it("escalates after 14 days, auto-resolves, keeps one open case and audits every transition", async () => {
    const { project, wallet } = await bindProject(1);
    await healthy(project);
    await inflow(CHAIN, wallet, 10_000n);
    await checkProject(project, TOLERANCE);
    await checkProject(project, TOLERANCE);
    expect((await cases()).map((c) => c.state)).toEqual(["WARNED"]);

    await pool.query("UPDATE app.compliance_cases SET opened_at = now() - interval '15 days'");
    await checkProject(project, TOLERANCE);
    expect((await cases()).map((c) => c.state)).toEqual(["ESCALATED"]);

    await routed(project, 10_000n);
    await checkProject(project, TOLERANCE);
    expect((await cases()).map((c) => c.state)).toEqual(["RESOLVED"]);

    await checkProject(project, TOLERANCE);
    expect((await cases()).map((c) => c.state)).toEqual(["RESOLVED", "OK"]);
    const open = await pool.query("SELECT 1 FROM app.compliance_cases WHERE state IN ('OK','WARNED','ESCALATED')");
    expect(open.rowCount).toBe(1);
    expect((await auditRows()).map((r) => [r.action, r.before_value, r.after_value, r.actor_user_id])).toEqual([
      ["compliance.warn", "NONE", "WARNED", null],
      ["compliance.escalate", "WARNED", "ESCALATED", null],
      ["compliance.resolve", "ESCALATED", "RESOLVED", null],
    ]);
  });

  it("the database refuses a second open case for a project", async () => {
    const { project } = await bindProject(1);
    const insert = (): Promise<unknown> =>
      pool.query("INSERT INTO app.compliance_cases (project_id, chain_id, state) VALUES ($1, $2, 'WARNED')", [
        project.projectId,
        CHAIN,
      ]);
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: "23505" });
  });

  it("skips (no case) when a cursor holds an error or was never polled", async () => {
    const { project, wallet } = await bindProject(1);
    await inflow(CHAIN, wallet, 10_000n);
    expect(await checkProject(project, TOLERANCE)).toBe(false);
    await healthy(project);
    await writeCursor(CHAIN, wallet, "internal", 1n, "explorer request timed out");
    expect(await checkProject(project, TOLERANCE)).toBe(false);
    expect(await cases()).toEqual([]);
  });

  it("the job only lists projects on audited chains", async () => {
    await bindProject(1);
    await bindProject(2, 97);
    expect((await listCheckableProjects([CHAIN])).map((p) => p.chainId)).toEqual([CHAIN]);
  });
});

describe("GET /api/v1/projects/:projectId/transparency", () => {
  it("returns only public fields for an audited project, and not_checked before any check", async () => {
    const { project, wallet } = await bindProject(1);
    const url = `/api/v1/projects/${project.projectId}/transparency`;
    const before = await request(app).get(url);
    expect(before.status).toBe(200);
    expect(before.headers["cache-control"]).toBe("no-store");
    expect(before.body.data).toMatchObject({
      auditStatus: "audited",
      complianceState: "not_checked",
      shadowWallet: wallet,
      windowDays: 30,
      toleranceBps: 400,
      frozen: null,
    });

    await healthy(project);
    await inflow(CHAIN, wallet, 10_000n);
    await checkProject(project, TOLERANCE);
    await pool.query("UPDATE app.compliance_cases SET resolution_note = 'staff secret note'");
    const after = await request(app).get(url);
    expect(after.body.data).toMatchObject({
      complianceState: "WARNED",
      observedNative: "10000",
      routedNative: "0",
      shortfallBps: 10000,
      lastCheckedAt: expect.any(String),
    });
    expect(Object.keys(after.body.data).sort()).toEqual(
      ["auditStatus", "chainId", "complianceState", "frozen", "lastCheckedAt", "note", "observedNative", "projectId",
        "routedNative", "shadowWallet", "shortfallBps", "toleranceBps", "windowDays"]
    );
    const text = JSON.stringify(after.body);
    expect(text).not.toContain("staff secret note");
    expect(text).not.toContain("secret name");
    expect(text).not.toContain(addr(9999));
  });

  it("answers 404 for an unknown project and 400 for a bad id", async () => {
    expect((await request(app).get(`/api/v1/projects/${CHAIN}:${addr(1234)}/transparency`)).status).toBe(404);
    expect((await request(app).get("/api/v1/projects/nope/transparency")).status).toBe(400);
  });

  it("an unaudited chain gets the placeholder and never a case; a ponder-only project is known", async () => {
    const { project } = await bindProject(2, 97);
    const res = await request(app).get(`/api/v1/projects/${project.projectId}/transparency`);
    expect(res.body.data).toMatchObject({
      auditStatus: "unaudited",
      note: "Revenue audit unavailable on this chain: a paid explorer API plan is required",
      complianceState: null,
    });
    expect(await cases()).toEqual([]);

    const ponderOnly = await insertPonderProject({ chainId: CHAIN, escrow: addr(4321) });
    const known = await request(app).get(`/api/v1/projects/${ponderOnly}/transparency`);
    expect(known.status).toBe(200);
    expect(known.body.data).toMatchObject({ auditStatus: "audited", shadowWallet: null, complianceState: "not_checked" });
  });
});

describe("GET /api/v1/admin/compliance", () => {
  const TOKEN = "b".repeat(43);

  async function staffCookie(): Promise<string> {
    const user = await createUser(100, "staff");
    await createSession(user.id, hashSessionToken(TOKEN));
    return `fc_session=${TOKEN}`;
  }

  it("is staff only, filters by state and chain, and includes notes and numbers", async () => {
    expect((await request(app).get("/api/v1/admin/compliance")).status).toBe(401);
    const { project, wallet } = await bindProject(1);
    await healthy(project);
    await inflow(CHAIN, wallet, 10_000n);
    await checkProject(project, TOLERANCE);
    await pool.query("UPDATE app.compliance_cases SET resolution_note = 'note'");
    const cookie = await staffCookie();
    const get = (q: string) => request(app).get(`/api/v1/admin/compliance${q}`).set("Cookie", cookie);

    const all = await get("");
    expect(all.status).toBe(200);
    expect(all.body.data).toMatchObject({ total: 1, limit: 20, offset: 0 });
    expect(all.body.data.items[0]).toMatchObject({
      projectId: project.projectId,
      state: "WARNED",
      resolutionNote: "note",
      observedNative: "10000",
      routedNative: "0",
      shortfallBps: 10000,
    });
    expect((await get("?state=ESCALATED")).body.data.total).toBe(0);
    expect((await get(`?state=WARNED&chainId=${CHAIN}`)).body.data.total).toBe(1);
    expect((await get("?x=1")).status).toBe(400);
    expect((await get("?state=bogus")).status).toBe(400);
  });
});
