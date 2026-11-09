import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import request from "supertest";
import { createApp } from "../../src/app.js";
import type { InflowEntry } from "../../src/audit/explorerClient.js";
import { runInflowOnce, INFLOW_LOCK_ID } from "../../src/audit/inflowJob.js";
import {
  insertInflows,
  listAuditWallets,
  listCursorsForProject,
  readCursor,
  writeCursor,
} from "../../src/audit/inflowRepository.js";
import { hashSessionToken } from "../../src/auth/session.js";
import {
  addr,
  bootstrapDatabase,
  closePool,
  createApprovedWallet,
  createSession,
  createUser,
  pgErrorOf,
  pool,
  resetData,
} from "./db.js";

beforeAll(bootstrapDatabase);
beforeEach(resetData);
afterAll(closePool);

const CHAIN = 421614;
const app = createApp();
const TOKEN = "a".repeat(43);
const hash = (n: number): string => "0x" + n.toString(16).padStart(64, "0");

function entry(n: number, overrides: Partial<InflowEntry> = {}): InflowEntry {
  return {
    kind: "native",
    entryRef: "",
    txHash: hash(n),
    tokenAddress: null,
    tokenSymbol: null,
    amount: 10n ** 18n + BigInt(n),
    fromAddress: addr(500),
    blockNumber: BigInt(1000 + n),
    blockTime: BigInt(1_700_000_000 + n),
    ...overrides,
  };
}

async function bindProject(userN: number, chainId: number, escrowN: number, approve = true): Promise<{ wallet: string; projectId: string }> {
  const user = await createUser(userN, "founder");
  const wallet = addr(7000 + userN);
  const walletId = approve
    ? await createApprovedWallet(user.id, wallet)
    : (
        await pool.query<{ id: string }>(
          "INSERT INTO app.founder_wallets (user_id, address, status) VALUES ($1, $2, 'pending') RETURNING id",
          [user.id, wallet]
        )
      ).rows[0]?.id;
  const escrow = addr(8000 + escrowN);
  const projectId = `${chainId}:${escrow}`;
  await pool.query(
    `INSERT INTO app.startup_profiles (project_id, chain_id, escrow_address, name, description, founder_wallet_id, shadow_wallet)
     VALUES ($1, $2, $3, 'n', 'd', $4, $5)`,
    [projectId, chainId, escrow, walletId, addr(9999)]
  );
  return { wallet, projectId };
}

async function rowCount(): Promise<number> {
  const result = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM app.inflow_records");
  return result.rows[0]?.n ?? 0;
}

describe("inflow_records", () => {
  it("insert is idempotent and stores exact amounts", async () => {
    const big = 123456789012345678901234567890n;
    expect(await insertInflows(CHAIN, addr(1), [entry(1, { amount: big }), entry(2)])).toBe(2);
    expect(await insertInflows(CHAIN, addr(1), [entry(1, { amount: big }), entry(2)])).toBe(0);
    expect(await rowCount()).toBe(2);
    const stored = await pool.query<{ amount: string }>("SELECT amount::text AS amount FROM app.inflow_records WHERE tx_hash = $1", [hash(1)]);
    expect(stored.rows[0]?.amount).toBe(big.toString());
  });

  it("keeps several entries of one tx apart by kind and entry_ref", async () => {
    const token = { kind: "erc20" as const, tokenAddress: addr(77), tokenSymbol: "TKN" };
    await insertInflows(CHAIN, addr(1), [
      entry(1),
      entry(1, { kind: "internal", entryRef: "0_1" }),
      entry(1, { kind: "internal", entryRef: "0_2" }),
      entry(1, { ...token, entryRef: "3" }),
      entry(1, { ...token, entryRef: "4" }),
    ]);
    expect(await rowCount()).toBe(5);
  });

  it("every CHECK constraint rejects a bad row", async () => {
    const insert = (overrides: Record<string, unknown>) => {
      const row = {
        chain_id: CHAIN,
        wallet_address: addr(1),
        tx_hash: hash(1),
        kind: "native",
        entry_ref: "",
        token_address: null,
        token_symbol: null,
        amount: "5",
        from_address: addr(2),
        block_number: 1,
        block_time: 1,
        ...overrides,
      };
      return pool.query(
        `INSERT INTO app.inflow_records (chain_id, wallet_address, tx_hash, kind, entry_ref, token_address,
           token_symbol, amount, from_address, block_number, block_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        Object.values(row)
      );
    };
    const cases: Array<[string, Record<string, unknown>]> = [
      ["inflow_records_chain_allowed", { chain_id: 1 }],
      ["inflow_records_wallet_format", { wallet_address: addr(255).toUpperCase().replace("0X", "0x") }],
      ["inflow_records_wallet_format", { wallet_address: "0x12" }],
      ["inflow_records_from_format", { from_address: "nope" }],
      ["inflow_records_tx_format", { tx_hash: "0x" + "A".repeat(64) }],
      ["inflow_records_kind_allowed", { kind: "burn" }],
      ["inflow_records_amount_positive", { amount: "0" }],
      ["inflow_records_amount_positive", { amount: "-1" }],
      ["inflow_records_token_by_kind", { kind: "erc20", token_address: null }],
      ["inflow_records_token_by_kind", { kind: "native", token_address: addr(3) }],
      ["inflow_records_token_by_kind", { kind: "internal", token_address: addr(3) }],
      ["inflow_records_token_format", { kind: "erc20", token_address: "0xZZ" }],
      ["inflow_records_symbol_length", { kind: "erc20", token_address: addr(3), token_symbol: "S".repeat(33) }],
    ];
    for (const [constraint, overrides] of cases) {
      const err = await pgErrorOf(insert(overrides));
      expect(err).toMatchObject({ code: "23514", constraint });
    }
    expect(await pgErrorOf(insert({ entry_ref: null }))).toMatchObject({ code: "23502" });
    await insert({});
    expect(await pgErrorOf(insert({}))).toMatchObject({ code: "23505", constraint: "inflow_records_unique_entry_uidx" });
    expect(await rowCount()).toBe(1);
  });
});

describe("inflow_cursors", () => {
  it("upserts, moves forward only, clears the error and bounds its length", async () => {
    expect(await readCursor(CHAIN, addr(1), "native")).toBe(0n);
    await writeCursor(CHAIN, addr(1), "native", 500n, null);
    expect(await readCursor(CHAIN, addr(1), "native")).toBe(500n);
    await writeCursor(CHAIN, addr(1), "native", 100n, "explorer request timed out");
    expect(await readCursor(CHAIN, addr(1), "native")).toBe(500n);
    const failed = await pool.query<{ last_error: string; last_polled_at: Date }>(
      "SELECT last_error, last_polled_at FROM app.inflow_cursors WHERE wallet_address = $1",
      [addr(1)]
    );
    expect(failed.rows[0]?.last_error).toBe("explorer request timed out");
    expect(failed.rows[0]?.last_polled_at).toBeInstanceOf(Date);
    await writeCursor(CHAIN, addr(1), "native", 600n, null);
    const cleared = await pool.query<{ last_error: string | null }>("SELECT last_error FROM app.inflow_cursors");
    expect(cleared.rows).toEqual([{ last_error: null }]);
    await writeCursor(CHAIN, addr(1), "erc20", 1n, "x".repeat(500));
    const long = await pool.query<{ n: number }>("SELECT char_length(last_error) AS n FROM app.inflow_cursors WHERE kind = 'erc20'");
    expect(long.rows[0]?.n).toBe(200);
    expect((await pool.query("SELECT 1 FROM app.inflow_cursors")).rowCount).toBe(2);
    expect(await pgErrorOf(pool.query("UPDATE app.inflow_cursors SET last_error = repeat('x', 201)"))).toMatchObject({ code: "23514" });
  });
});

describe("listAuditWallets", () => {
  it("returns only approved, bound wallets on enabled chains, never the legacy shadow_wallet", async () => {
    const a = await bindProject(1, CHAIN, 1);
    await bindProject(2, 97, 2);
    await bindProject(3, CHAIN, 3, false);
    const user = await createUser(4, "founder");
    await createApprovedWallet(user.id, addr(7004));
    await pool.query("UPDATE app.startup_profiles SET founder_wallet_id = NULL WHERE project_id = $1", [a.projectId]);
    await bindProject(5, CHAIN, 5);

    expect(await listAuditWallets([CHAIN], 50)).toEqual([{ chainId: CHAIN, address: addr(7005) }]);
    const both = await listAuditWallets([CHAIN, 97], 50);
    expect(both).toEqual([
      { chainId: 97, address: addr(7002) },
      { chainId: CHAIN, address: addr(7005) },
    ]);
    expect(both.map((w) => w.address)).not.toContain(addr(9999));
    expect(both.map((w) => w.address)).not.toContain(a.wallet);
    expect(await listAuditWallets([97], 50)).toEqual([{ chainId: 97, address: addr(7002) }]);
  });

  it("covers every wallet over successive passes (least recently polled first, batch limit)", async () => {
    for (let n = 1; n <= 3; n += 1) await bindProject(n, CHAIN, n);
    const first = await listAuditWallets([CHAIN], 2);
    expect(first.map((w) => w.address)).toEqual([addr(7001), addr(7002)]);
    for (const w of first) await writeCursor(w.chainId, w.address, "native", 1n, null);
    const second = await listAuditWallets([CHAIN], 2);
    expect(second.map((w) => w.address)).toEqual([addr(7003), addr(7001)]);
  });
});

describe("runInflowOnce", () => {
  it("never throws, records a short error per wallet when the explorer is not configured, and releases the lock", async () => {
    await bindProject(1, CHAIN, 1);
    await bindProject(2, CHAIN, 2);
    await expect(runInflowOnce()).resolves.toBeUndefined();
    const cursors = await pool.query<{ wallet_address: string; kind: string; last_error: string }>(
      "SELECT wallet_address, kind, last_error FROM app.inflow_cursors ORDER BY wallet_address, kind"
    );
    expect(cursors.rows).toHaveLength(6);
    expect(cursors.rows.every((r) => r.last_error === "explorer is not configured")).toBe(true);
    const lock = await pool.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS locked", [INFLOW_LOCK_ID]);
    expect(lock.rows[0]?.locked).toBe(true);
    await pool.query("SELECT pg_advisory_unlock($1::bigint)", [INFLOW_LOCK_ID]);
  });
});

describe("GET /api/v1/admin/inflows", () => {
  async function signIn(role: "investor" | "staff" | "admin"): Promise<string> {
    const user = await createUser(100 + (role === "staff" ? 1 : role === "admin" ? 2 : 3), role);
    await createSession(user.id, hashSessionToken(TOKEN));
    return `fc_session=${TOKEN}`;
  }

  it("answers 401 signed out and 403 to a non-staff user", async () => {
    expect((await request(app).get("/api/v1/admin/inflows")).status).toBe(401);
    const cookie = await signIn("investor");
    expect((await request(app).get("/api/v1/admin/inflows").set("Cookie", cookie)).status).toBe(403);
  });

  it("filters, pages, and returns cursors for a project without raw payloads", async () => {
    const a = await bindProject(1, CHAIN, 1);
    const b = await bindProject(2, 97, 2);
    await insertInflows(CHAIN, a.wallet, [
      entry(1),
      entry(2, { kind: "erc20", entryRef: "1", tokenAddress: addr(77), tokenSymbol: "TKN" }),
      entry(3, { kind: "internal", entryRef: "0_1" }),
    ]);
    await insertInflows(97, b.wallet, [entry(4)]);
    await writeCursor(CHAIN, a.wallet, "native", 1003n, null);
    await writeCursor(CHAIN, a.wallet, "erc20", 0n, "explorer request timed out");
    const cookie = await signIn("staff");
    const get = (query: string) => request(app).get(`/api/v1/admin/inflows${query}`).set("Cookie", cookie);

    const all = await get("");
    expect(all.status).toBe(200);
    expect(all.headers["cache-control"]).toBe("no-store");
    expect(all.body.data.total).toBe(4);
    expect(all.body.data.cursors).toBeUndefined();
    expect(all.body.data.items[0]).toMatchObject({
      id: expect.any(String),
      chainId: 97,
      walletAddress: b.wallet,
      txHash: hash(4),
      kind: "native",
      tokenAddress: null,
      amount: (10n ** 18n + 4n).toString(),
      amountFormatted: "1.000000000000000004",
      blockNumber: "1004",
      blockTime: String(1_700_000_004),
    });
    expect(Object.keys(all.body.data.items[0]).sort()).toEqual(
      ["amount", "amountFormatted", "blockNumber", "blockTime", "chainId", "firstSeenAt", "fromAddress", "id", "kind", "tokenAddress", "tokenSymbol", "txHash", "walletAddress"]
    );

    expect((await get("?chainId=97")).body.data.total).toBe(1);
    expect((await get("?kind=erc20")).body.data.items).toHaveLength(1);
    const page = await get("?limit=1&offset=1");
    expect(page.body.data).toMatchObject({ total: 4, limit: 1, offset: 1 });
    expect(page.body.data.items[0].txHash).toBe(hash(3));

    const byProject = await get(`?projectId=${a.projectId}`);
    expect(byProject.body.data.total).toBe(3);
    expect(byProject.body.data.items.every((i: { walletAddress: string }) => i.walletAddress === a.wallet)).toBe(true);
    expect(byProject.body.data.cursors).toEqual([
      { kind: "erc20", lastBlock: "0", lastPolledAt: expect.any(String), lastError: "explorer request timed out" },
      { kind: "native", lastBlock: "1003", lastPolledAt: expect.any(String), lastError: null },
    ]);
    const unknown = await get(`?projectId=${CHAIN}:${addr(1234)}`);
    expect(unknown.body.data).toMatchObject({ total: 0, items: [], cursors: [] });
    expect((await get("?limit=101")).status).toBe(400);
    expect((await get("?x=1")).status).toBe(400);
    expect(await listCursorsForProject(a.projectId)).toHaveLength(2);
  });
});
