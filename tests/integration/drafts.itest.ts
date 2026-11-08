import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { attachDraft, cancelDraft, createDraft } from "../../src/drafts/draftService.js";
import {
  attachPendingDraft,
  cancelPendingDraft,
  findOwnDraft,
  insertDraft,
  listOwnDrafts,
} from "../../src/drafts/draftRepository.js";
import { reconcileDrafts } from "../../src/drafts/reconcile.js";
import { findProjectById } from "../../src/repositories/projectRepository.js";
import {
  addr,
  auditRows,
  bootstrapDatabase,
  closePool,
  createApprovedWallet,
  createUser,
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
const escrow = (n: number): string => addr(0xe00 + n);
const payload = { name: "Acme", description: "A SaaS", category: "defi", websiteUrl: "https://acme.example" };

async function founderWithWallet(n: number): Promise<{ user: TestUser; walletId: string }> {
  const user = await createUser(n, "founder");
  const walletId = await createApprovedWallet(user.id, addr(100 + n));
  return { user, walletId };
}

async function draftStatus(id: string): Promise<string | undefined> {
  const r = await pool.query<{ status: string }>("SELECT status FROM app.launch_drafts WHERE id = $1", [id]);
  return r.rows[0]?.status;
}

function newDraft(user: TestUser, walletId: string | null) {
  return { userId: user.id, walletAddress: user.address, chainId: CHAIN, founderWalletId: walletId, payload, ip: "3.3.3.3" };
}

describe("launch drafts: create, attach, cancel", () => {
  it("creates a pending draft with an audit row and the CTE outer SELECT works", async () => {
    const { user, walletId } = await founderWithWallet(1);
    const draft = await insertDraft(newDraft(user, walletId));
    expect(draft).toMatchObject({ status: "pending", name: "Acme", chainId: CHAIN, founderWalletId: walletId, escrowAddress: null });
    expect(await auditRows()).toEqual([
      { action: "launch_draft.create", target: user.address, before_value: null, after_value: "pending", actor_user_id: user.id },
    ]);
    expect(await findOwnDraft(draft.id, user.id)).toMatchObject({ name: "Acme" });
    expect(await findOwnDraft(draft.id, (await createUser(2)).id)).toBeNull();
    expect(await listOwnDrafts(user.id)).toHaveLength(1);
  });

  it("allows one active reservation per wallet (23505) and releases it on cancel", async () => {
    const { user, walletId } = await founderWithWallet(1);
    const first = await insertDraft(newDraft(user, walletId));
    const err = await pgErrorOf(insertDraft(newDraft(user, walletId)));
    expect(err).toMatchObject({ code: "23505", constraint: "launch_drafts_active_wallet_uidx" });

    const cancelled = await cancelPendingDraft(first.id, user.id, null);
    expect(cancelled).toMatchObject({ status: "cancelled", name: "Acme" });
    expect((await auditRows()).map((a) => a.action)).toEqual(["launch_draft.create", "launch_draft.cancel"]);
    await expect(insertDraft(newDraft(user, walletId))).resolves.toMatchObject({ status: "pending" });
  });

  it("attach sets the project key; an attached draft can not be cancelled; project key is unique", async () => {
    const { user, walletId } = await founderWithWallet(1);
    const second = await founderWithWallet(2);
    const d1 = await insertDraft(newDraft(user, walletId));
    const attached = await attachPendingDraft(d1.id, user.id, escrow(1));
    expect(attached).toMatchObject({ status: "attached", escrowAddress: escrow(1), projectId: `${CHAIN}:${escrow(1)}` });
    expect(await attachPendingDraft(d1.id, user.id, escrow(1))).toBeNull();
    expect(await cancelPendingDraft(d1.id, user.id, null)).toBeNull();

    const d2 = await insertDraft(newDraft(second.user, second.walletId));
    const err = await pgErrorOf(attachPendingDraft(d2.id, second.user.id, escrow(1)));
    expect(err).toMatchObject({ code: "23505", constraint: "launch_drafts_project_uidx" });
    expect(await attachPendingDraft(d1.id, second.user.id, escrow(9))).toBeNull();
  });

  it("services: createDraft for staff without a wallet, attach and cancel flows", async () => {
    const staff = await createUser(1, "staff");
    const created = await createDraft(
      { chainId: CHAIN, name: "Staff Co", description: "d" } as Parameters<typeof createDraft>[0],
      staff,
      null
    );
    expect(created).toMatchObject({ status: "pending", founderWalletId: null });
    const attached = await attachDraft(created.id, escrow(5), staff);
    expect(attached.status).toBe("attached");
    // idempotent for the same address, conflict for another one
    await expect(attachDraft(created.id, escrow(5), staff)).resolves.toMatchObject({ status: "attached" });
    await expect(attachDraft(created.id, escrow(6), staff)).rejects.toMatchObject({ status: 409 });
    await expect(cancelDraft(created.id, staff, null)).rejects.toMatchObject({ status: 409 });
  });
});

describe("reconcile CTE", () => {
  async function attachedDraft(user: TestUser, walletId: string | null, escrowAddr: string): Promise<string> {
    const d = await insertDraft(newDraft(user, walletId));
    await attachPendingDraft(d.id, user.id, escrowAddr);
    return d.id;
  }

  it("applies a draft once the indexer has the project with a matching developer", async () => {
    const { user, walletId } = await founderWithWallet(0xab);
    const id = await attachedDraft(user, walletId, escrow(1));

    // no project yet, wrong developer: nothing happens
    expect(await reconcileDrafts()).toEqual({ applied: 0, conflicts: 0, expired: 0 });
    await insertPonderProject({ chainId: CHAIN, escrow: escrow(1), developer: addr(0x999) });
    expect(await reconcileDrafts({ draftId: id })).toEqual({ applied: 0, conflicts: 0, expired: 0 });
    expect(await draftStatus(id)).toBe("attached");

    // developer matches (stored in mixed case to prove lower() handling)
    await pool.query("UPDATE ponder.project SET developer = '0x' || upper(substr($1::text, 3))", [user.address]);
    expect(await reconcileDrafts({ draftId: id })).toEqual({ applied: 1, conflicts: 0, expired: 0 });
    expect(await draftStatus(id)).toBe("applied");

    const profile = await pool.query(
      "SELECT project_id, name, description, category, website_url, founder_wallet_id, shadow_wallet FROM app.startup_profiles"
    );
    expect(profile.rows).toEqual([
      {
        project_id: `${CHAIN}:${escrow(1)}`,
        name: "Acme",
        description: "A SaaS",
        category: "defi",
        website_url: "https://acme.example",
        founder_wallet_id: walletId,
        shadow_wallet: addr(100 + 0xab),
      },
    ]);
    expect((await auditRows()).map((a) => a.action)).toEqual(["launch_draft.create", "launch_draft.apply"]);
    expect(await findProjectById(`${CHAIN}:${escrow(1)}`)).toMatchObject({ profile_name: "Acme" });
    // a second run finds nothing to do
    expect(await reconcileDrafts()).toEqual({ applied: 0, conflicts: 0, expired: 0 });
  });

  it("marks the draft as conflict when a profile already exists, without overwriting it", async () => {
    const { user, walletId } = await founderWithWallet(1);
    const id = await attachedDraft(user, walletId, escrow(1));
    await insertPonderProject({ chainId: CHAIN, escrow: escrow(1), developer: user.address });
    await pool.query(
      "INSERT INTO app.startup_profiles (project_id, chain_id, escrow_address, name, description) VALUES ($1, $2, $3, 'Existing', 'keep me')",
      [`${CHAIN}:${escrow(1)}`, CHAIN, escrow(1)]
    );
    expect(await reconcileDrafts()).toEqual({ applied: 0, conflicts: 1, expired: 0 });
    expect(await draftStatus(id)).toBe("conflict");
    const profile = await pool.query<{ name: string }>("SELECT name FROM app.startup_profiles");
    expect(profile.rows).toEqual([{ name: "Existing" }]);
    expect((await auditRows()).map((a) => a.action)).toEqual(["launch_draft.create", "launch_draft.conflict"]);
  });

  it("applies several drafts in one batch with correct counts", async () => {
    const a = await founderWithWallet(1);
    const b = await founderWithWallet(2);
    const c = await founderWithWallet(3);
    await attachedDraft(a.user, a.walletId, escrow(1));
    await attachedDraft(b.user, b.walletId, escrow(2));
    await attachedDraft(c.user, c.walletId, escrow(3));
    await insertPonderProject({ chainId: CHAIN, escrow: escrow(1), developer: a.user.address });
    await insertPonderProject({ chainId: CHAIN, escrow: escrow(2), developer: b.user.address });
    await insertPonderProject({ chainId: CHAIN, escrow: escrow(3), developer: c.user.address });
    await pool.query(
      "INSERT INTO app.startup_profiles (project_id, chain_id, escrow_address, name, description) VALUES ($1, $2, $3, 'Existing', 'x')",
      [`${CHAIN}:${escrow(3)}`, CHAIN, escrow(3)]
    );
    expect(await reconcileDrafts()).toEqual({ applied: 2, conflicts: 1, expired: 0 });
  });

  it("SKIP LOCKED: a draft locked by another transaction is skipped, then applied once released", async () => {
    const { user, walletId } = await founderWithWallet(1);
    const id = await attachedDraft(user, walletId, escrow(1));
    await insertPonderProject({ chainId: CHAIN, escrow: escrow(1), developer: user.address });

    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM app.launch_drafts WHERE id = $1 FOR UPDATE", [id]);
      // must return immediately (not block) and apply nothing
      expect(await reconcileDrafts({ draftId: id })).toEqual({ applied: 0, conflicts: 0, expired: 0 });
      await holder.query("ROLLBACK");
    } finally {
      holder.release();
    }
    expect(await draftStatus(id)).toBe("attached");
    expect(await reconcileDrafts({ draftId: id })).toEqual({ applied: 1, conflicts: 0, expired: 0 });
  });

  it("two concurrent reconcile calls never apply a draft twice", async () => {
    const drafts: string[] = [];
    for (let i = 1; i <= 6; i += 1) {
      const { user, walletId } = await founderWithWallet(i);
      drafts.push(await attachedDraft(user, walletId, escrow(i)));
      await insertPonderProject({ chainId: CHAIN, escrow: escrow(i), developer: user.address });
    }
    const results = await Promise.all([reconcileDrafts(), reconcileDrafts(), reconcileDrafts()]);
    const applied = results.reduce((sum, r) => sum + r.applied, 0);
    expect(applied).toBe(6);
    expect(results.reduce((sum, r) => sum + r.conflicts, 0)).toBe(0);
    const profiles = await pool.query("SELECT 1 FROM app.startup_profiles");
    expect(profiles.rowCount).toBe(6);
    const applyAudits = (await auditRows()).filter((a) => a.action === "launch_draft.apply");
    expect(applyAudits).toHaveLength(6);
  });

  it("expires stale pending drafts only (full run, not a single-draft run) and frees the wallet", async () => {
    const { user, walletId } = await founderWithWallet(1);
    const stale = await insertDraft(newDraft(user, walletId));
    await pool.query("UPDATE app.launch_drafts SET created_at = now() - interval '8 days' WHERE id = $1", [stale.id]);
    const other = await founderWithWallet(2);
    const fresh = await insertDraft(newDraft(other.user, other.walletId));

    expect(await reconcileDrafts({ draftId: stale.id })).toMatchObject({ expired: 0 });
    expect(await draftStatus(stale.id)).toBe("pending");
    expect(await reconcileDrafts()).toEqual({ applied: 0, conflicts: 0, expired: 1 });
    expect(await draftStatus(stale.id)).toBe("expired");
    expect(await draftStatus(fresh.id)).toBe("pending");
    await expect(insertDraft(newDraft(user, walletId))).resolves.toMatchObject({ status: "pending" });
  });
});
