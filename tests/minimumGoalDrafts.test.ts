/**
 * Draft creation under MINIMUM_GOAL_MODE=live and =test. The mode is assigned before the app is
 * imported (config is parsed at import); the live file runs with no gas samples, so the minimum is
 * the 0.5 ETH floor for chain 421614.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import { ALLOWED_ORIGIN, SESSION_COOKIE_HEADER, mockSession } from "./authHelpers.js";

process.env["MINIMUM_GOAL_MODE"] = "live";

const mockQuery = jest.fn();

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: mockQuery,
    connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
    end: jest.fn(),
  })),
}));

const { createApp } = await import("../src/app.js");
const { resetMinimumGoalCache } = await import("../src/gas/minimumGoal.js");
const app = createApp();

const DRAFT_ID = "dddddddd-0000-4000-8000-000000000001";
const ADDRESS = "0x" + "11".repeat(20);
const base = { chainId: 421614, name: "Acme", description: "A SaaS" };
const FLOOR = "500000000000000000";

const noSamples = [{ rows: [{ avg: null }], rowCount: 1 }, { rows: [], rowCount: 0 }];
const draftRow = {
  rows: [
    {
      id: DRAFT_ID,
      user_id: "11111111-1111-1111-1111-111111111111",
      status: "pending",
      chain_id: 421614,
      founder_wallet_id: null,
      escrow_address: null,
      project_id: null,
      name: "Acme",
      created_at: new Date(1_700_000_000_000),
      applied_at: null,
    },
  ],
  rowCount: 1,
};

beforeEach(() => {
  mockQuery.mockReset();
  resetMinimumGoalCache();
});

function post(body: unknown) {
  return request(app)
    .post("/api/v1/launch-drafts")
    .set("Origin", ALLOWED_ORIGIN)
    .set("Cookie", SESSION_COOKIE_HEADER)
    .send(body as object);
}

describe("live mode", () => {
  it("rejects a missing goal with 422 and writes nothing", async () => {
    const calls = mockSession(mockQuery, "staff", ADDRESS, ...noSamples, draftRow);
    const res = await post(base);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Funding goal is below the current minimum of 0.5 ETH (live gas-based minimum).");
    expect(calls().some(([sql]) => String(sql).includes("INSERT INTO app.launch_drafts"))).toBe(false);
  });

  it("rejects a goal below the minimum, also for staff", async () => {
    mockSession(mockQuery, "staff", ADDRESS, ...noSamples, draftRow);
    expect((await post({ ...base, fundingGoalWei: "499999999999999999" })).status).toBe(422);
  });

  it("accepts a goal at the minimum and stores it as a string in the payload", async () => {
    const calls = mockSession(mockQuery, "staff", ADDRESS, ...noSamples, draftRow);
    const res = await post({ ...base, fundingGoalWei: FLOOR });
    expect(res.status).toBe(201);
    const insert = calls().find(([sql]) => String(sql).includes("INSERT INTO app.launch_drafts")) as [string, unknown[]];
    expect(JSON.parse(insert[1][4] as string)).toMatchObject({ fundingGoalWei: FLOOR });
  });

  it("rejects malformed goal values with 400", async () => {
    mockSession(mockQuery, "staff", ADDRESS);
    for (const fundingGoalWei of ["0", "-1", "1.5", "0x10", "1".repeat(79), 5]) {
      expect((await post({ ...base, fundingGoalWei })).status).toBe(400);
    }
  });
});
