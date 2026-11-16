import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { Wallet } from "ethers";
import { findCase, findLastFailedCloseAt } from "../../src/takeover/takeoverRepository.js";
import { buildAcceptanceMessage, buildVoteMessage, type VoteChoice } from "../../src/takeover/takeoverMessages.js";
import { acceptCandidate, castVote, closeCase, closeIfDue, loadTally } from "../../src/takeover/takeoverService.js";
import type { AuthUser } from "../../src/types/index.js";
import { addr, auditRows, bootstrapDatabase, closePool, createUser, pgErrorOf, pool, resetData } from "./db.js";

beforeAll(bootstrapDatabase);
beforeEach(resetData);
afterAll(closePool);

const CHAIN = 421614;

interface Actor {
  wallet: Wallet;
  user: AuthUser;
}

async function actor(role: AuthUser["role"] = "investor"): Promise<Actor> {
  const wallet = Wallet.createRandom();
  const address = wallet.address.toLowerCase();
  const inserted = await pool.query<{ id: string }>("INSERT INTO app.users (wallet_address, role) VALUES ($1, $2) RETURNING id", [address, role]);
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error("user insert returned no row");
  return { wallet, user: { id, address, role, profileComplete: false } };
}

interface Fixture {
  caseId: string;
  projectId: string;
  candidate: Actor;
  developer: Actor;
  voters: Actor[];
  outsider: Actor;
}

/** Inserts a case directly; a vote_open case carries a frozen snapshot of the given holders (developer and candidate included). */
async function makeCase(options: { open: boolean; escrow?: string; stakes?: bigint[] }): Promise<Fixture> {
  const staff = await createUser(Math.floor(Math.random() * 1e9) + 1000, "staff");
  const candidate = await actor("founder");
  const developer = await actor("founder");
  const outsider = await actor();
  const stakes = options.stakes ?? [100n, 50n];
  const voters = await Promise.all(stakes.map(() => actor()));
  const escrow = options.escrow ?? addr(0xe01);
  const projectId = `${CHAIN}:${escrow}`;
  const holders: [string, bigint][] = [
    ...voters.map((v, i): [string, bigint] => [v.user.address, stakes[i] ?? 1n]),
    [developer.user.address, 300n],
    [candidate.user.address, 40n],
  ];
  const total = holders.reduce((sum, [, stake]) => sum + stake, 0n);
  const created = await pool.query<{ id: string }>(
    options.open
      ? `INSERT INTO app.takeover_cases (chain_id, project_id, candidate_wallet, candidate_user_id, reason, created_by, status, opened_by,
           opened_at, snapshot_block, snapshot_block_timestamp, snapshot_taken_at, snapshot_lag_seconds, snapshot_total_staked,
           snapshot_holder_count, candidate_accepted_at, developer_at_open, ends_at, quorum_percent)
         VALUES ($1, $2, $3, $4, 'r', $5, 'vote_open', $5, now(), 1, now(), now(), 0, $6, $7, now(), $8, now() + interval '7 days', 20)
         RETURNING id`
      : `INSERT INTO app.takeover_cases (chain_id, project_id, candidate_wallet, candidate_user_id, reason, created_by, status)
         VALUES ($1, $2, $3, $4, 'r', $5, 'prepared') RETURNING id`,
    options.open
      ? [CHAIN, projectId, candidate.user.address, candidate.user.id, staff.id, total.toString(), holders.length, developer.user.address]
      : [CHAIN, projectId, candidate.user.address, candidate.user.id, staff.id]
  );
  const caseId = created.rows[0]?.id;
  if (!caseId) throw new Error("case insert returned no row");
  if (options.open) {
    for (const [holder, stake] of holders) {
      await pool.query("INSERT INTO app.takeover_snapshot_holders (case_id, investor_address, staked_balance) VALUES ($1, $2, $3)", [caseId, holder, stake.toString()]);
    }
  }
  return { caseId, projectId, candidate, developer, voters, outsider };
}

/** The freeze trigger forbids editing ends_at; tests lift it inside one transaction to simulate the window elapsing. */
async function expire(caseId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE app.takeover_cases DISABLE TRIGGER takeover_cases_freeze_vote");
    await client.query("UPDATE app.takeover_cases SET ends_at = now() - interval '1 second' WHERE id = $1", [caseId]);
    await client.query("ALTER TABLE app.takeover_cases ENABLE TRIGGER takeover_cases_freeze_vote");
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function signedVote(who: Actor, fx: Fixture, choice: VoteChoice, issuedAt = new Date()): Promise<{ choice: VoteChoice; issuedAt: string; signature: string }> {
  const iso = issuedAt.toISOString();
  const message = buildVoteMessage({ caseId: fx.caseId, projectId: fx.projectId, choice, wallet: who.user.address, issuedAt: iso });
  return { choice, issuedAt: iso, signature: await who.wallet.signMessage(message) };
}

async function signedAcceptance(who: Actor, fx: Fixture, issuedAt = new Date()): Promise<{ issuedAt: string; signature: string }> {
  const iso = issuedAt.toISOString();
  const message = buildAcceptanceMessage({ caseId: fx.caseId, projectId: fx.projectId, wallet: who.user.address, issuedAt: iso });
  return { issuedAt: iso, signature: await who.wallet.signMessage(message) };
}

async function vote(who: Actor, fx: Fixture, choice: VoteChoice, issuedAt?: Date): ReturnType<typeof castVote> {
  return castVote(who.user, fx.caseId, await signedVote(who, fx, choice, issuedAt), null);
}

describe("candidate acceptance", () => {
  it("stores a valid signed acceptance once, audits a short token and keeps the signature out of the audit", async () => {
    const fx = await makeCase({ open: false });
    const fields = await signedAcceptance(fx.candidate, fx);
    expect(await acceptCandidate(fx.candidate.user, fx.caseId, fields, null)).toEqual({ alreadyAccepted: false });
    expect(await acceptCandidate(fx.candidate.user, fx.caseId, fields, null)).toEqual({ alreadyAccepted: true });
    const found = await findCase(fx.caseId);
    expect(found?.candidateAcceptedAt).not.toBeNull();
    const audit = await auditRows();
    expect(audit).toEqual([{ action: "takeover.accept", target: addr(0xe01), before_value: "prepared", after_value: "accepted", actor_user_id: fx.candidate.user.id }]);
    expect(JSON.stringify(audit)).not.toContain(fields.signature);
  });

  it("rejects another user (404), a wrong signature and a stale issuedAt (400) and a non-prepared case (409)", async () => {
    const fx = await makeCase({ open: false });
    const fields = await signedAcceptance(fx.candidate, fx);
    await expect(acceptCandidate(fx.outsider.user, fx.caseId, fields, null)).rejects.toMatchObject({ status: 404 });
    const forged = await signedAcceptance(fx.outsider, fx);
    await expect(acceptCandidate(fx.candidate.user, fx.caseId, forged, null)).rejects.toMatchObject({ status: 400, message: "Invalid signature" });
    const old = await signedAcceptance(fx.candidate, fx, new Date(Date.now() - 11 * 60_000));
    await expect(acceptCandidate(fx.candidate.user, fx.caseId, old, null)).rejects.toMatchObject({ status: 400 });
    const open = await makeCase({ open: true, escrow: addr(0xe02) });
    await expect(acceptCandidate(open.candidate.user, open.caseId, await signedAcceptance(open.candidate, open), null)).rejects.toMatchObject({ status: 409 });
  });

  it("freezes the stored acceptance and refuses to set it on a non-prepared case", async () => {
    const fx = await makeCase({ open: false });
    await acceptCandidate(fx.candidate.user, fx.caseId, await signedAcceptance(fx.candidate, fx), null);
    const edit = await pgErrorOf(pool.query("UPDATE app.takeover_cases SET candidate_acceptance_signature = 'x' WHERE id = $1", [fx.caseId]));
    expect(edit.message).toMatch(/immutable/);
    const cancelled = await makeCase({ open: false, escrow: addr(0xe02) });
    await pool.query("UPDATE app.takeover_cases SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [cancelled.caseId]);
    const late = await pgErrorOf(pool.query("UPDATE app.takeover_cases SET candidate_accepted_at = now() WHERE id = $1", [cancelled.caseId]));
    expect(late.message).toMatch(/only allowed while the case is prepared/);
  });
});

describe("casting votes", () => {
  it("copies the snapshot weight, keeps one row per voter and only accepts a strictly newer change", async () => {
    const fx = await makeCase({ open: true });
    const [alice] = fx.voters;
    if (!alice) throw new Error("fixture");
    const t0 = new Date();
    const first = await vote(alice, fx, "YES", t0);
    expect(first.vote).toMatchObject({ choice: "YES", weight: "100" });
    expect(first.tally).toMatchObject({ yesWeight: "100", noWeight: "0", voterCount: 1, snapshotTotalStaked: "490", quorumWeightRequired: "98", quorumReached: true });

    await expect(vote(alice, fx, "NO", t0)).rejects.toMatchObject({ status: 409, message: "Stale vote" });
    await expect(vote(alice, fx, "NO", new Date(t0.getTime() - 1000))).rejects.toMatchObject({ status: 409 });
    const changed = await vote(alice, fx, "NO", new Date(t0.getTime() + 1000));
    expect(changed.tally).toMatchObject({ yesWeight: "0", noWeight: "100", voterCount: 1 });
    const rows = await pool.query("SELECT 1 FROM app.takeover_votes WHERE case_id = $1", [fx.caseId]);
    expect(rows.rowCount).toBe(1);
    const audit = (await auditRows()).filter((a) => a.action === "takeover.vote");
    expect(audit.map((a) => a.after_value)).toEqual(["YES", "NO"]);
    expect(JSON.stringify(audit)).not.toMatch(/0x[0-9a-f]{130}/);
  });

  it("refuses the developer under takeover, the candidate and non-holders (403), and bad signatures (400)", async () => {
    const fx = await makeCase({ open: true });
    for (const excluded of [fx.developer, fx.candidate, fx.outsider]) {
      await expect(vote(excluded, fx, "YES")).rejects.toMatchObject({ status: 403 });
    }
    const [alice] = fx.voters;
    if (!alice) throw new Error("fixture");
    const signedYes = await signedVote(alice, fx, "YES");
    await expect(castVote(alice.user, fx.caseId, { ...signedYes, choice: "NO" }, null)).rejects.toMatchObject({ status: 400 });
    const prepared = await makeCase({ open: false, escrow: addr(0xe02) });
    await expect(vote(alice, prepared, "YES")).rejects.toMatchObject({ status: 404 });
  });
});

describe("vote triggers", () => {
  it("rejects inserts after the window and after close, never deletes, and keeps weight immutable", async () => {
    const fx = await makeCase({ open: true });
    const [alice, bob] = fx.voters;
    if (!alice || !bob) throw new Error("fixture");
    await vote(alice, fx, "YES");
    const insert = (voter: string): Promise<unknown> =>
      pool.query("INSERT INTO app.takeover_votes (case_id, voter_address, choice, weight, message, signature, issued_at) VALUES ($1, $2, 'YES', 5, 'm', 's', now())", [fx.caseId, voter]);

    expect((await pgErrorOf(pool.query("DELETE FROM app.takeover_votes WHERE case_id = $1", [fx.caseId]))).message).toMatch(/cannot be deleted/);
    expect((await pgErrorOf(pool.query("UPDATE app.takeover_votes SET weight = 1 WHERE case_id = $1", [fx.caseId]))).message).toMatch(/immutable/);

    await expire(fx.caseId);
    expect((await pgErrorOf(insert(bob.user.address))).message).toMatch(/not open/);
    expect((await pgErrorOf(pool.query("UPDATE app.takeover_votes SET choice = 'NO' WHERE case_id = $1", [fx.caseId]))).message).toMatch(/not open/);
    await expect(vote(bob, fx, "YES")).rejects.toMatchObject({ status: 409 });

    await closeIfDue(fx.caseId);
    expect((await pgErrorOf(insert(bob.user.address))).message).toMatch(/not open/);
  });

  it("requires the window and quorum on every new vote_open case (legacy rows tolerated)", async () => {
    const fx = await makeCase({ open: true });
    const legacy = await pgErrorOf(
      pool.query(
        `INSERT INTO app.takeover_cases (chain_id, project_id, candidate_wallet, candidate_user_id, reason, created_by, status, snapshot_block,
           snapshot_block_timestamp, snapshot_taken_at, snapshot_lag_seconds, snapshot_total_staked, snapshot_holder_count)
         SELECT chain_id, $2, candidate_wallet, candidate_user_id, 'r', created_by, 'vote_open', 1, now(), now(), 0, 1, 1
         FROM app.takeover_cases WHERE id = $1`,
        [fx.caseId, `${CHAIN}:${addr(0xe03)}`]
      )
    );
    expect(legacy.constraint).toBe("takeover_cases_vote_open_check");
  });
});

describe("closing", () => {
  it("lazily closes once with the tallies persisted, then keeps the result immutable", async () => {
    const fx = await makeCase({ open: true });
    const [alice, bob] = fx.voters;
    if (!alice || !bob) throw new Error("fixture");
    await vote(alice, fx, "YES");
    await vote(bob, fx, "NO");
    expect((await closeIfDue(fx.caseId))?.status).toBe("vote_open");

    await expire(fx.caseId);
    const closed = await closeIfDue(fx.caseId);
    expect(closed).toMatchObject({ status: "closed", result: "passed", yesWeight: "100", noWeight: "50", votedWeight: "150", voterCount: 2 });
    const again = await closeIfDue(fx.caseId);
    if (!closed || !again) throw new Error("case missing");
    expect(again.closedAt?.getTime()).toBe(closed.closedAt?.getTime());
    expect((await auditRows()).filter((a) => a.action === "takeover.close")).toEqual([
      { action: "takeover.close", target: addr(0xe01), before_value: "vote_open", after_value: "passed", actor_user_id: null },
    ]);
    expect(await loadTally(again)).toMatchObject({ status: "closed", result: "passed", yesWeight: "100", quorumReached: true });
    expect((await pgErrorOf(pool.query("UPDATE app.takeover_cases SET result = 'failed' WHERE id = $1", [fx.caseId]))).message).toMatch(/immutable/);
  });

  it("no_quorum and failed results start the cooldown query, passed does not", async () => {
    const small = await makeCase({ open: true, escrow: addr(0xe05), stakes: [50n, 10n] });
    const big = await makeCase({ open: true, escrow: addr(0xe06), stakes: [100n, 50n] });
    const [smallVoter] = small.voters;
    const [bigVoter] = big.voters;
    if (!smallVoter || !bigVoter) throw new Error("fixture");
    await vote(smallVoter, small, "YES");
    await vote(bigVoter, big, "YES");
    await expire(small.caseId);
    await expire(big.caseId);
    expect((await closeIfDue(small.caseId))?.result).toBe("no_quorum");
    expect((await closeIfDue(big.caseId))?.result).toBe("passed");
    expect(await findLastFailedCloseAt(pool, small.projectId)).toBeInstanceOf(Date);
    expect(await findLastFailedCloseAt(pool, big.projectId)).toBeNull();
  });

  it("admin close refuses before the window ends, is idempotent after and audits the admin", async () => {
    const admin = await createUser(2, "admin");
    const fx = await makeCase({ open: true });
    await expect(closeCase(fx.caseId, admin.id, null)).rejects.toMatchObject({ status: 409 });
    await expire(fx.caseId);
    const closed = await closeCase(fx.caseId, admin.id, null);
    expect(closed).toMatchObject({ status: "closed", result: "no_quorum", voterCount: 0 });
    await closeCase(fx.caseId, admin.id, null);
    const audit = (await auditRows()).filter((a) => a.action === "takeover.close");
    expect(audit).toEqual([{ action: "takeover.close", target: addr(0xe01), before_value: "vote_open", after_value: "no_quorum", actor_user_id: admin.id }]);
  });
});
