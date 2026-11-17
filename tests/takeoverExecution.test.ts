/**
 * Takeover on-chain execution tracking (WS-11.4d-1): the state is derived at read time from indexed
 * developer_change rows. Pure derivation, the eligibility gate with stubbed queries, and the /mine and
 * public routes with a mocked pg.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import { SESSION_COOKIE_HEADER, mockSession } from "./authHelpers.js";

const mockQuery = jest.fn();

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: mockQuery,
    connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
    end: jest.fn(), on: jest.fn(),
  })),
}));

const { createApp } = await import("../src/app.js");
const { deriveExecution, loadExecution } = await import("../src/takeover/takeoverExecution.js");
type TakeoverCase = import("../src/takeover/takeoverRepository.js").TakeoverCase;
type DeveloperChangeRow = import("../src/takeover/takeoverRepository.js").DeveloperChangeRow;

const app = createApp();
const CANDIDATE = "0x" + "11".repeat(20);
const OTHER = "0x" + "22".repeat(20);
const GUARDIAN = "0x" + "33".repeat(20);
const CLOSED_AT = new Date(1_700_000_000_000);
const T0 = 1_700_000_000n;
const PROJECT = `421614:0x${"44".repeat(20)}`;

function row(kind: "proposed" | "accepted", newDeveloper: string, timestamp: bigint, hash = "aa"): DeveloperChangeRow {
  return { kind, newDeveloper, txFrom: GUARDIAN, txHash: "0x" + hash.repeat(32), blockNumber: "10", timestamp };
}

function makeCase(overrides: Partial<TakeoverCase> = {}): TakeoverCase {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    chainId: 421614,
    projectId: PROJECT,
    candidateWallet: CANDIDATE,
    candidateUserId: "11111111-1111-1111-1111-111111111111",
    status: "closed",
    closedAt: CLOSED_AT,
    result: "failed",
    ...overrides,
  } as TakeoverCase;
}

function caseSqlRow(): Record<string, unknown> {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    chain_id: 421614,
    project_id: PROJECT,
    candidate_wallet: CANDIDATE,
    candidate_user_id: "11111111-1111-1111-1111-111111111111",
    reason: "r",
    evidence_links: [],
    status: "closed",
    created_by: "u",
    created_at: new Date(),
    opened_at: new Date(),
    closed_at: CLOSED_AT,
    result: "passed",
    yes_weight: "0",
    no_weight: "0",
    voted_weight: "0",
    voter_count: 0,
    voting_ended: true,
    snapshot_total_staked: null,
    quorum_percent: null,
    ends_at: null,
    snapshot_holder_count: null,
    candidate_accepted_at: new Date(),
  };
}

beforeEach(() => {
  mockQuery.mockReset();
});

describe("deriveExecution", () => {
  it("ignores a proposal made before the case closed", () => {
    expect(deriveExecution([row("proposed", CANDIDATE, T0 - 1n)], CANDIDATE, CLOSED_AT).state).toBe("none");
  });

  it("ignores a proposal for another candidate", () => {
    expect(deriveExecution([row("proposed", OTHER, T0 + 5n)], CANDIDATE, CLOSED_AT).state).toBe("none");
  });

  it("reports proposed, then accepted", () => {
    const proposed = row("proposed", CANDIDATE, T0 + 10n, "bb");
    const view = deriveExecution([proposed], CANDIDATE, CLOSED_AT);
    expect(view.state).toBe("proposed");
    expect(view.pendingForCandidate).toBe(true);
    expect(view.proposedTxHash).toBe(proposed.txHash);
    const accepted = deriveExecution([row("accepted", CANDIDATE, T0 + 20n, "cc"), proposed], CANDIDATE, CLOSED_AT);
    expect(accepted.state).toBe("accepted");
    expect(accepted.pendingForCandidate).toBe(false);
    expect(accepted.acceptedTxHash).toBe("0x" + "cc".repeat(32));
  });

  it("counts an acceptance only after the proposal", () => {
    const view = deriveExecution([row("proposed", CANDIDATE, T0 + 10n), row("accepted", CANDIDATE, T0 + 5n)], CANDIDATE, CLOSED_AT);
    expect(view.state).toBe("proposed");
  });

  it("a later nomination of someone else makes the candidate's nomination no longer pending", () => {
    const view = deriveExecution([row("proposed", OTHER, T0 + 30n), row("proposed", CANDIDATE, T0 + 10n)], CANDIDATE, CLOSED_AT);
    expect(view.pendingForCandidate).toBe(false);
  });
});

describe("loadExecution eligibility", () => {
  function stub(developer: string, changes: unknown[] = []): { query: jest.Mock } {
    const query = jest.fn(async (sql: unknown) =>
      String(sql).includes("developer_change")
        ? { rows: changes }
        : { rows: [{ id: PROJECT, chain_id: 421614, escrow_address: "0xe", developer, state: "ACTIVE", is_invalidated: false }] }
    );
    return { query };
  }

  it.each(["failed", "no_quorum", "passed"] as const)("allows proposing after a %s close", async (result) => {
    const view = await loadExecution(makeCase({ result }), stub(OTHER) as never);
    expect(view.canPropose).toBe(true);
    expect(view.canProposeReason).toBeNull();
  });

  it("refuses a case that is not closed", async () => {
    const view = await loadExecution(makeCase({ status: "vote_open", closedAt: null }), stub(OTHER) as never);
    expect(view.canPropose).toBe(false);
    expect(view.canProposeReason).toMatch(/closed/);
  });

  it("refuses when the candidate is already the indexed developer", async () => {
    const view = await loadExecution(makeCase(), stub("0x" + "11".repeat(20).toUpperCase()) as never);
    expect(view.canPropose).toBe(false);
    expect(view.canProposeReason).toMatch(/already/);
  });

  it("reads the rows with a parameterised statement", async () => {
    const db = stub(OTHER);
    await loadExecution(makeCase(), db as never);
    const call = db.query.mock.calls.find((c) => String(c[0]).includes("developer_change"));
    expect(String(call?.[0])).toContain("project_id = $1");
    expect(String(call?.[0])).not.toContain(PROJECT);
    expect(call?.[1]).toEqual([PROJECT]);
  });

  it("degrades to unknown when the indexer read fails", async () => {
    const view = await loadExecution(makeCase(), { query: jest.fn(async () => Promise.reject(new Error("db down"))) } as never);
    expect(view.state).toBe("unknown");
    expect(view.canPropose).toBe(false);
  });
});

describe("routes", () => {
  it("/mine includes a closed case whose nomination is on chain", async () => {
    mockSession(mockQuery, "USER", CANDIDATE, { rows: [caseSqlRow()] }, {
      rows: [{ kind: "proposed", new_developer: CANDIDATE, tx_from: GUARDIAN, tx_hash: "0x" + "aa".repeat(32), block_number: "9", timestamp: String(T0 + 10n) }],
    });
    const res = await request(app).get("/api/v1/takeover-cases/mine").set("Cookie", SESSION_COOKIE_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].execution.state).toBe("proposed");
    expect(res.body.data.items[0].execution.pendingForCandidate).toBe(true);
  });

  it("/mine hides a closed case without a nomination", async () => {
    mockSession(mockQuery, "USER", CANDIDATE, { rows: [caseSqlRow()] }, { rows: [] });
    const res = await request(app).get("/api/v1/takeover-cases/mine").set("Cookie", SESSION_COOKIE_HEADER);
    expect(res.body.data.items).toHaveLength(0);
  });

  it("the public DTO carries no execution data", async () => {
    mockSession(mockQuery, "USER", CANDIDATE, { rows: [caseSqlRow()] });
    const res = await request(app).get(`/api/v1/takeover-cases/by-project/421614/0x${"44".repeat(20)}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/execution|proposed/);
  });
});
