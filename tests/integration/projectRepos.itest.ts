import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { findUnlinkedRepo, insertRepo, listRepos } from "../../src/repos/repoRepository.js";
import { attachPendingDraft, insertDraft } from "../../src/drafts/draftRepository.js";
import { reconcileDrafts } from "../../src/drafts/reconcile.js";
import type { RepoProvider } from "../../src/repos/repoProvider.js";
import { revokeRepoAccess } from "../../src/repos/repoService.js";
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

function repo(userId: string, repoId: number): Parameters<typeof insertRepo>[1] {
  return {
    userId,
    repoId,
    repoName: `fc-app-00000${repoId}`,
    fullName: `forge-org/fc-app-00000${repoId}`,
    htmlUrl: `https://github.com/forge-org/fc-app-00000${repoId}`,
    founderLogin: "octocat",
  };
}

const CHAIN = 421614;
const escrow = (n: number): string => addr(0xe00 + n);
const REPO_PROJECT = `${CHAIN}:${escrow(1)}`;

async function attachedDraft(user: TestUser, escrowAddr: string): Promise<string> {
  const walletId = await createApprovedWallet(user.id, addr(500 + Number(BigInt(user.address) % 1000n)));
  const d = await insertDraft({
    userId: user.id,
    walletAddress: user.address,
    chainId: CHAIN,
    founderWalletId: walletId,
    payload: { name: "Acme", description: "A SaaS", category: "defi" },
    ip: null,
  });
  await attachPendingDraft(d.id, user.id, escrowAddr);
  return d.id;
}

async function repoProject(id: string): Promise<string | null> {
  const r = await pool.query<{ project_id: string | null }>("SELECT project_id FROM app.project_repos WHERE id = $1", [id]);
  return r.rows[0]?.project_id ?? null;
}

async function linkAudits(): Promise<string[]> {
  return (await auditRows()).filter((a) => a.action === "repo.link").map((a) => `${a.target}|${a.before_value}|${a.after_value}`);
}

describe("reconcile links the founder's repo", () => {
  it("links on apply with a repo.link audit row, and a second run changes nothing", async () => {
    const user = await createUser(1, "founder");
    const repoId = await insertRepo(pool, repo(user.id, 1));
    await attachedDraft(user, escrow(1));
    await insertPonderProject({ chainId: CHAIN, escrow: escrow(1), developer: user.address });

    expect(await reconcileDrafts()).toMatchObject({ applied: 1, conflicts: 0 });
    expect(await repoProject(repoId)).toBe(REPO_PROJECT);
    expect(await linkAudits()).toEqual([`${user.address}|unlinked|linked`]);
    expect(await findUnlinkedRepo(pool, user.id)).toBeNull();

    expect(await reconcileDrafts()).toMatchObject({ applied: 0, conflicts: 0 });
    expect(await linkAudits()).toHaveLength(1);
  });

  it("does not link on conflict or while the draft is only attached", async () => {
    const user = await createUser(1, "founder");
    const repoId = await insertRepo(pool, repo(user.id, 1));
    await attachedDraft(user, escrow(1));
    expect(await repoProject(repoId)).toBeNull();

    await insertPonderProject({ chainId: CHAIN, escrow: escrow(1), developer: user.address });
    await pool.query(
      "INSERT INTO app.startup_profiles (project_id, chain_id, escrow_address, name, description) VALUES ($1, $2, $3, 'Existing', 'x')",
      [REPO_PROJECT, CHAIN, escrow(1)]
    );
    expect(await reconcileDrafts()).toMatchObject({ applied: 0, conflicts: 1 });
    expect(await repoProject(repoId)).toBeNull();
    expect(await linkAudits()).toEqual([]);
  });

  it("is a no-op for a founder without a repo and never touches another founder's repo", async () => {
    const withRepo = await createUser(1, "founder");
    const repoId = await insertRepo(pool, repo(withRepo.id, 1));
    const without = await createUser(2, "founder");
    await attachedDraft(without, escrow(2));
    await insertPonderProject({ chainId: CHAIN, escrow: escrow(2), developer: without.address });

    expect(await reconcileDrafts()).toMatchObject({ applied: 1, conflicts: 0 });
    expect(await repoProject(repoId)).toBeNull();
    expect(await linkAudits()).toEqual([]);
  });
});

describe("migration 019 and revokeRepoAccess", () => {
  it("allows the revoked status, still rejects unknown ones, and has revoked_at", async () => {
    const user = await createUser(1, "founder");
    const id = await insertRepo(pool, repo(user.id, 1));
    await pool.query("UPDATE app.project_repos SET collaborator_status = 'revoked', revoked_at = now() WHERE id = $1", [id]);
    const bad = await pgErrorOf(pool.query("UPDATE app.project_repos SET collaborator_status = 'nope' WHERE id = $1", [id]));
    expect(bad.constraint).toBe("project_repos_status_check");
  });

  it("revokes once: row marked, one audit row, repoProvisioned false, second call is a no-op", async () => {
    const admin = await createUser(1, "admin");
    const founder = await createUser(2, "founder");
    const id = await insertRepo(pool, repo(founder.id, 1));
    await pool.query("UPDATE app.project_repos SET collaborator_status = 'active', project_id = $2 WHERE id = $1", [id, REPO_PROJECT]);
    const removed: string[] = [];
    const provider = {
      removeCollaborator: async (name: string, login: string): Promise<void> => {
        removed.push(`${name}:${login}`);
      },
    } as unknown as RepoProvider;

    const first = await revokeRepoAccess(id, admin.id, "1.1.1.1", provider);
    expect(first.status).toBe("revoked");
    expect(first.revokedAt).not.toBeNull();
    await revokeRepoAccess(id, admin.id, "1.1.1.1", provider);
    expect(removed).toEqual(["fc-app-000001:octocat"]);
    const audits = (await auditRows()).filter((a) => a.action === "repo.revoke");
    expect(audits).toEqual([
      { action: "repo.revoke", target: founder.address, before_value: "active", after_value: "revoked", actor_user_id: admin.id },
    ]);
  });

  it("rolls back when the provider fails", async () => {
    const admin = await createUser(1, "admin");
    const founder = await createUser(2, "founder");
    const id = await insertRepo(pool, repo(founder.id, 1));
    const provider = {
      removeCollaborator: async (): Promise<void> => {
        throw new Error("provider down");
      },
    } as unknown as RepoProvider;
    await expect(revokeRepoAccess(id, admin.id, null, provider)).rejects.toThrow("provider down");
    const row = await pool.query<{ collaborator_status: string }>("SELECT collaborator_status FROM app.project_repos WHERE id = $1", [id]);
    expect(row.rows[0]?.collaborator_status).toBe("failed");
    expect((await auditRows()).filter((a) => a.action === "repo.revoke")).toEqual([]);
  });
});

describe("app.project_repos", () => {
  it("allows one unlinked repo per founder until it is linked to a project", async () => {
    const user = await createUser(1, "founder");
    const id = await insertRepo(pool, repo(user.id, 1));
    const second = await pgErrorOf(insertRepo(pool, repo(user.id, 2)));
    expect(second.code).toBe("23505");
    expect(second.constraint).toBe("project_repos_unlinked_user_uidx");

    await pool.query("UPDATE app.project_repos SET project_id = '421614:0x01' WHERE id = $1", [id]);
    expect(await findUnlinkedRepo(pool, user.id)).toBeNull();
    await insertRepo(pool, repo(user.id, 2));
    expect((await listRepos(user.id, 10, 0)).total).toBe(2);
  });

  it("rejects duplicate provider repo ids and malformed values", async () => {
    const a = await createUser(1, "founder");
    const b = await createUser(2, "founder");
    await insertRepo(pool, repo(a.id, 1));
    expect((await pgErrorOf(insertRepo(pool, repo(b.id, 1)))).constraint).toBe("project_repos_repo_unique");
    const badLogin = await pgErrorOf(insertRepo(pool, { ...repo(b.id, 3), founderLogin: "-bad" }));
    expect(badLogin.constraint).toBe("project_repos_founder_login_check");
    const badUrl = await pgErrorOf(insertRepo(pool, { ...repo(b.id, 4), htmlUrl: "http://github.com/x" }));
    expect(badUrl.constraint).toBe("project_repos_html_url_check");
  });
});
