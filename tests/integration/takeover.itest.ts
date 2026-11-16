import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { AGREEMENT_VERSION } from "../../src/founders/agreement.js";
import { listHolders } from "../../src/takeover/takeoverRepository.js";
import { cancelCase, openCase, prepareCase, type OpenDeps } from "../../src/takeover/takeoverService.js";
import {
  addr,
  auditRows,
  bootstrapDatabase,
  closePool,
  createUser,
  insertPonderPosition,
  insertPonderProject,
  pgErrorOf,
  pool,
  resetData,
  type TestUser,
} from "./db.js";

beforeAll(bootstrapDatabase);
beforeEach(resetData);
afterAll(closePool);

const CHAIN = 421614;
const ESCROW = addr(0xe01);
const DEVELOPER = addr(903);
const REASON = "Developer abandoned the project and stopped responding.";

const FRESH: OpenDeps = {
  fetchHead: async () => ({ blockNumber: 1234n, blockTimestamp: Math.floor(Date.now() / 1000) - 10 }),
  maxLagSeconds: 300,
  now: Date.now,
  voteDays: 7,
  quorumPercent: 20,
};
const STALE: OpenDeps = { ...FRESH, fetchHead: async () => ({ blockNumber: 1n, blockTimestamp: Math.floor(Date.now() / 1000) - 3600 }) };

async function eligibleCandidate(n: number): Promise<TestUser> {
  const user = await createUser(n, "founder");
  await pool.query(
    `INSERT INTO app.founder_applications (user_id, wallet_address, project_name, summary, website_url, pitch_deck_url, status)
     VALUES ($1, $2, 'P', 'S', 'https://a.example', 'https://b.example', 'approved')`,
    [user.id, user.address]
  );
  await pool.query(
    `INSERT INTO app.agreement_acceptances (user_id, wallet_address, agreement_version, text_hash, typed_name, message, signature, issued_at)
     VALUES ($1, $2, $3, $4, 'Typed Name', 'm', 's', now())`,
    [user.id, user.address, AGREEMENT_VERSION, "a".repeat(64)]
  );
  return user;
}

async function setup(): Promise<{ staff: TestUser; admin: TestUser; candidate: TestUser; projectId: string }> {
  const staff = await createUser(1, "staff");
  const admin = await createUser(2, "admin");
  const candidate = await eligibleCandidate(3);
  const projectId = await insertPonderProject({ chainId: CHAIN, escrow: ESCROW, developer: DEVELOPER });
  return { staff, admin, candidate, projectId };
}

/** Prepares a case; by default the candidate acceptance (signature checks are covered in takeoverVote.itest.ts) is stored directly. */
async function prepare(staff: TestUser, candidate: TestUser, accepted = true): ReturnType<typeof prepareCase> {
  const created = await prepareCase(staff.id, { chainId: CHAIN, projectAddress: ESCROW, candidateWallet: candidate.address, reason: REASON, evidenceLinks: ["https://e.example/1"] }, null);
  if (accepted) {
    await pool.query(
      `UPDATE app.takeover_cases SET candidate_accepted_at = now(), candidate_acceptance_message = 'm',
         candidate_acceptance_signature = 's', candidate_acceptance_issued_at = now() WHERE id = $1`,
      [created.id]
    );
  }
  return created;
}

async function holderRows(caseId: string): Promise<number> {
  const r = await pool.query("SELECT 1 FROM app.takeover_snapshot_holders WHERE case_id = $1", [caseId]);
  return r.rowCount ?? 0;
}

describe("takeover case preparation", () => {
  it("prepares one case, allows only one active case per project and keeps the reason out of the audit", async () => {
    const { staff, candidate } = await setup();
    const created = await prepare(staff, candidate);
    expect(created.status).toBe("prepared");
    await expect(prepare(staff, candidate)).rejects.toMatchObject({ status: 409 });
    const audit = await auditRows();
    expect(audit).toEqual([{ action: "takeover.prepare", target: ESCROW, before_value: null, after_value: "prepared", actor_user_id: staff.id }]);
    expect(JSON.stringify(audit)).not.toContain("abandoned");

    const dup = await pgErrorOf(
      pool.query(
        `INSERT INTO app.takeover_cases (chain_id, project_id, candidate_wallet, candidate_user_id, reason, created_by)
         VALUES ($1, $2, $3, $4, 'x', $5)`,
        [CHAIN, `${CHAIN}:${ESCROW}`, candidate.address, candidate.id, staff.id]
      )
    );
    expect(dup.constraint).toBe("takeover_cases_active_project_uidx");
  });

  it("rejects an unapproved candidate, the sitting developer and an unknown project", async () => {
    const { staff } = await setup();
    const plain = await createUser(9, "investor");
    await expect(prepare(staff, plain)).rejects.toMatchObject({ status: 422 });
    await expect(
      prepareCase(staff.id, { chainId: CHAIN, projectAddress: ESCROW, candidateWallet: DEVELOPER, reason: REASON, evidenceLinks: [] }, null)
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      prepareCase(staff.id, { chainId: CHAIN, projectAddress: addr(0xdead), candidateWallet: plain.address, reason: REASON, evidenceLinks: [] }, null)
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("opening a takeover vote", () => {
  it("freezes the snapshot of staked holders only, is idempotent and audits short tokens", async () => {
    const { staff, admin, candidate, projectId } = await setup();
    await pool.query("UPDATE ponder.project SET total_staked = 300 WHERE id = $1", [projectId]);
    await insertPonderPosition(projectId, CHAIN, addr(11), "100", "7");
    await insertPonderPosition(projectId, CHAIN, addr(12), "200");
    await insertPonderPosition(projectId, CHAIN, addr(13), "0", "50");
    const created = await prepare(staff, candidate);

    const opened = await openCase(created.id, admin.id, null, FRESH);
    expect(opened.alreadyOpen).toBe(false);
    expect(opened.takeoverCase).toMatchObject({
      status: "vote_open",
      snapshotBlock: "1234",
      snapshotTotalStaked: "300",
      snapshotHolderCount: 2,
      developerAtOpen: DEVELOPER,
      quorumPercent: 20,
    });
    const window = await pool.query<{ days: string }>("SELECT round(extract(epoch FROM ends_at - opened_at) / 86400)::text AS days FROM app.takeover_cases WHERE id = $1", [created.id]);
    expect(window.rows[0]?.days).toBe("7");
    expect(await listHolders(created.id, 50, 0)).toEqual([
      { investorAddress: addr(12), stakedBalance: "200", unstakedBalance: "0" },
      { investorAddress: addr(11), stakedBalance: "100", unstakedBalance: "7" },
    ]);

    // Later position changes and a repeated open do not alter the frozen snapshot.
    await insertPonderPosition(projectId, CHAIN, addr(14), "999");
    const again = await openCase(created.id, admin.id, null, FRESH);
    expect(again.alreadyOpen).toBe(true);
    expect(again.takeoverCase.snapshotTotalStaked).toBe("300");
    expect(await holderRows(created.id)).toBe(2);

    const audit = (await auditRows()).filter((a) => a.action === "takeover.open");
    expect(audit).toEqual([{ action: "takeover.open", target: ESCROW, before_value: "prepared", after_value: "open h=2", actor_user_id: admin.id }]);
  });

  it("records a total mismatch as an audit warning, not a failure", async () => {
    const { staff, admin, candidate, projectId } = await setup();
    await pool.query("UPDATE ponder.project SET total_staked = 500 WHERE id = $1", [projectId]);
    await insertPonderPosition(projectId, CHAIN, addr(11), "100");
    const created = await prepare(staff, candidate);
    await openCase(created.id, admin.id, null, FRESH);
    const audit = (await auditRows()).find((a) => a.action === "takeover.open");
    expect(audit?.after_value).toBe("open h=1 total-diff");
  });

  it("requires the candidate acceptance and checks it before asking the indexer", async () => {
    const { staff, admin, candidate } = await setup();
    const created = await prepare(staff, candidate, false);
    const failing: OpenDeps = { ...FRESH, fetchHead: async () => { throw new Error("indexer must not be called"); } };
    await expect(openCase(created.id, admin.id, null, failing)).rejects.toMatchObject({ status: 409, message: "Candidate has not accepted" });
    const row = await pool.query<{ status: string }>("SELECT status FROM app.takeover_cases WHERE id = $1", [created.id]);
    expect(row.rows[0]?.status).toBe("prepared");
  });

  it("refuses a lagging indexer and leaves the case prepared with no holder rows", async () => {
    const { staff, admin, candidate, projectId } = await setup();
    await insertPonderPosition(projectId, CHAIN, addr(11), "100");
    const created = await prepare(staff, candidate);
    await expect(openCase(created.id, admin.id, null, STALE)).rejects.toMatchObject({ status: 503 });
    const row = await pool.query<{ status: string; snapshot_block: string | null }>("SELECT status, snapshot_block FROM app.takeover_cases WHERE id = $1", [created.id]);
    expect(row.rows[0]).toEqual({ status: "prepared", snapshot_block: null });
    expect(await holderRows(created.id)).toBe(0);
    expect((await auditRows()).some((a) => a.action === "takeover.open")).toBe(false);
  });

  it("refuses a project that is not ACTIVE", async () => {
    const { staff, admin, candidate, projectId } = await setup();
    const created = await prepare(staff, candidate);
    await pool.query("UPDATE ponder.project SET state = 'SHUTDOWN' WHERE id = $1", [projectId]);
    await expect(openCase(created.id, admin.id, null, FRESH)).rejects.toMatchObject({ status: 409 });
  });
});

describe("snapshot immutability and cancellation", () => {
  it("rejects UPDATE and DELETE of holder rows and changes to snapshot columns", async () => {
    const { staff, admin, candidate, projectId } = await setup();
    await insertPonderPosition(projectId, CHAIN, addr(11), "100");
    const created = await prepare(staff, candidate);
    await openCase(created.id, admin.id, null, FRESH);

    const upd = await pgErrorOf(pool.query("UPDATE app.takeover_snapshot_holders SET staked_balance = 1 WHERE case_id = $1", [created.id]));
    expect(upd.message).toMatch(/immutable/);
    const del = await pgErrorOf(pool.query("DELETE FROM app.takeover_snapshot_holders WHERE case_id = $1", [created.id]));
    expect(del.message).toMatch(/immutable/);
    const col = await pgErrorOf(pool.query("UPDATE app.takeover_cases SET snapshot_total_staked = 1 WHERE id = $1", [created.id]));
    expect(col.message).toMatch(/immutable/);
    expect(await holderRows(created.id)).toBe(1);
  });

  it("cancelling an open case keeps the snapshot and frees the project for a new case", async () => {
    const { staff, admin, candidate, projectId } = await setup();
    await insertPonderPosition(projectId, CHAIN, addr(11), "100");
    const created = await prepare(staff, candidate);
    await openCase(created.id, admin.id, null, FRESH);
    const cancelled = await cancelCase(created.id, admin.id, null);
    expect(cancelled).toMatchObject({ status: "cancelled", snapshotTotalStaked: "100" });
    expect(await holderRows(created.id)).toBe(1);
    expect((await auditRows()).map((a) => a.action)).toEqual(["takeover.prepare", "takeover.open", "takeover.cancel"]);
    await expect(prepare(staff, candidate)).resolves.toMatchObject({ status: "prepared" });
  });
});
