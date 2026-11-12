import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { approveApplication, findApplicationById, listApplications, rejectApplication } from "../../src/applications/applicationRepository.js";
import { approve, reject, submitApplication } from "../../src/applications/applicationService.js";
import {
  approveShadowWallet,
  findApprovedWallet,
  insertAcceptance,
  insertShadowWallet,
  listOwnWallets,
  listShadowWallets,
  readLaunchChecks,
  rejectShadowWallet,
} from "../../src/founders/founderRepository.js";
import { approveWallet, requestShadowWallet } from "../../src/founders/founderService.js";
import { addr, auditRows, bootstrapDatabase, closePool, createSession, createUser, pgErrorOf, pool, resetData, type TestUser } from "./db.js";

beforeAll(bootstrapDatabase);
beforeEach(resetData);
afterAll(closePool);

const fields = {
  projectName: "Acme",
  summary: "A SaaS",
  websiteUrl: "https://acme.example",
  pitchDeckUrl: "https://acme.example/deck",
  repoUrl: undefined,
  contact: undefined,
  kycDocsUrl: "https://drive.google.com/drive/folders/abc",
  kycNote: undefined,
};

async function roleOf(user: TestUser): Promise<string | undefined> {
  const r = await pool.query<{ role: string }>("SELECT role FROM app.users WHERE id = $1", [user.id]);
  return r.rows[0]?.role;
}

describe("founder applications", () => {
  it("rejects a malformed KYC documents URL at the database", async () => {
    const user = await createUser(9);
    for (const bad of ["http://x.com/a", "https://u:p@x.com/a", "https://x.com/a b"]) {
      const err = await pgErrorOf(submitApplication(user, { ...fields, kycDocsUrl: bad }));
      expect(err).toMatchObject({ constraint: "founder_applications_kyc_docs_url_format" });
    }
  });

  it("submits a pending application and allows only one open application per wallet", async () => {
    const user = await createUser(1);
    const app = await submitApplication(user, fields);
    expect(app).toMatchObject({ status: "pending", walletAddress: user.address, repoUrl: null });
    await expect(submitApplication(user, fields)).rejects.toMatchObject({ status: 409 });
    const found = await findApplicationById(app.id);
    expect(found?.projectName).toBe("Acme");
    const list = await listApplications("pending", 10, 0);
    expect(list.total).toBe(1);
  });

  it("approve grants founder to an investor, revokes sessions and writes two audit rows", async () => {
    const reviewer = await createUser(1, "staff");
    const applicant = await createUser(2);
    const other = await createUser(3);
    await createSession(applicant.id, "a1");
    await createSession(other.id, "o1");
    const app = await submitApplication(applicant, fields);

    const outcome = await approve(reviewer, app.id, "ok", "5.5.5.5");
    expect(outcome).toMatchObject({ transitioned: true, roleChanged: true, previousStatus: "pending" });

    expect(await roleOf(applicant)).toBe("founder");
    const row = await findApplicationById(app.id);
    expect(row).toMatchObject({ status: "approved", reviewedBy: reviewer.id, kycVerifiedBy: reviewer.id, reviewNote: "ok" });
    expect(row?.kycVerifiedAt).toBeInstanceOf(Date);
    const sessions = await pool.query<{ user_id: string }>("SELECT user_id FROM app.sessions");
    expect(sessions.rows.map((s) => s.user_id)).toEqual([other.id]);
    expect((await auditRows()).map((a) => a.action).sort()).toEqual(["application.approve", "role.change"]);

    // approved still counts as open: a second application is refused
    await expect(submitApplication(applicant, fields)).rejects.toMatchObject({ status: 409 });
    // and a second approval is a no-op
    const again = await approveApplication(app.id, reviewer.id, null, null);
    expect(again).toMatchObject({ transitioned: false, roleChanged: false });
    expect(await auditRows()).toHaveLength(2);
  });

  it("does not downgrade a staff applicant and writes only the approval audit row", async () => {
    const reviewer = await createUser(1, "admin");
    const applicant = await createUser(2, "staff");
    await createSession(applicant.id, "a1");
    const app = await submitApplication(applicant, fields);
    const outcome = await approveApplication(app.id, reviewer.id, null, null);
    expect(outcome).toMatchObject({ transitioned: true, roleChanged: false });
    expect(await roleOf(applicant)).toBe("staff");
    expect((await auditRows()).map((a) => a.action)).toEqual(["application.approve"]);
    const sessions = await pool.query("SELECT 1 FROM app.sessions");
    expect(sessions.rowCount).toBe(1);
  });

  it("blocks self review and reports unknown ids", async () => {
    const staff = await createUser(1, "staff");
    const own = await submitApplication(staff, fields);
    expect(await approveApplication(own.id, staff.id, null, null)).toMatchObject({ transitioned: false });
    await expect(approve(staff, own.id, undefined, null)).rejects.toMatchObject({ status: 403 });
    expect((await findApplicationById(own.id))?.status).toBe("pending");
    expect(await auditRows()).toEqual([]);
    expect(await approveApplication("00000000-0000-4000-8000-000000000000", staff.id, null, null)).toBeNull();
    expect(await rejectApplication("00000000-0000-4000-8000-000000000000", staff.id, "n", null)).toBeNull();
  });

  it("reject records the note and audit row, and the founder may apply again", async () => {
    const reviewer = await createUser(1, "staff");
    const applicant = await createUser(2);
    const app = await submitApplication(applicant, fields);
    const outcome = await reject(reviewer, app.id, "not enough detail", "1.1.1.1");
    expect(outcome).toMatchObject({ transitioned: true, roleChanged: false });
    expect(await roleOf(applicant)).toBe("investor");
    expect((await auditRows()).map((a) => a.action)).toEqual(["application.reject"]);
    const again = await submitApplication(applicant, fields);
    expect(again.id).not.toBe(app.id);
    await expect(reject(reviewer, app.id, "x", null)).rejects.toMatchObject({ status: 409 });
  });

  it("kyc columns are only allowed on approved rows (CHECK)", async () => {
    const user = await createUser(1);
    const app = await submitApplication(user, fields);
    const err = await pgErrorOf(pool.query("UPDATE app.founder_applications SET kyc_verified_at = now() WHERE id = $1", [app.id]));
    expect(err.code).toBe("23514");
  });
});

describe("shadow wallets", () => {
  it("requests a pending wallet with an audit row; one pending per user", async () => {
    const founder = await createUser(1, "founder");
    const wallet = await insertShadowWallet(founder.id, founder.address, addr(100), "2.2.2.2");
    expect(wallet).toMatchObject({ status: "pending", address: addr(100), founderWallet: founder.address });
    expect(await auditRows()).toEqual([
      { action: "shadow_wallet.request", target: founder.address, before_value: null, after_value: "pending", actor_user_id: founder.id },
    ]);
    const err = await pgErrorOf(insertShadowWallet(founder.id, founder.address, addr(101), null));
    expect(err).toMatchObject({ code: "23505", constraint: "founder_wallets_pending_user_idx" });
    expect((await listShadowWallets("pending", 10, 0)).total).toBe(1);
  });

  it("approve, then a founder may request more wallets; approved addresses stay unique across founders", async () => {
    const staff = await createUser(1, "staff");
    const f1 = await createUser(2, "founder");
    const f2 = await createUser(3, "founder");
    const w1 = await insertShadowWallet(f1.id, f1.address, addr(100), null);
    expect(await approveShadowWallet(w1.id, staff.id, "ok", null)).toMatchObject({ transitioned: true, id: w1.id });
    expect((await findApprovedWallet({ address: addr(100) }))?.id).toBe(w1.id);
    expect(await findApprovedWallet({ id: w1.id })).toMatchObject({ reserved: false, bound: false, userId: f1.id });
    expect((await auditRows()).map((a) => a.action)).toEqual(["shadow_wallet.request", "shadow_wallet.approve"]);

    // pending index only covers pending rows: a second request is fine now
    const w1b = await insertShadowWallet(f1.id, f1.address, addr(101), null);
    expect(w1b.status).toBe("pending");

    // the same address requested by another founder may be pending, but not approved twice
    const w2 = await insertShadowWallet(f2.id, f2.address, addr(100), null);
    await expect(approveWallet(staff, w2.id, undefined, null)).rejects.toMatchObject({ status: 409 });
    expect((await pool.query<{ status: string }>("SELECT status FROM app.founder_wallets WHERE id = $1", [w2.id])).rows[0]?.status).toBe("pending");
    expect((await listOwnWallets(f1.id)).map((w) => w.status).sort()).toEqual(["approved", "pending"]);
  });

  it("reject, self-review block and non-pending no-op", async () => {
    const staff = await createUser(1, "staff");
    const own = await insertShadowWallet(staff.id, staff.address, addr(100), null);
    expect(await approveShadowWallet(own.id, staff.id, null, null)).toMatchObject({ transitioned: false });

    const founder = await createUser(2, "founder");
    const w = await insertShadowWallet(founder.id, founder.address, addr(101), null);
    expect(await rejectShadowWallet(w.id, staff.id, "bad address", null)).toMatchObject({ transitioned: true });
    expect(await rejectShadowWallet(w.id, staff.id, "again", null)).toMatchObject({ transitioned: false });
    expect(await approveShadowWallet("00000000-0000-4000-8000-000000000000", staff.id, null, null)).toBeNull();
    expect((await auditRows()).filter((a) => a.action === "shadow_wallet.reject")).toHaveLength(1);
  });

  it("service rejects the login wallet and a malformed address", async () => {
    const founder = await createUser(2, "founder");
    await expect(requestShadowWallet(founder, founder.address, null)).rejects.toMatchObject({ status: 400 });
    await expect(requestShadowWallet(founder, "0x123", null)).rejects.toMatchObject({ status: 400 });
    const ok = await requestShadowWallet(founder, addr(55).toUpperCase().replace("0X", "0x"), null);
    expect(ok.address).toBe(addr(55));
    await expect(requestShadowWallet(founder, addr(56), null)).rejects.toMatchObject({ status: 409 });
  });

  it("agreement acceptance is stored with its audit row and is unique per version", async () => {
    const founder = await createUser(1, "founder");
    const input = {
      userId: founder.id,
      walletAddress: founder.address,
      version: "v1",
      textHash: "a".repeat(64),
      typedName: "Jane Doe",
      message: "m",
      signature: "0xsig",
      issuedAt: new Date(),
      ip: null,
    };
    const accepted = await insertAcceptance(input);
    expect(accepted).toMatchObject({ version: "v1", textHash: "a".repeat(64) });
    expect((await pgErrorOf(insertAcceptance(input))).code).toBe("23505");
    expect((await auditRows()).map((a) => a.action)).toEqual(["agreement.accept"]);
  });

  it("readLaunchChecks reflects application, agreement and an available wallet", async () => {
    const staff = await createUser(1, "staff");
    const founder = await createUser(2);
    expect(await readLaunchChecks(founder.id, "v1")).toEqual({
      applicationApproved: false,
      agreementAccepted: false,
      shadowWalletAvailable: false,
    });
    const app = await submitApplication(founder, fields);
    await approveApplication(app.id, staff.id, null, null);
    const w = await insertShadowWallet(founder.id, founder.address, addr(100), null);
    await approveShadowWallet(w.id, staff.id, null, null);
    await insertAcceptance({
      userId: founder.id, walletAddress: founder.address, version: "v1", textHash: "b".repeat(64),
      typedName: "Jane Doe", message: "m", signature: "s", issuedAt: new Date(), ip: null,
    });
    expect(await readLaunchChecks(founder.id, "v1")).toEqual({
      applicationApproved: true,
      agreementAccepted: true,
      shadowWalletAvailable: true,
    });
  });
});
