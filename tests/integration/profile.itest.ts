import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { findProfileWalletId, findProjectById, findProjects, upsertProfile } from "../../src/repositories/projectRepository.js";
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
} from "./db.js";

beforeAll(bootstrapDatabase);
beforeEach(resetData);
afterAll(closePool);

const CHAIN = 421614;
const escrow = (n: number): string => addr(0xe00 + n);
const projectId = (n: number): string => `${CHAIN}:${escrow(n)}`;

function body(n: number, overrides: Record<string, unknown> = {}) {
  return { projectId: projectId(n), name: `Acme ${n}`, description: "desc", ...overrides };
}

describe("profile upsert CTE with wallet binding", () => {
  it("creates a profile bound to a wallet with one bind audit row", async () => {
    const founder = await createUser(1, "founder");
    const walletId = await createApprovedWallet(founder.id, addr(100));
    const saved = await upsertProfile(body(1), { walletId, address: addr(100) }, { userId: founder.id, ip: "1.1.1.1" });
    expect(saved).toMatchObject({ name: "Acme 1", description: "desc", category: null });

    const row = await pool.query<{ chain_id: number; escrow_address: string; founder_wallet_id: string; shadow_wallet: string }>(
      "SELECT chain_id, escrow_address, founder_wallet_id, shadow_wallet FROM app.startup_profiles"
    );
    expect(row.rows[0]).toEqual({ chain_id: CHAIN, escrow_address: escrow(1), founder_wallet_id: walletId, shadow_wallet: addr(100) });
    expect(await findProfileWalletId(projectId(1))).toBe(walletId);
    expect(await auditRows()).toEqual([
      { action: "shadow_wallet.bind", target: addr(100), before_value: null, after_value: "bound", actor_user_id: founder.id },
    ]);
  });

  it("a text-only edit keeps the binding (COALESCE) and adds no audit row", async () => {
    const founder = await createUser(1, "founder");
    const walletId = await createApprovedWallet(founder.id, addr(100));
    await upsertProfile(body(1), { walletId, address: addr(100) }, { userId: founder.id, ip: null });
    const edited = await upsertProfile(body(1, { name: "Renamed", category: "defi", logoUrl: "https://x.example/l.png" }), null, {
      userId: founder.id,
      ip: null,
    });
    expect(edited).toMatchObject({ name: "Renamed", category: "defi", logo_url: "https://x.example/l.png" });
    expect(await findProfileWalletId(projectId(1))).toBe(walletId);
    const shadow = await pool.query<{ shadow_wallet: string }>("SELECT shadow_wallet FROM app.startup_profiles");
    expect(shadow.rows[0]?.shadow_wallet).toBe(addr(100));
    expect(await auditRows()).toHaveLength(1);

    // re-supplying the same binding is not a change either
    await upsertProfile(body(1), { walletId, address: addr(100) }, { userId: founder.id, ip: null });
    expect(await auditRows()).toHaveLength(1);
  });

  it("binding an existing unbound profile writes the audit row", async () => {
    const founder = await createUser(1, "founder");
    const walletId = await createApprovedWallet(founder.id, addr(100));
    await upsertProfile(body(1), null, { userId: founder.id, ip: null });
    expect(await findProfileWalletId(projectId(1))).toBeNull();
    expect(await auditRows()).toEqual([]);
    await upsertProfile(body(1), { walletId, address: addr(100) }, { userId: founder.id, ip: null });
    expect((await auditRows()).map((a) => a.action)).toEqual(["shadow_wallet.bind"]);
  });

  it("a wallet can be bound to one project only (23505)", async () => {
    const founder = await createUser(1, "founder");
    const walletId = await createApprovedWallet(founder.id, addr(100));
    await upsertProfile(body(1), { walletId, address: addr(100) }, { userId: founder.id, ip: null });
    const err = await pgErrorOf(upsertProfile(body(2), { walletId, address: addr(100) }, { userId: founder.id, ip: null }));
    expect(err).toMatchObject({ code: "23505", constraint: "startup_profiles_founder_wallet_uidx" });
    const profiles = await pool.query("SELECT 1 FROM app.startup_profiles");
    expect(profiles.rowCount).toBe(1);
    expect(await auditRows()).toHaveLength(1);
  });

  it("the project key CHECK rejects a mismatching id", async () => {
    const err = await pgErrorOf(
      pool.query(
        "INSERT INTO app.startup_profiles (project_id, chain_id, escrow_address, name, description) VALUES ($1, 1, $2, 'n', 'd')",
        [projectId(1), escrow(1)]
      )
    );
    expect(err.code).toBe("23514");
  });
});

describe("project reads joining the Ponder tables", () => {
  it("joins profiles, filters and escapes LIKE wildcards", async () => {
    const founder = await createUser(1, "founder");
    await insertPonderProject({ chainId: CHAIN, escrow: escrow(1), tokenName: "Alpha_Token", state: "ACTIVE" });
    await insertPonderProject({ chainId: CHAIN, escrow: escrow(2), tokenName: "AlphaXToken", state: "FUNDING" });
    await insertPonderProject({ chainId: 97, escrow: escrow(3), tokenName: "Beta", state: "ACTIVE" });
    await upsertProfile(body(1, { category: "defi" }), null, { userId: founder.id, ip: null });

    const byId = await findProjectById(projectId(1));
    expect(byId).toMatchObject({ id: projectId(1), profile_name: "Acme 1", profile_category: "defi", state: "ACTIVE" });
    expect(await findProjectById(projectId(2))).toMatchObject({ profile_project_id: null });
    expect(await findProjectById("nope")).toBeNull();

    const all = await findProjects({}, "created_at", "desc", 10, 0);
    expect(all.total).toBe(3);
    const withProfile = await findProjects({ hasProfile: true }, "total_raised", "asc", 10, 0);
    expect(withProfile.rows.map((r) => r.id)).toEqual([projectId(1)]);
    const withoutProfile = await findProjects({ hasProfile: false, chainId: CHAIN }, "funding_goal", "asc", 10, 0);
    expect(withoutProfile.rows.map((r) => r.id)).toEqual([projectId(2)]);
    const category = await findProjects({ category: "defi", state: "ACTIVE" }, "created_at", "asc", 10, 0);
    expect(category.total).toBe(1);
    // underscore must match literally, not as "any character"
    const literal = await findProjects({ q: "Alpha_" }, "created_at", "asc", 10, 0);
    expect(literal.rows.map((r) => r.id)).toEqual([projectId(1)]);
    const pct = await findProjects({ q: "%" }, "created_at", "asc", 10, 0);
    expect(pct.total).toBe(0);
    const ci = await findProjects({ q: "beta" }, "created_at", "asc", 10, 0);
    expect(ci.total).toBe(1);
  });
});
