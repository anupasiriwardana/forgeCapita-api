/**
 * Automatic milestone execution tests: mocked pg (answered by SQL text) and a fake chain/sender.
 * No network, no real key.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { AbiCoder } from "ethers";
import { readFileSync } from "node:fs";

const mockQuery = jest.fn();

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: mockQuery,
    connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
    end: jest.fn(),
  })),
}));

const { escrowInterface, registerRelayChain, clearRelayChains } = await import("../src/relay/chains.js");
const { runAutoExecOnce, startMilestoneAutoExec } = await import("../src/relay/milestoneAutoExec.js");
const { runRelayTick } = await import("../src/relay/relayWorker.js");

const RELAYER = "0x" + "99".repeat(20);
const ESCROW = "0x" + "ab".repeat(20);
const CHAIN_ID = 421614;
const PROJECT_ID = `${CHAIN_ID}:${ESCROW}`;
const KEY = `execute:${CHAIN_ID}:${ESCROW}:2`;
const REQUEST_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const TX_HASH = "0x" + "12".repeat(32);
const nowS = (): number => Math.floor(Date.now() / 1000);
const coder = AbiCoder.defaultAbiCoder();
const selector = (name: string): string => escrowInterface.getFunction(name)?.selector ?? "";
const executeData = escrowInterface.encodeFunctionData("executeMilestone");

function revertError(reason: string): Record<string, unknown> {
  const data = "0x08c379a0" + coder.encode(["string"], [reason]).slice(2);
  return { code: "CALL_EXCEPTION", data, reason: null };
}

interface ChainState {
  cancelled: boolean;
  completed: boolean;
  index: bigint;
  open: boolean;
  executed: boolean;
  votingEnd: bigint;
  revertWith?: string;
  sent: Array<Record<string, unknown>>;
  receipt: Record<string, unknown> | null;
}

function installChain(overrides: Partial<ChainState> = {}): ChainState {
  const state: ChainState = {
    cancelled: false,
    completed: false,
    index: 2n,
    open: true,
    executed: false,
    votingEnd: BigInt(nowS() - 3600),
    sent: [],
    receipt: null,
    ...overrides,
  };
  const provider = {
    getBalance: async () => 10n ** 18n,
    getFeeData: async () => ({ gasPrice: 100_000_000n, maxFeePerGas: 200_000_000n, maxPriorityFeePerGas: 1_000n }),
    call: async (tx: { data: string }) => {
      const sel = tx.data.slice(0, 10);
      if (sel === selector("projectCancelled")) return coder.encode(["bool"], [state.cancelled]);
      if (sel === selector("completed")) return coder.encode(["bool"], [state.completed]);
      if (sel === selector("currentMilestoneIndex")) return coder.encode(["uint256"], [state.index]);
      if (sel === selector("votingEndTime")) return coder.encode(["uint256"], [state.votingEnd]);
      if (sel === selector("milestones")) {
        return coder.encode(
          ["string", "uint256", "bool", "bool", "uint256", "uint256", "uint256"],
          ["m", 50n, state.open, state.executed, 0n, 0n, 0n]
        );
      }
      if (state.revertWith !== undefined) throw revertError(state.revertWith);
      return "0x";
    },
    estimateGas: async () => 100_000n,
    getTransactionReceipt: async () => state.receipt,
    getBlockNumber: async () => 101,
  };
  const sender = {
    address: RELAYER,
    getNonce: async () => 7,
    send: async (req: Record<string, unknown>) => {
      state.sent.push(req);
      return TX_HASH;
    },
  };
  registerRelayChain({
    chainId: CHAIN_ID,
    provider: provider as never,
    sender,
    maxGasPriceWei: 1_000_000_000n,
    minBalanceWei: 1000n,
  });
  return state;
}

interface DbState {
  candidates: Array<Record<string, unknown>>;
  history: Array<Record<string, unknown>>;
  /** Parameters of every INSERT INTO app.relay_requests. */
  inserts: Array<{ sql: string; params: unknown[] }>;
  statements: Array<{ sql: string; params: unknown[] }>;
  queued: Array<Record<string, unknown>>;
  sentRows: Array<Record<string, unknown>>;
}

function installDb(overrides: Partial<DbState> = {}): DbState {
  const db: DbState = {
    candidates: [{ project_id: PROJECT_ID, chain_id: CHAIN_ID, escrow_address: ESCROW, milestone_index: 2 }],
    history: [],
    inserts: [],
    statements: [],
    queued: [],
    sentRows: [],
    ...overrides,
  };
  const rows = (...r: unknown[]) => ({ rows: r, rowCount: r.length });
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql: unknown, params?: unknown) => {
    const text = String(sql);
    const values = (params ?? []) as unknown[];
    db.statements.push({ sql: text, params: values });
    if (text.includes("pg_try_advisory_lock")) return rows({ locked: true });
    if (text.includes('"ponder"."milestone"')) return rows(...db.candidates);
    if (text.includes("SELECT status, error_code, created_at")) return rows(...db.history);
    if (text.includes("INSERT INTO app.relay_requests")) {
      db.inserts.push({ sql: text, params: values });
      return rows({ id: REQUEST_ID, kind: "execute", chain_id: CHAIN_ID, project_id: PROJECT_ID, status: "QUEUED", expires_at: new Date() });
    }
    if (text.includes("SET status = 'SENDING'")) {
      const next = db.queued.shift();
      return next ? rows(next) : rows();
    }
    if (text.includes("WHERE status = 'SENT' AND chain_id")) return rows(...db.sentRows);
    return { rows: [], rowCount: 0 };
  });
  return db;
}

const queuedInserts = (db: DbState) => db.inserts.filter((i) => !i.sql.includes("'FAILED'"));
const failedInserts = (db: DbState) => db.inserts.filter((i) => i.sql.includes("'FAILED'"));

beforeEach(() => {
  clearRelayChains();
});

describe("job start", () => {
  it("is not started under NODE_ENV=test", () => {
    installChain();
    expect(startMilestoneAutoExec()).toBeNull();
  });

  it("src/index.ts wires the job into boot and shutdown", () => {
    const text = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(text).toContain("startMilestoneAutoExec()");
    expect(text).toContain("stopAutoExec ? stopAutoExec()");
  });
});

describe("run", () => {
  it("does nothing when no chain is enabled", async () => {
    const db = installDb();
    await runAutoExecOnce();
    expect(db.inserts).toHaveLength(0);
  });

  it("queues one execute row after the voting end when the simulation passes", async () => {
    installChain();
    const db = installDb();
    await runAutoExecOnce();
    expect(db.inserts).toHaveLength(1);
    const values = queuedInserts(db)[0]?.params ?? [];
    expect(values[0]).toBe("execute");
    expect(values[1]).toBe(CHAIN_ID);
    expect(values[3]).toBe(null);
    expect(values[4]).toBe(RELAYER);
    expect(JSON.parse(String(values[6]))).toEqual({ to: ESCROW, data: executeData });
    expect(values[7]).toBe(KEY);
    expect(executeData).toBe(selector("executeMilestone"));
    const candidateSql = db.statements.find((s) => s.sql.includes('"ponder"."milestone"'));
    expect(candidateSql?.params[2]).toBe(50);
  });

  it("does not queue before the on-chain voting end", async () => {
    installChain({ votingEnd: BigInt(nowS() + 3600) });
    const db = installDb();
    await runAutoExecOnce();
    expect(db.inserts).toHaveLength(0);
  });

  it("skips a milestone that already has a live row (no duplicate enqueue)", async () => {
    installChain();
    const db = installDb({ history: [{ status: "SENT", error_code: null, created_at: new Date() }] });
    await runAutoExecOnce();
    expect(db.inserts).toHaveLength(0);
  });

  it.each([
    ["cancelled", { cancelled: true }],
    ["completed", { completed: true }],
    ["executed", { executed: true }],
    ["voting closed", { open: false }],
    ["a different current milestone", { index: 3n }],
  ])("skips when the chain says %s", async (_name, override) => {
    installChain(override);
    const db = installDb();
    await runAutoExecOnce();
    expect(db.inserts).toHaveLength(0);
  });

  it("skips silently while milestones are frozen", async () => {
    installChain({ revertWith: "Milestones frozen" });
    const db = installDb();
    await runAutoExecOnce();
    expect(db.inserts).toHaveLength(0);
  });

  it("records one FAILED SELF_PAY row when the gas ceiling is exceeded, then never retries", async () => {
    installChain({ revertWith: "Gas ceiling exceeded" });
    const db = installDb();
    await runAutoExecOnce();
    expect(queuedInserts(db)).toHaveLength(0);
    expect(failedInserts(db)).toHaveLength(1);
    expect(failedInserts(db)[0]?.params).toEqual(
      expect.arrayContaining([KEY, "SELF_PAY"])
    );
    db.history.push({ status: "FAILED", error_code: "SELF_PAY", created_at: new Date(Date.now() - 2 * 3600_000) });
    await runAutoExecOnce();
    expect(db.inserts).toHaveLength(1);
  });

  it("records other reverts as attempts, spaced by an hour and capped", async () => {
    installChain({ revertWith: "Something odd" });
    const db = installDb();
    await runAutoExecOnce();
    expect(failedInserts(db)[0]?.params).toEqual(expect.arrayContaining(["SIMULATION_FAILED"]));
    const recent = { status: "FAILED", error_code: "SIMULATION_FAILED", created_at: new Date() };
    db.history.push(recent);
    await runAutoExecOnce();
    expect(db.inserts).toHaveLength(1);
    const old = new Date(Date.now() - 2 * 3600_000);
    db.history.splice(0, db.history.length, ...[1, 2, 3].map(() => ({ ...recent, created_at: old })));
    await runAutoExecOnce();
    expect(db.inserts).toHaveLength(1);
  });
});

describe("worker with execute rows", () => {
  it("sends an execute row and confirms it", async () => {
    const chain = installChain();
    const db = installDb({
      candidates: [],
      queued: [{ id: REQUEST_ID, kind: "execute", args: { to: ESCROW, data: executeData } }],
    });
    await runRelayTick();
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0]).toMatchObject({ to: ESCROW, data: executeData });
    expect(db.statements.find((s) => s.sql.includes("SET status = 'SENT'"))?.params).toEqual([REQUEST_ID, TX_HASH]);
    db.sentRows.push({ id: REQUEST_ID, tx_hash: TX_HASH });
    chain.receipt = { status: 1, blockNumber: 100, gasUsed: 90_000n, gasPrice: 100n };
    await runRelayTick();
    expect(db.statements.find((s) => s.sql.includes("SET status = 'CONFIRMED'"))?.params).toEqual([REQUEST_ID, "90000", "100"]);
  });
});
