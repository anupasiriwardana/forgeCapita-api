import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import {
  claimNextQueued,
  countChainSince24h,
  countUserSince24h,
  executeHistory,
  expireStale,
  failInterrupted,
  findActiveByIdemKey,
  findOwnRequest,
  findRelayProject,
  insertRelayRequest,
  listExecuteCandidates,
  listOwnRequests,
  listSent,
  markConfirmed,
  markFailed,
  markSent,
  recordExecuteFailure,
  type NewRelayRequest,
} from "../../src/relay/relayRepository.js";
import { recoverRelayState } from "../../src/relay/relayWorker.js";
import {
  addr,
  bootstrapDatabase,
  closePool,
  createUser,
  insertPonderMilestone,
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
const executeKey = (n: number, milestone: number): string => `execute:${CHAIN}:${escrow(n)}:${milestone}`;

function request(user: TestUser | null, idemKey: string, overrides: Partial<NewRelayRequest> = {}): NewRelayRequest {
  return {
    kind: "claim",
    chainId: CHAIN,
    projectId: `${CHAIN}:${escrow(1)}`,
    userId: user?.id ?? null,
    account: user?.address ?? addr(0xfee),
    payload: { note: "summary" },
    args: { to: escrow(1), data: "0xdeadbeef" },
    idemKey,
    expiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  };
}

async function setCreatedAt(id: string, secondsAgo: number): Promise<void> {
  await pool.query("UPDATE app.relay_requests SET created_at = now() - make_interval(secs => $2) WHERE id = $1", [id, secondsAgo]);
}

async function statusOf(id: string): Promise<string | undefined> {
  const r = await pool.query<{ status: string }>("SELECT status FROM app.relay_requests WHERE id = $1", [id]);
  return r.rows[0]?.status;
}

describe("relay intake", () => {
  it("inserts a QUEUED row; a duplicate idem_key returns null and the live row stays findable", async () => {
    const user = await createUser(1);
    const first = await insertRelayRequest(request(user, "k1"));
    expect(first).toMatchObject({ kind: "claim", status: "QUEUED", chainId: CHAIN, txHash: null });
    expect(first).not.toHaveProperty("args");
    expect(await insertRelayRequest(request(user, "k1"))).toBeNull();
    expect((await findActiveByIdemKey("k1"))?.id).toBe(first?.id);
    expect(await findActiveByIdemKey("missing")).toBeNull();
    expect((await pool.query("SELECT 1 FROM app.relay_requests")).rowCount).toBe(1);
  });

  it("a FAILED row is renamed on retry so the key is reusable and the old row still counts for quotas", async () => {
    const user = await createUser(1);
    const first = await insertRelayRequest(request(user, "k1"));
    if (!first) throw new Error("insert failed");
    await pool.query("UPDATE app.relay_requests SET status = 'FAILED' WHERE id = $1", [first.id]);
    expect(await findActiveByIdemKey("k1")).toBeNull();

    const retry = await insertRelayRequest(request(user, "k1"));
    expect(retry?.id).not.toBe(first.id);
    const old = await pool.query<{ idem_key: string }>("SELECT idem_key FROM app.relay_requests WHERE id = $1", [first.id]);
    expect(old.rows[0]?.idem_key).toBe(`k1:${first.id}`);
    expect(await countUserSince24h(user.id)).toBe(2);
    expect(await countChainSince24h(CHAIN)).toBe(2);
    expect(await countChainSince24h(97)).toBe(0);
  });

  it("quota counting ignores rows older than 24 hours", async () => {
    const user = await createUser(1);
    const old = await insertRelayRequest(request(user, "old"));
    await insertRelayRequest(request(user, "new"));
    if (old) await setCreatedAt(old.id, 25 * 3600);
    expect(await countUserSince24h(user.id)).toBe(1);
    expect(await countChainSince24h(CHAIN)).toBe(1);
  });

  it("owner-filtered reads; system execute rows (user_id NULL) are accepted but invisible to users", async () => {
    const user = await createUser(1);
    const other = await createUser(2);
    const mine = await insertRelayRequest(request(user, "k1"));
    const system = await insertRelayRequest(request(null, executeKey(1, 0), { kind: "execute" }));
    expect(system).toMatchObject({ kind: "execute", status: "QUEUED" });
    if (!mine || !system) throw new Error("insert failed");

    expect((await listOwnRequests(user.id, 10)).map((r) => r.id)).toEqual([mine.id]);
    expect(await listOwnRequests(other.id, 10)).toEqual([]);
    expect(await findOwnRequest(mine.id, user.id)).toMatchObject({ id: mine.id });
    expect(await findOwnRequest(mine.id, other.id)).toBeNull();
    expect(await findOwnRequest(system.id, user.id)).toBeNull();
  });

  it("user_id may be NULL only for kind execute (CHECK relay_requests_user_required)", async () => {
    const err = await pgErrorOf(insertRelayRequest(request(null, "k1", { kind: "vote" })));
    expect(err).toMatchObject({ code: "23514", constraint: "relay_requests_user_required" });
    const bad = await pgErrorOf(insertRelayRequest(request(await createUser(1), "k2", { chainId: 1 })));
    expect(bad.code).toBe("23514");
  });

  it("findRelayProject reads the indexer table and lowercases addresses", async () => {
    await insertPonderProject({ chainId: CHAIN, escrow: escrow(1) });
    await pool.query("UPDATE ponder.project SET escrow_address = upper(escrow_address), distributor_address = upper(distributor_address)");
    const project = await findRelayProject(`${CHAIN}:${escrow(1)}`);
    expect(project).toMatchObject({ chainId: CHAIN, escrowAddress: escrow(1), distributorAddress: addr(902), tokenAddress: addr(901) });
    expect(await findRelayProject("nope")).toBeNull();
  });
});

describe("relay worker statements", () => {
  it("claimNextQueued picks the oldest queued row of the chain and marks it SENDING", async () => {
    const user = await createUser(1);
    const a = await insertRelayRequest(request(user, "a"));
    const b = await insertRelayRequest(request(user, "b"));
    const c = await insertRelayRequest(request(user, "c", { chainId: 97 }));
    const expired = await insertRelayRequest(request(user, "x", { expiresAt: new Date(Date.now() - 1000) }));
    if (!a || !b || !c || !expired) throw new Error("insert failed");
    await setCreatedAt(a.id, 10);
    await setCreatedAt(b.id, 20);
    await setCreatedAt(c.id, 40);
    await setCreatedAt(expired.id, 60);

    const claimed = await claimNextQueued(CHAIN);
    expect(claimed).toEqual({ id: b.id, kind: "claim", to: escrow(1), data: "0xdeadbeef" });
    expect(await statusOf(b.id)).toBe("SENDING");
    expect((await claimNextQueued(CHAIN))?.id).toBe(a.id);
    expect(await claimNextQueued(CHAIN)).toBeNull();
    expect((await claimNextQueued(97))?.id).toBe(c.id);
    expect(await statusOf(expired.id)).toBe("QUEUED");
  });

  it("concurrent claims get different rows; a row locked elsewhere is skipped", async () => {
    const user = await createUser(1);
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const row = await insertRelayRequest(request(user, `k${i}`));
      if (!row) throw new Error("insert failed");
      await setCreatedAt(row.id, 100 - i);
      ids.push(row.id);
    }
    const claims = await Promise.all([claimNextQueued(CHAIN), claimNextQueued(CHAIN), claimNextQueued(CHAIN)]);
    const claimedIds = claims.map((c) => c?.id);
    expect(claimedIds.every((id) => id !== undefined)).toBe(true);
    expect(new Set(claimedIds).size).toBe(3);

    // the fourth is the oldest remaining; lock it in another transaction and claim again
    const [remaining] = ids.filter((id) => !claimedIds.includes(id));
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM app.relay_requests WHERE id = $1 FOR UPDATE", [remaining]);
      expect(await claimNextQueued(CHAIN)).toBeNull();
      await holder.query("ROLLBACK");
    } finally {
      holder.release();
    }
    expect((await claimNextQueued(CHAIN))?.id).toBe(remaining);
  });

  it("send, confirm and fail transitions only apply from the right state", async () => {
    const user = await createUser(1);
    const row = await insertRelayRequest(request(user, "k1"));
    if (!row) throw new Error("insert failed");
    await markSent(row.id, "0xabc");
    expect(await statusOf(row.id)).toBe("QUEUED");
    await claimNextQueued(CHAIN);
    await markSent(row.id, "0xabc");
    expect(await statusOf(row.id)).toBe("SENT");
    expect(await listSent(CHAIN, 10)).toEqual([{ id: row.id, txHash: "0xabc" }]);
    await markConfirmed(row.id, 21000n, 1_000_000_007n);
    const done = await findOwnRequest(row.id, user.id);
    expect(done).toMatchObject({ status: "CONFIRMED", gasUsed: "21000", effectiveGasPrice: "1000000007", txHash: "0xabc" });
    expect(done?.confirmedAt).toBeInstanceOf(Date);
    await markFailed(row.id, "X", "ignored: already confirmed");
    expect(await statusOf(row.id)).toBe("CONFIRMED");

    const second = await insertRelayRequest(request(user, "k2"));
    if (!second) throw new Error("insert failed");
    await claimNextQueued(CHAIN);
    await markFailed(second.id, "REVERTED", "reverted", { gasUsed: 5n, effectiveGasPrice: 7n });
    expect(await findOwnRequest(second.id, user.id)).toMatchObject({ status: "FAILED", errorCode: "REVERTED", gasUsed: "5" });
  });

  it("expireStale expires unsent rows past their deadline; failInterrupted / recoverRelayState fail SENDING rows without a hash", async () => {
    const user = await createUser(1);
    const stale = await insertRelayRequest(request(user, "stale", { expiresAt: new Date(Date.now() - 1000) }));
    const live = await insertRelayRequest(request(user, "live"));
    const interrupted = await insertRelayRequest(request(user, "interrupted"));
    const sent = await insertRelayRequest(request(user, "sent"));
    if (!stale || !live || !interrupted || !sent) throw new Error("insert failed");
    await pool.query("UPDATE app.relay_requests SET status = 'SENDING' WHERE id = $1", [interrupted.id]);
    await pool.query("UPDATE app.relay_requests SET status = 'SENDING', tx_hash = '0x1' WHERE id = $1", [sent.id]);

    expect(await expireStale()).toBe(1);
    expect(await statusOf(stale.id)).toBe("EXPIRED");
    expect(await statusOf(sent.id)).toBe("SENDING");

    await recoverRelayState();
    expect(await statusOf(interrupted.id)).toBe("FAILED");
    expect(await statusOf(sent.id)).toBe("SENDING");
    expect(await statusOf(live.id)).toBe("QUEUED");
    expect(await failInterrupted()).toBe(0);
    const failed = await findOwnRequest(interrupted.id, user.id);
    expect(failed).toMatchObject({ errorCode: "INTERRUPTED" });
  });
});

describe("automatic milestone execution queries", () => {
  async function candidate(n: number, opts: Partial<Parameters<typeof insertPonderProject>[0]> = {}, milestone: Partial<Parameters<typeof insertPonderMilestone>[0]> = {}): Promise<string> {
    const id = await insertPonderProject({ chainId: CHAIN, escrow: escrow(n), ...opts });
    await insertPonderMilestone({ projectId: id, chainId: CHAIN, index: 0, votingEndTime: 1000, ...milestone });
    return id;
  }

  it("returns only open, unexecuted, past-due milestones of active projects on the chain", async () => {
    await candidate(1); // due
    await candidate(2, {}, { votingEndTime: 5000 }); // not yet due
    await candidate(3, {}, { isVotingOpen: false });
    await candidate(4, {}, { isExecuted: true });
    await candidate(5, {}, { isFailed: true });
    await candidate(6, { state: "FUNDING" });
    await candidate(7, { isInvalidated: true });
    await candidate(8, { cancelledAt: "1500" });
    await insertPonderProject({ chainId: 97, escrow: escrow(9) });
    await insertPonderMilestone({ projectId: `97:${escrow(9)}`, chainId: 97, index: 0, votingEndTime: 1000 });
    // a milestone that is not the project's current one
    const other = await insertPonderProject({ chainId: CHAIN, escrow: escrow(10), currentMilestoneIndex: 1 });
    await insertPonderMilestone({ projectId: other, chainId: CHAIN, index: 0, votingEndTime: 1000 });

    const found = await listExecuteCandidates(CHAIN, 2000n, 10);
    expect(found).toEqual([{ projectId: `${CHAIN}:${escrow(1)}`, chainId: CHAIN, escrowAddress: escrow(1), milestoneIndex: 0 }]);
    expect((await listExecuteCandidates(97, 2000n, 10)).map((c) => c.projectId)).toEqual([`97:${escrow(9)}`]);
    expect(await listExecuteCandidates(CHAIN, 500n, 10)).toEqual([]);
  });

  it("orders by voting end and honours the limit", async () => {
    await candidate(1, {}, { votingEndTime: 300 });
    await candidate(2, {}, { votingEndTime: 100 });
    await candidate(3, {}, { votingEndTime: 200 });
    const found = await listExecuteCandidates(CHAIN, 1000n, 2);
    expect(found.map((c) => c.escrowAddress)).toEqual([escrow(2), escrow(3)]);
  });

  it("leaves out milestones with a live execute row or a SELF_PAY failure, but retries other failures", async () => {
    await candidate(1); // live row
    await candidate(2); // plain failure -> still a candidate
    await candidate(3); // SELF_PAY failure -> excluded
    await candidate(4); // no row
    await insertRelayRequest(request(null, executeKey(1, 0), { kind: "execute", projectId: `${CHAIN}:${escrow(1)}` }));
    await recordExecuteFailure(
      { chainId: CHAIN, projectId: `${CHAIN}:${escrow(2)}`, account: addr(0xfee), payload: {}, args: { to: escrow(2), data: "0x" }, idemKey: executeKey(2, 0) },
      "SIMULATION_FAILED",
      "simulation failed"
    );
    await recordExecuteFailure(
      { chainId: CHAIN, projectId: `${CHAIN}:${escrow(3)}`, account: addr(0xfee), payload: {}, args: { to: escrow(3), data: "0x" }, idemKey: executeKey(3, 0) },
      "SELF_PAY",
      "needs self pay"
    );
    const found = await listExecuteCandidates(CHAIN, 2000n, 10);
    expect(found.map((c) => c.escrowAddress).sort()).toEqual([escrow(2), escrow(4)]);
  });

  it("recordExecuteFailure stores a visible FAILED user-less row and renames an earlier one on retry", async () => {
    const key = executeKey(1, 0);
    const base = { chainId: CHAIN, projectId: `${CHAIN}:${escrow(1)}`, account: addr(0xfee), payload: {}, args: { to: escrow(1), data: "0x" }, idemKey: key };
    await recordExecuteFailure(base, "E1", "first");
    await recordExecuteFailure(base, "E2", "second");
    const rows = await pool.query<{ idem_key: string; error_code: string; user_id: string | null; kind: string; status: string }>(
      "SELECT idem_key, error_code, user_id, kind, status FROM app.relay_requests ORDER BY error_code"
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({ error_code: "E1", user_id: null, kind: "execute", status: "FAILED" });
    expect(rows.rows[0]?.idem_key.startsWith(`${key}:`)).toBe(true);
    expect(rows.rows[1]).toMatchObject({ error_code: "E2", idem_key: key });
  });

  it("executeHistory counts renamed attempts and does not mix up milestone 1 and 10", async () => {
    const key = executeKey(1, 1);
    const base = { chainId: CHAIN, projectId: `${CHAIN}:${escrow(1)}`, account: addr(0xfee), payload: {}, args: { to: escrow(1), data: "0x" } };
    await recordExecuteFailure({ ...base, idemKey: key }, "E1", "first");
    await recordExecuteFailure({ ...base, idemKey: key }, "SELF_PAY", "second");
    await recordExecuteFailure({ ...base, idemKey: executeKey(1, 10) }, "E3", "other milestone");

    const history = await executeHistory(key);
    expect(history).toMatchObject({ live: false, selfPay: true, failures: 2 });
    expect(history.lastAttemptAt).toBeInstanceOf(Date);

    await insertRelayRequest(request(null, key, { kind: "execute" }));
    expect(await executeHistory(key)).toMatchObject({ live: true, failures: 2 });
    expect(await executeHistory(executeKey(1, 10))).toMatchObject({ live: false, failures: 1, selfPay: false });
    expect(await executeHistory(executeKey(2, 0))).toEqual({ live: false, selfPay: false, failures: 0, lastAttemptAt: null });
  });
});
