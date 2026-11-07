/**
 * Gasless relayer tests. The pg module is mocked and answered by SQL text; the chain is a fake
 * provider and sender (no network, no real key). Signatures are produced with real ethers wallets
 * so the EIP-712 and ERC-2612 verification paths run for real.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { AbiCoder, Interface, Wallet } from "ethers";
import request from "supertest";
import { ALLOWED_ORIGIN, SESSION_COOKIE_HEADER, mockSession } from "./authHelpers.js";

const mockQuery = jest.fn();

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: mockQuery,
    connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
    end: jest.fn(),
  })),
}));

const { createApp } = await import("../src/app.js");
const chainsModule = await import("../src/relay/chains.js");
const { runRelayTick, recoverRelayState, startRelayWorker, pickFees } = await import("../src/relay/relayWorker.js");
const { mapSimulationError } = await import("../src/relay/relayErrors.js");
const { escrowInterface, tokenInterface, registerRelayChain, clearRelayChains } = chainsModule;
const app = createApp();

const user = new Wallet("0x" + "00".repeat(31) + "02");
const stranger = new Wallet("0x" + "00".repeat(31) + "03");
const ACCOUNT = user.address.toLowerCase();
const RELAYER = "0x" + "99".repeat(20);
const ESCROW = "0x" + "ab".repeat(20);
const DISTRIBUTOR = "0x" + "cd".repeat(20);
const TOKEN = "0x" + "ef".repeat(20);
const CHAIN_ID = 421614;
const PROJECT_ID = `${CHAIN_ID}:${ESCROW}`;
const USER_ID = "11111111-1111-1111-1111-111111111111";
const REQUEST_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const TX_HASH = "0x" + "12".repeat(32);

const nowS = (): number => Math.floor(Date.now() / 1000);

function revertError(reason: string): Record<string, unknown> {
  const data = "0x08c379a0" + AbiCoder.defaultAbiCoder().encode(["string"], [reason]).slice(2);
  return { code: "CALL_EXCEPTION", data, reason: null };
}

interface FakeChainOptions {
  balance?: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxGasPriceWei?: bigint;
  tokenBalance?: bigint;
  revertWith?: string;
}

interface FakeChain {
  sent: Array<Record<string, unknown>>;
  receipt: { value: Record<string, unknown> | null };
  head: { value: number };
  options: FakeChainOptions;
}

function installChain(options: FakeChainOptions = {}): FakeChain {
  const fake: FakeChain = { sent: [], receipt: { value: null }, head: { value: 101 }, options };
  const selectorOf = (iface: Interface, name: string): string => iface.getFunction(name)?.selector ?? "";
  const provider = {
    getBalance: async () => options.balance ?? 10n ** 18n,
    getFeeData: async () => ({
      gasPrice: options.gasPrice ?? 100_000_000n,
      maxFeePerGas: options.maxFeePerGas ?? 200_000_000n,
      maxPriorityFeePerGas: 1_000n,
    }),
    call: async (tx: { data: string }) => {
      const coder = AbiCoder.defaultAbiCoder();
      const selector = tx.data.slice(0, 10);
      if (selector === selectorOf(escrowInterface, "currentMilestoneIndex")) return coder.encode(["uint256"], [3n]);
      if (selector === selectorOf(tokenInterface, "name")) return coder.encode(["string"], ["Acme Token"]);
      if (selector === selectorOf(tokenInterface, "nonces")) return coder.encode(["uint256"], [5n]);
      if (selector === selectorOf(tokenInterface, "balanceOf")) {
        return coder.encode(["uint256"], [options.tokenBalance ?? 10n ** 24n]);
      }
      if (options.revertWith !== undefined) throw revertError(options.revertWith);
      return "0x";
    },
    estimateGas: async () => 100_000n,
    getTransactionReceipt: async () => fake.receipt.value,
    getBlockNumber: async () => fake.head.value,
  };
  const sender = {
    address: RELAYER,
    getNonce: async () => 7,
    send: async (req: Record<string, unknown>) => {
      fake.sent.push(req);
      return TX_HASH;
    },
  };
  registerRelayChain({
    chainId: CHAIN_ID,
    provider: provider as never,
    sender,
    maxGasPriceWei: options.maxGasPriceWei ?? 1_000_000_000n,
    minBalanceWei: 1000n,
  });
  return fake;
}

interface DbState {
  idem: Record<string, unknown> | null;
  userCount: number;
  chainCount: number;
  inserted: unknown[][];
  ownRow: Record<string, unknown> | null;
  queued: Array<Record<string, unknown>>;
  sentRows: Array<Record<string, unknown>>;
  statements: Array<{ sql: string; params: unknown[] }>;
}

function relayRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REQUEST_ID,
    kind: "claim",
    chain_id: CHAIN_ID,
    project_id: PROJECT_ID,
    status: "QUEUED",
    error_code: null,
    error_message: null,
    tx_hash: null,
    gas_used: null,
    effective_gas_price: null,
    created_at: new Date(1_700_000_000_000),
    sent_at: null,
    confirmed_at: null,
    expires_at: new Date(1_700_001_800_000),
    ...overrides,
  };
}

function installDb(state: Partial<DbState> = {}): DbState {
  const db: DbState = {
    idem: null,
    userCount: 0,
    chainCount: 0,
    inserted: [],
    ownRow: null,
    queued: [],
    sentRows: [],
    statements: [],
    ...state,
  };
  mockSession(mockQuery, "investor", ACCOUNT);
  const sessionImpl = mockQuery.getMockImplementation() as (sql: unknown, params?: unknown[]) => Promise<unknown>;
  const rows = (...r: unknown[]) => ({ rows: r, rowCount: r.length });
  mockQuery.mockImplementation(async (sql: unknown, params?: unknown) => {
    const text = String(sql);
    const values = (params ?? []) as unknown[];
    if (text.includes("FROM app.sessions s") || text.includes("UPDATE app.sessions")) return sessionImpl(sql);
    db.statements.push({ sql: text, params: values });
    if (text.includes('"ponder"."project"')) {
      return rows({
        id: PROJECT_ID,
        chain_id: CHAIN_ID,
        escrow_address: ESCROW,
        distributor_address: DISTRIBUTOR,
        token_address: TOKEN,
      });
    }
    if (text.includes("idem_key = $1 AND status NOT IN")) return db.idem ? rows(db.idem) : rows();
    if (text.includes("user_id = $1 AND created_at >")) return rows({ n: db.userCount });
    if (text.includes("chain_id = $1 AND created_at >")) return rows({ n: db.chainCount });
    if (text.includes("SET idem_key = idem_key")) return { rows: [], rowCount: 0 };
    if (text.includes("INSERT INTO app.relay_requests")) {
      db.inserted.push(values);
      return rows(relayRow({ kind: values[0], status: "QUEUED" }));
    }
    if (text.includes("id = $1 AND user_id = $2")) return db.ownRow ? rows(db.ownRow) : rows();
    if (text.includes("SET status = 'SENDING'")) {
      const next = db.queued.shift();
      return next ? rows(next) : rows();
    }
    if (text.includes("WHERE status = 'SENT' AND chain_id")) return rows(...db.sentRows);
    return { rows: [], rowCount: 0 };
  });
  return db;
}

function post(path: string, body: unknown) {
  return request(app).post(path).set("Origin", ALLOWED_ORIGIN).set("Cookie", SESSION_COOKIE_HEADER).send(body as object);
}

async function signVote(wallet: Wallet, support: boolean, deadline: number): Promise<string> {
  return wallet.signTypedData(
    { name: "ForgeCapita MilestoneEscrow", version: "1", chainId: CHAIN_ID, verifyingContract: ESCROW },
    {
      Vote: [
        { name: "voter", type: "address" },
        { name: "milestoneIndex", type: "uint256" },
        { name: "support", type: "bool" },
        { name: "deadline", type: "uint256" },
      ],
    },
    { voter: user.address, milestoneIndex: 3n, support, deadline }
  );
}

async function signPermit(wallet: Wallet, amount: bigint, deadline: number): Promise<string> {
  return wallet.signTypedData(
    { name: "Acme Token", version: "1", chainId: CHAIN_ID, verifyingContract: TOKEN },
    {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    { owner: user.address, spender: DISTRIBUTOR, value: amount, nonce: 5n, deadline }
  );
}

beforeEach(() => {
  mockQuery.mockReset();
  clearRelayChains();
});

describe("disabled relayer and access control", () => {
  it("fails closed with 503 RELAY_DISABLED while the app still serves other routes", async () => {
    installDb();
    const res = await post("/api/v1/relay/claim", { projectId: PROJECT_ID });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("RELAY_DISABLED");
    expect((await request(app).get("/health")).status).toBe(200);
  });

  it("requires a session and a same-origin request", async () => {
    installChain();
    expect((await request(app).post("/api/v1/relay/claim").set("Origin", ALLOWED_ORIGIN).send({ projectId: PROJECT_ID })).status).toBe(401);
    expect((await request(app).get("/api/v1/relay")).status).toBe(401);
    installDb();
    const noOrigin = await request(app).post("/api/v1/relay/claim").set("Cookie", SESSION_COOKIE_HEADER).send({ projectId: PROJECT_ID });
    expect(noOrigin.status).toBe(403);
  });

  it("rejects unknown fields and malformed input", async () => {
    installChain();
    installDb();
    const deadline = nowS() + 600;
    const sig = "0x" + "11".repeat(65);
    const bodies: Array<[string, unknown]> = [
      ["claim", { projectId: PROJECT_ID, extra: 1 }],
      ["claim", { projectId: "1:" + ESCROW }],
      ["vote", { projectId: PROJECT_ID, support: "yes", deadline, signature: sig }],
      ["vote", { projectId: PROJECT_ID, support: true, deadline: String(deadline), signature: sig }],
      ["vote", { projectId: PROJECT_ID, support: true, deadline, signature: "0x12" }],
      ["stake", { projectId: PROJECT_ID, amount: "1.5", deadline, signature: sig }],
      ["stake", { projectId: PROJECT_ID, amount: "0", deadline, signature: sig }],
      ["stake", { projectId: PROJECT_ID, amount: 5, deadline, signature: sig }],
      ["stake", { projectId: PROJECT_ID, amount: "1", deadline, signature: sig, owner: ACCOUNT }],
    ];
    for (const [kind, body] of bodies) {
      expect((await post(`/api/v1/relay/${kind}`, body)).status).toBe(400);
    }
    expect((await request(app).get("/api/v1/relay?limit=1000").set("Cookie", SESSION_COOKIE_HEADER)).status).toBe(400);
  });
});

describe("claim intake", () => {
  it("queues a claim for the session wallet and hides calldata", async () => {
    installChain();
    const db = installDb();
    const res = await post("/api/v1/relay/claim", { projectId: PROJECT_ID.toUpperCase().replace("0X", "0x") });
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ id: REQUEST_ID, status: "QUEUED" });
    const values = db.inserted[0] ?? [];
    expect(values[7]).toBe(`claim:${CHAIN_ID}:${ESCROW}:${ACCOUNT}`);
    expect(values[4]).toBe(ACCOUNT);
    expect(JSON.parse(String(values[6]))).toEqual({
      to: ESCROW,
      data: escrowInterface.encodeFunctionData("claimTokensFor", [ACCOUNT]),
    });
  });

  it("returns 200 with the same id on an idempotent repeat and inserts nothing", async () => {
    installChain();
    const db = installDb({ idem: relayRow({ status: "SENT" }) });
    const res = await post("/api/v1/relay/claim", { projectId: PROJECT_ID });
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(REQUEST_ID);
    expect(db.inserted).toHaveLength(0);
  });

  it("enforces the per-user and per-chain daily limits", async () => {
    installChain();
    installDb({ userCount: 20 });
    const user429 = await post("/api/v1/relay/claim", { projectId: PROJECT_ID });
    expect(user429.status).toBe(429);
    expect(user429.body.code).toBe("USER_DAILY_LIMIT");
    installDb({ chainCount: 500 });
    expect((await post("/api/v1/relay/claim", { projectId: PROJECT_ID })).body.code).toBe("CHAIN_DAILY_LIMIT");
  });

  it("rejects when gas is above the cap or the relayer is low on funds", async () => {
    installChain({ gasPrice: 5_000_000_000n });
    const db = installDb();
    const res = await post("/api/v1/relay/claim", { projectId: PROJECT_ID });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("GAS_TOO_HIGH");
    clearRelayChains();
    installChain({ balance: 10n });
    expect((await post("/api/v1/relay/claim", { projectId: PROJECT_ID })).body.code).toBe("RELAYER_LOW_BALANCE");
    expect(db.inserted).toHaveLength(0);
  });

  it.each([
    ["Gas ceiling exceeded", 409, "SELF_PAY"],
    ["Already voted", 409, "ALREADY_VOTED"],
    ["No voting power (must stake tokens first)", 422, "NO_VOTING_POWER"],
    ["Voting period ended", 422, "VOTING_ENDED"],
    ["Tokens already claimed", 409, "ALREADY_CLAIMED"],
    ["Funding phase is still active", 422, "FUNDING_ACTIVE"],
    ["boom see https://rpc.example/key123", 422, "SIMULATION_FAILED"],
  ])("maps the simulation revert %p without inserting", async (reason, status, code) => {
    installChain({ revertWith: reason });
    const db = installDb();
    const res = await post("/api/v1/relay/claim", { projectId: PROJECT_ID });
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    expect(JSON.stringify(res.body)).not.toContain("https://");
    expect(db.inserted).toHaveLength(0);
  });
});

describe("vote and stake intake", () => {
  it("accepts a vote signed by the session wallet over the on-chain milestone index", async () => {
    installChain();
    const db = installDb();
    const deadline = nowS() + 600;
    const signature = await signVote(user, true, deadline);
    const res = await post("/api/v1/relay/vote", { projectId: PROJECT_ID, support: true, deadline, signature });
    expect(res.status).toBe(202);
    expect(db.inserted[0]?.[7]).toBe(`vote:${CHAIN_ID}:${ESCROW}:${ACCOUNT}:3`);
    expect(JSON.stringify(res.body)).not.toContain(signature);
  });

  it("rejects a vote whose signer is not the session wallet", async () => {
    installChain();
    const db = installDb();
    const deadline = nowS() + 600;
    const signature = await signVote(stranger, true, deadline);
    const res = await post("/api/v1/relay/vote", { projectId: PROJECT_ID, support: true, deadline, signature });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SIGNATURE_MISMATCH");
    expect(db.inserted).toHaveLength(0);
  });

  it("rejects expired and far-future deadlines", async () => {
    installChain();
    installDb();
    const signature = "0x" + "11".repeat(65);
    const past = await post("/api/v1/relay/vote", { projectId: PROJECT_ID, support: true, deadline: nowS() - 5, signature });
    expect(past.body.code).toBe("DEADLINE_EXPIRED");
    const far = await post("/api/v1/relay/vote", { projectId: PROJECT_ID, support: true, deadline: nowS() + 3 * 86_400, signature });
    expect(far.body.code).toBe("DEADLINE_TOO_FAR");
  });

  it("accepts a permit signed by the session wallet and rejects another signer or low balance", async () => {
    installChain();
    const db = installDb();
    const deadline = nowS() + 600;
    const amount = 1_000_000_000_000_000_000n;
    const good = await signPermit(user, amount, deadline);
    const ok = await post("/api/v1/relay/stake", { projectId: PROJECT_ID, amount: amount.toString(), deadline, signature: good });
    expect(ok.status).toBe(202);
    expect(db.inserted).toHaveLength(1);
    const bad = await signPermit(stranger, amount, deadline);
    const mismatch = await post("/api/v1/relay/stake", { projectId: PROJECT_ID, amount: amount.toString(), deadline, signature: bad });
    expect(mismatch.status).toBe(403);
    clearRelayChains();
    installChain({ tokenBalance: 1n });
    const low = await post("/api/v1/relay/stake", { projectId: PROJECT_ID, amount: amount.toString(), deadline, signature: good });
    expect(low.body.code).toBe("INSUFFICIENT_BALANCE");
    expect(db.inserted).toHaveLength(1);
  });
});

describe("reading requests", () => {
  it("returns only the caller's own request, without calldata", async () => {
    installChain();
    installDb({ ownRow: relayRow({ status: "CONFIRMED", tx_hash: TX_HASH }) });
    const res = await request(app).get(`/api/v1/relay/${REQUEST_ID}`).set("Cookie", SESSION_COOKIE_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.data.request.txHash).toBe(TX_HASH);
    expect(res.body.data.request.args).toBeUndefined();
    expect(res.headers["cache-control"]).toBe("no-store");
    installDb({ ownRow: null });
    expect((await request(app).get(`/api/v1/relay/${REQUEST_ID}`).set("Cookie", SESSION_COOKIE_HEADER)).status).toBe(404);
  });

  it("scopes SQL by user id", async () => {
    installChain();
    const db = installDb();
    await request(app).get(`/api/v1/relay/${REQUEST_ID}`).set("Cookie", SESSION_COOKIE_HEADER);
    const stmt = db.statements.find((s) => s.sql.includes("id = $1 AND user_id = $2"));
    expect(stmt?.params).toEqual([REQUEST_ID, USER_ID]);
  });
});

describe("worker", () => {
  const queuedRow = (): Record<string, unknown> => ({
    id: REQUEST_ID,
    kind: "claim",
    args: { to: ESCROW, data: escrowInterface.encodeFunctionData("claimTokensFor", [ACCOUNT]) },
  });
  const statementsMatching = (db: DbState, fragment: string) => db.statements.filter((s) => s.sql.includes(fragment));

  it("sends a queued request with a padded gas limit and the capped fee, then stores the hash", async () => {
    const chain = installChain({ maxGasPriceWei: 150_000_000n });
    const db = installDb({ queued: [queuedRow()] });
    await runRelayTick();
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0]).toMatchObject({
      to: ESCROW,
      nonce: 7,
      gasLimit: 130_000n,
      fees: { maxFeePerGas: 150_000_000n },
    });
    expect(statementsMatching(db, "SET status = 'SENT'")[0]?.params).toEqual([REQUEST_ID, TX_HASH]);
  });

  it("confirms after enough confirmations and records gas", async () => {
    const chain = installChain();
    const db = installDb({ sentRows: [{ id: REQUEST_ID, tx_hash: TX_HASH }] });
    chain.receipt.value = { status: 1, blockNumber: 100, gasUsed: 90_000n, gasPrice: 100n };
    chain.head.value = 100;
    await runRelayTick();
    expect(statementsMatching(db, "SET status = 'CONFIRMED'")).toHaveLength(0);
    chain.head.value = 101;
    await runRelayTick();
    expect(statementsMatching(db, "SET status = 'CONFIRMED'")[0]?.params).toEqual([REQUEST_ID, "90000", "100"]);
  });

  it("fails a request whose receipt reverted", async () => {
    const chain = installChain();
    const db = installDb({ sentRows: [{ id: REQUEST_ID, tx_hash: TX_HASH }] });
    chain.receipt.value = { status: 0, blockNumber: 100, gasUsed: 50_000n, gasPrice: 100n };
    await runRelayTick();
    const failed = statementsMatching(db, "SET status = 'FAILED'");
    expect(failed[0]?.params.slice(0, 3)).toEqual([REQUEST_ID, "REVERTED", "The transaction reverted on chain."]);
  });

  it("fails (never sends) when the re-simulation reverts or gas is above the cap", async () => {
    const reverting = installChain({ revertWith: "Already voted" });
    let db = installDb({ queued: [queuedRow()] });
    await runRelayTick();
    expect(reverting.sent).toHaveLength(0);
    expect(statementsMatching(db, "SET status = 'FAILED'")[0]?.params[1]).toBe("ALREADY_VOTED");
    clearRelayChains();
    const pricey = installChain({ gasPrice: 5_000_000_000n });
    db = installDb({ queued: [queuedRow()] });
    await runRelayTick();
    expect(pricey.sent).toHaveLength(0);
    expect(statementsMatching(db, "SET status = 'FAILED'")[0]?.params[1]).toBe("GAS_TOO_HIGH");
  });

  it("expires stale rows each tick and recovers interrupted SENDING rows at boot", async () => {
    installChain();
    const db = installDb();
    await runRelayTick();
    expect(statementsMatching(db, "SET status = 'EXPIRED'")).toHaveLength(1);
    await recoverRelayState();
    const interrupted = statementsMatching(db, "error_code = 'INTERRUPTED'");
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]?.sql).toContain("status = 'SENDING' AND tx_hash IS NULL");
  });

  it("does not send while the relayer balance is below the minimum", async () => {
    const chain = installChain({ balance: 1n });
    const db = installDb({ queued: [queuedRow()] });
    await runRelayTick();
    expect(chain.sent).toHaveLength(0);
    expect(statementsMatching(db, "SET status = 'SENDING'")).toHaveLength(0);
  });

  it("is not started under NODE_ENV=test", () => {
    installChain();
    expect(startRelayWorker()).toBeNull();
  });
});

describe("helpers", () => {
  it("pickFees refuses a price above the cap and caps the signed max fee", () => {
    const fee = { gasPrice: 10n, maxFeePerGas: 500n, maxPriorityFeePerGas: 7n, toJSON: () => ({}) };
    expect(pickFees(fee, 5n)).toBeNull();
    expect(pickFees(fee, 100n)).toEqual({ maxFeePerGas: 100n, maxPriorityFeePerGas: 7n });
    expect(pickFees({ ...fee, maxFeePerGas: null }, 100n)).toEqual({ gasPrice: 10n });
  });

  it("never leaks urls or unknown internals from simulation errors", () => {
    const err = mapSimulationError(new Error("connect to https://rpc.example/secretkey failed"));
    expect(err.code).toBe("SIMULATION_FAILED");
    expect(err.message).not.toContain("secretkey");
    expect(mapSimulationError({ code: "TIMEOUT" }).code).toBe("RELAY_UNAVAILABLE");
  });
});
