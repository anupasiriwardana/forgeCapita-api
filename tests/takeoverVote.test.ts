/**
 * Takeover voting (WS-11.4b): pure tally rules, signed message texts, issuedAt window, stale handling,
 * eligibility, cooldown predicate and the route guard matrix with a mocked pg and mocked session.
 * Real ethers wallets sign the texts; no network.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { Wallet } from "ethers";
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
const { envSchema } = await import("../src/config/env.js");
const { signatureMatches } = await import("../src/auth/siwe.js");
const { decideResult, isInCooldown, isQuorumReached, quorumWeightRequired } = await import("../src/takeover/takeoverTally.js");
const { buildAcceptanceMessage, buildVoteMessage, isNewerVote, parseIssuedAt } = await import("../src/takeover/takeoverMessages.js");
const { assertVoterEligible } =await import("../src/takeover/takeoverService.js");
const { voteBodySchema } = await import("../src/takeover/takeoverSchemas.js");

const app = createApp();
const SESSION_USER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_USER_ID = "33333333-3333-3333-3333-333333333333";
const WALLET = "0x" + "11".repeat(20);
const CASE_ID = "22222222-2222-2222-2222-222222222222";
const SIG = "0x" + "ab".repeat(65);
const BASE = "/api/v1/takeover-cases";

beforeEach(() => {
  mockQuery.mockReset();
});

describe("tally rules", () => {
  const input = (yes: bigint, no: bigint, total = 1000n) => ({ yes, no, total, quorumPercent: 20 });

  it("quorum is exactly the percent boundary of the snapshot total", () => {
    expect(quorumWeightRequired(1000n, 20)).toBe(200n);
    expect(quorumWeightRequired(1001n, 20)).toBe(201n);
    expect(isQuorumReached(199n, 1000n, 20)).toBe(false);
    expect(isQuorumReached(200n, 1000n, 20)).toBe(true);
    expect(decideResult(input(199n, 0n))).toBe("no_quorum");
    expect(decideResult(input(200n, 0n))).toBe("passed");
  });

  it("a tie fails, no_quorum overrides a yes majority and zero votes never reach quorum", () => {
    expect(decideResult(input(150n, 150n))).toBe("failed");
    expect(decideResult(input(100n, 101n))).toBe("failed");
    expect(decideResult(input(150n, 49n))).toBe("no_quorum");
    expect(decideResult(input(0n, 0n))).toBe("no_quorum");
    expect(decideResult(input(0n, 0n, 0n))).toBe("no_quorum");
  });

  it("stays exact for amounts far beyond Number precision", () => {
    const total = 10n ** 30n + 7n;
    const quorum = quorumWeightRequired(total, 20);
    expect(isQuorumReached(quorum, total, 20)).toBe(true);
    expect(isQuorumReached(quorum - 1n, total, 20)).toBe(false);
    expect(decideResult({ yes: quorum, no: quorum - 1n, total, quorumPercent: 20 })).toBe("passed");
  });

  it("cooldown applies only after a recent failed close", () => {
    const now = Date.UTC(2026, 0, 31);
    const day = 86_400_000;
    expect(isInCooldown(null, now, 30)).toBe(false);
    expect(isInCooldown(new Date(now - 29 * day), now, 30)).toBe(true);
    expect(isInCooldown(new Date(now - 30 * day), now, 30)).toBe(false);
    expect(isInCooldown(new Date(now - day), now, 0)).toBe(false);
  });
});

describe("signed messages", () => {
  const issuedAt = "2026-01-01T00:00:00.000Z";

  it("builds fixed texts with the EIP-55 wallet and verifies real signatures against the session wallet", async () => {
    const wallet = Wallet.createRandom();
    const base = { caseId: CASE_ID, projectId: `421614:${WALLET}`, wallet: wallet.address.toLowerCase(), issuedAt };
    const vote = buildVoteMessage({ ...base, choice: "YES" });
    expect(vote.split("\n")).toEqual([
      "ForgeCapita Takeover Vote",
      "Domain: localhost:3000",
      `Case: ${CASE_ID}`,
      `Project: 421614:${WALLET}`,
      "Choice: YES",
      `Wallet: ${wallet.address}`,
      `Issued At: ${issuedAt}`,
    ]);
    const accept = buildAcceptanceMessage(base);
    expect(accept).toContain("ForgeCapita Takeover Candidate Acceptance");
    expect(accept).not.toContain("Choice:");

    const signature = await wallet.signMessage(vote);
    expect(signatureMatches(vote, signature, wallet.address)).toBe(true);
    expect(signatureMatches(buildVoteMessage({ ...base, choice: "NO" }), signature, wallet.address)).toBe(false);
    expect(signatureMatches(vote, signature, Wallet.createRandom().address)).toBe(false);
  });

  it("accepts issuedAt only within ten minutes of now", () => {
    const now = new Date("2026-01-01T00:10:00.000Z");
    expect(parseIssuedAt(issuedAt, now).toISOString()).toBe(issuedAt);
    expect(() => parseIssuedAt("2026-01-01T00:20:00.001Z", now)).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => parseIssuedAt("2025-12-31T23:59:59.000Z", now)).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => parseIssuedAt("not a date", now)).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("replaces a stored vote only with a strictly newer issuedAt", () => {
    const stored = new Date("2026-01-01T00:00:00.000Z");
    expect(isNewerVote(null, stored)).toBe(true);
    expect(isNewerVote(stored, new Date("2026-01-01T00:00:00.001Z"))).toBe(true);
    expect(isNewerVote(stored, stored)).toBe(false);
    expect(isNewerVote(stored, new Date("2025-12-31T23:59:59.999Z"))).toBe(false);
  });
});

describe("eligibility and schemas", () => {
  const dev = "0x" + "d1".repeat(20);
  const cand = "0x" + "c4".repeat(20);
  const holder = "0x" + "a1".repeat(20);

  it("excludes the developer, the candidate and non-holders; returns the snapshot weight otherwise", () => {
    const base = { developerAtOpen: dev, candidateWallet: cand };
    expect(assertVoterEligible({ ...base, voter: holder, weight: 5n })).toBe(5n);
    for (const voter of [dev, cand]) {
      expect(() => assertVoterEligible({ ...base, voter, weight: 5n })).toThrow(expect.objectContaining({ status: 403 }));
    }
    expect(() => assertVoterEligible({ ...base, voter: holder, weight: null })).toThrow(expect.objectContaining({ status: 403 }));
  });

  it("validates the vote body strictly and bounds the env values", () => {
    const ok = { choice: "YES", issuedAt: "2026-01-01T00:00:00.000Z", signature: SIG };
    expect(voteBodySchema.safeParse(ok).success).toBe(true);
    expect(voteBodySchema.safeParse({ ...ok, choice: "yes" }).success).toBe(false);
    expect(voteBodySchema.safeParse({ ...ok, weight: 1 }).success).toBe(false);
    expect(voteBodySchema.safeParse({ ...ok, signature: "0x12" }).success).toBe(false);
    const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };
    expect(envSchema.parse({ ...base, TAKEOVER_QUORUM_PERCENT: "", TAKEOVER_VOTE_DAYS: "", TAKEOVER_COOLDOWN_DAYS: "" })).toMatchObject({
      TAKEOVER_QUORUM_PERCENT: 20,
      TAKEOVER_VOTE_DAYS: 7,
      TAKEOVER_COOLDOWN_DAYS: 30,
    });
    expect(envSchema.safeParse({ ...base, TAKEOVER_QUORUM_PERCENT: "0" }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, TAKEOVER_VOTE_DAYS: "91" }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, TAKEOVER_COOLDOWN_DAYS: "-1" }).success).toBe(false);
  });
});

function caseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CASE_ID,
    chain_id: 421614,
    project_id: `421614:${WALLET}`,
    candidate_wallet: "0x" + "c4".repeat(20),
    candidate_user_id: SESSION_USER_ID,
    reason: "r",
    evidence_links: [],
    status: "vote_open",
    created_by: OTHER_USER_ID,
    opened_by: OTHER_USER_ID,
    created_at: new Date(),
    opened_at: new Date(),
    cancelled_at: null,
    snapshot_block: "1",
    snapshot_block_timestamp: new Date(),
    snapshot_taken_at: new Date(),
    snapshot_lag_seconds: 1,
    snapshot_total_staked: "1000",
    snapshot_holder_count: 3,
    candidate_accepted_at: new Date(),
    developer_at_open: "0x" + "d1".repeat(20),
    ends_at: new Date(Date.now() + 86_400_000),
    closed_at: null,
    result: null,
    yes_weight: null,
    no_weight: null,
    voted_weight: null,
    voter_count: null,
    quorum_percent: 20,
    voting_ended: false,
    ...overrides,
  };
}

const OK = { rows: [], rowCount: 0 };
const found = (row: Record<string, unknown>): { rows: unknown[]; rowCount: number } => ({ rows: [row], rowCount: 1 });

describe("route guards and status matrix", () => {
  const body = { choice: "YES", issuedAt: new Date().toISOString(), signature: SIG };
  const accept = { issuedAt: new Date().toISOString(), signature: SIG };
  const post = (url: string, role: string, payload: object, responses: unknown[], origin = ALLOWED_ORIGIN) => {
    mockSession(mockQuery, role, WALLET, ...responses);
    return request(app).post(url).set("Origin", origin).set("Cookie", SESSION_COOKIE_HEADER).send(payload);
  };

  it("requires a session, a same origin and a strict body on both signed writes", async () => {
    for (const [path, payload] of [["accept", accept], ["vote", body]] as const) {
      const url = `${BASE}/${CASE_ID}/${path}`;
      expect((await request(app).post(url).set("Origin", ALLOWED_ORIGIN).send(payload)).status).toBe(401);
      expect((await post(url, "investor", payload, [], "https://evil.example")).status).toBe(403);
      expect((await post(url, "investor", { ...payload, extra: 1 }, [])).status).toBe(400);
      expect((await post(`${BASE}/not-a-uuid/${path}`, "investor", payload, [])).status).toBe(400);
    }
  });

  it("/mine is registered before /:id routes and needs a session", async () => {
    expect((await request(app).get(`${BASE}/mine`)).status).toBe(401);
    mockSession(mockQuery, "investor", WALLET, { rows: [caseRow({ status: "prepared", candidate_accepted_at: null })], rowCount: 1 });
    const res = await request(app).get(`${BASE}/mine`).set("Cookie", SESSION_COOKIE_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.data.items[0]).toMatchObject({ id: CASE_ID, status: "prepared", acceptedAt: null });
    expect(res.body.data.items[0].acceptMessage).toContain("Issued At: {issuedAt}");
    expect(JSON.stringify(res.body)).not.toContain("reason");
  });

  it("accept: 404 for a non-candidate (no leak), 409 once the case is not prepared", async () => {
    const other = found(caseRow({ status: "prepared", candidate_user_id: OTHER_USER_ID }));
    expect((await post(`${BASE}/${CASE_ID}/accept`, "investor", accept, [OK, other, OK])).status).toBe(404);
    const open = found(caseRow());
    expect((await post(`${BASE}/${CASE_ID}/accept`, "investor", accept, [OK, open, OK])).status).toBe(409);
  });

  it("accept: an already accepted prepared case answers 200 alreadyAccepted", async () => {
    const accepted = found(caseRow({ status: "prepared" }));
    const res = await post(`${BASE}/${CASE_ID}/accept`, "investor", accept, [OK, accepted, OK]);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ accepted: true, alreadyAccepted: true });
  });

  it("vote: 404 for prepared and cancelled, 409 for closed, ended and legacy cases", async () => {
    const url = `${BASE}/${CASE_ID}/vote`;
    for (const status of ["prepared", "cancelled"]) {
      const row = found(caseRow({ status }));
      expect((await post(url, "investor", body, [OK, row, OK, OK, row, OK])).status).toBe(404);
    }
    const closed = found(caseRow({ status: "closed", result: "no_quorum", yes_weight: "0", no_weight: "0", voted_weight: "0", voter_count: 0, closed_at: new Date() }));
    const cases: [Record<string, unknown>, unknown[]][] = [
      [{ status: "closed" }, [OK, closed, OK, OK, closed, OK]],
      [{ ends_at: null }, [OK, found(caseRow({ ends_at: null })), OK, OK, found(caseRow({ ends_at: null })), OK]],
      // Due case: the pre-check closes it (BEGIN, lock, sums, update, audit, COMMIT) and the vote itself is then refused.
      [{ voting_ended: true }, [OK, found(caseRow({ voting_ended: true })), OK, closed, OK, OK, OK, closed, OK]],
    ];
    for (const [, queue] of cases) {
      expect((await post(url, "investor", body, queue)).status).toBe(409);
    }
  });

  it("vote: 403 for the developer under takeover, the candidate and a non-holder", async () => {
    const url = `${BASE}/${CASE_ID}/vote`;
    for (const overrides of [{ developer_at_open: WALLET }, { candidate_wallet: WALLET }, {}]) {
      const row = found(caseRow(overrides));
      expect((await post(url, "investor", body, [OK, row, OK, OK, row, OK, OK])).status).toBe(403);
    }
  });

  it("vote: 400 for a signature that does not match the session wallet", async () => {
    const row = found(caseRow());
    const holder = found({ staked_balance: "100" });
    const forged = { ...body, signature: await Wallet.createRandom().signMessage("other text") };
    expect((await post(`${BASE}/${CASE_ID}/vote`, "investor", forged, [OK, row, OK, OK, row, holder])).status).toBe(400);
  });

  it("tally: 404 unless opened, aggregate-only DTO otherwise", async () => {
    expect((await request(app).get(`${BASE}/not-a-uuid/tally`)).status).toBe(400);
    mockQuery.mockResolvedValue(found(caseRow({ status: "prepared" })));
    expect((await request(app).get(`${BASE}/${CASE_ID}/tally`)).status).toBe(404);

    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce(found(caseRow()))
      .mockResolvedValueOnce(found({ yes: "150", no: "50", count: "2" }));
    const res = await request(app).get(`${BASE}/${CASE_ID}/tally`);
    expect(res.status).toBe(200);
    expect(res.body.data.tally).toMatchObject({
      status: "vote_open",
      result: null,
      quorumPercent: 20,
      quorumWeightRequired: "200",
      snapshotTotalStaked: "1000",
      yesWeight: "150",
      noWeight: "50",
      votedWeight: "200",
      voterCount: 2,
      quorumReached: true,
      advisory: true,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/voter_address|"voter"|signature|message/);
  });

  describe("my-vote", () => {
    const url = `${BASE}/${CASE_ID}/my-vote`;
    const sessionWallet = Wallet.createRandom().address;
    const closedRow = caseRow({ status: "closed", result: "no_quorum", yes_weight: "0", no_weight: "0", voted_weight: "0", voter_count: 0, closed_at: new Date() });
    const get = (...responses: unknown[]) => {
      mockSession(mockQuery, "investor", sessionWallet, ...responses);
      return request(app).get(url).set("Cookie", SESSION_COOKIE_HEADER);
    };
    const storedVote = found({
      voter_address: sessionWallet.toLowerCase(),
      choice: "NO",
      weight: "5",
      issued_at: new Date(),
      updated_at: new Date(),
      message: "secret text",
      signature: SIG,
    });

    it("401 without a session and 404 for prepared, cancelled and unknown cases", async () => {
      expect((await request(app).get(url)).status).toBe(401);
      for (const status of ["prepared", "cancelled"]) {
        expect((await get(found(caseRow({ status })))).status).toBe(404);
      }
      expect((await get(OK)).status).toBe(404);
    });

    it("eligible staker: weight, own choice and the template; no signature or message, no-store", async () => {
      const res = await get(found(caseRow()), found({ staked_balance: "5" }), storedVote);
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      const view = res.body.data.myVote;
      expect(view).toMatchObject({ eligible: true, canVote: true, weight: "5", myChoice: "NO" });
      const template: string = view.voteMessageTemplate;
      expect(template).toContain("Choice: {choice}");
      expect(template).toContain("Issued At: {issuedAt}");
      expect(template).toContain(`Wallet: ${sessionWallet}`);
      expect(template).toContain(`Case: ${CASE_ID}`);
      expect(template).toContain(`Project: 421614:${WALLET}`);
      const issuedAt = "2026-01-01T00:00:00.000Z";
      expect(template.replace("{choice}", "YES").replace("{issuedAt}", issuedAt)).toBe(
        buildVoteMessage({ caseId: CASE_ID, projectId: `421614:${WALLET}`, choice: "YES", wallet: sessionWallet, issuedAt })
      );
      expect(JSON.stringify(res.body)).not.toMatch(/signature|message"|secret text/);
    });

    it("not eligible for non-holders, the developer at open, the candidate and weight 0", async () => {
      const sessionLower = sessionWallet.toLowerCase();
      const cases: [Record<string, unknown>, unknown][] = [
        [{}, OK],
        [{ developer_at_open: sessionLower }, found({ staked_balance: "5" })],
        [{ candidate_wallet: sessionLower }, found({ staked_balance: "5" })],
        [{}, found({ staked_balance: "0" })],
      ];
      for (const [overrides, weightRow] of cases) {
        const res = await get(found(caseRow(overrides)), weightRow, OK);
        expect(res.status).toBe(200);
        expect(res.body.data.myVote).toEqual({ eligible: false, canVote: true, weight: null, myChoice: null, voteMessageTemplate: null });
      }
    });

    it("canVote is false for a closed case and after endsAt", async () => {
      const closed = await get(found(closedRow), found({ staked_balance: "5" }), OK);
      expect(closed.status).toBe(200);
      expect(closed.body.data.myVote).toMatchObject({ eligible: true, canVote: false, voteMessageTemplate: null });
      const past = found(caseRow({ ends_at: new Date(Date.now() - 1000) }));
      const ended = await get(past, found({ staked_balance: "5" }), OK);
      expect(ended.body.data.myVote).toMatchObject({ eligible: true, canVote: false, voteMessageTemplate: null });
    });
  });

  it("by-project DTO exposes the case id and still no per-address data", async () => {
    mockQuery.mockResolvedValueOnce(found(caseRow())).mockResolvedValueOnce(found({ yes: "0", no: "0", count: "0" }));
    const res = await request(app).get(`${BASE}/by-project/421614/${WALLET}`);
    expect(res.status).toBe(200);
    expect(res.body.data.case.id).toBe(CASE_ID);
    expect(JSON.stringify(res.body)).not.toMatch(/holders|voter_address|signature|message/);
  });

  it("staff routes: votes are staff or admin only and close is admin only", async () => {
    const votes = `/api/v1/admin/takeover-cases/${CASE_ID}/votes`;
    mockSession(mockQuery, "investor", WALLET);
    expect((await request(app).get(votes).set("Cookie", SESSION_COOKIE_HEADER)).status).toBe(403);
    expect((await request(app).get(votes)).status).toBe(401);
    const close = `/api/v1/admin/takeover-cases/${CASE_ID}/close`;
    expect((await post(close, "staff", {}, [])).status).toBe(403);
    expect((await post(close, "admin", {}, [], "https://evil.example")).status).toBe(403);
  });

  it("admin close: 409 before the window ends and an idempotent 200 once closed", async () => {
    const close = `/api/v1/admin/takeover-cases/${CASE_ID}/close`;
    expect((await post(close, "admin", {}, [OK, found(caseRow()), OK])).status).toBe(409);
    const closed = found(caseRow({ status: "closed", result: "passed", yes_weight: "300", no_weight: "0", voted_weight: "300", voter_count: 1, closed_at: new Date() }));
    const res = await post(close, "admin", {}, [OK, closed, OK]);
    expect(res.status).toBe(200);
    expect(res.body.data.case).toMatchObject({ status: "closed", result: "passed", yesWeight: "300" });
  });
});
