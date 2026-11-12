/**
 * Live minimum funding goal: formula, env schema, public endpoint and job wiring.
 * The pg module is mocked; draft enforcement is in tests/minimumGoalDrafts.test.ts.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { readFileSync } from "node:fs";
import request from "supertest";

const mockQuery = jest.fn();

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: mockQuery,
    connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
    end: jest.fn(),
  })),
}));

const { envSchema } = await import("../src/config/env.js");
const { computeMinimumGoal, serializeMinimumGoal, resetMinimumGoalCache } = await import("../src/gas/minimumGoal.js");
const { startGasJob } = await import("../src/gas/gasJob.js");
const { createApp } = await import("../src/app.js");
const app = createApp();

const params = {
  gasUnits: 1000n,
  gasPriceWei: 1_000_000n,
  l1FeeWei: 10n,
  n: 100n,
  m: 5n,
  marginBps: 5000n,
  floorWei: 0n,
  ceilingWei: null,
};

beforeEach(() => {
  mockQuery.mockReset();
  resetMinimumGoalCache();
});

describe("computeMinimumGoal", () => {
  // txCount = 100 * 7 + 5 = 705; cost = 1000 * 1e6 + 705 * 10 = 1_000_007_050
  it("applies margin and the 5% rule when the computed value wins", () => {
    expect(computeMinimumGoal(params)).toBe((1_000_007_050n * 15_000n * 20n) / 10_000n);
  });

  it("uses a zero margin as cost / 0.05", () => {
    expect(computeMinimumGoal({ ...params, marginBps: 0n })).toBe(1_000_007_050n * 20n);
  });

  it("lets the floor win when the computed value is lower", () => {
    expect(computeMinimumGoal({ ...params, floorWei: 10n ** 18n })).toBe(10n ** 18n);
  });

  it("clamps to the ceiling when one is set", () => {
    expect(computeMinimumGoal({ ...params, ceilingWei: 5_000n })).toBe(5_000n);
  });
});

describe("env schema", () => {
  const base = { DATABASE_URL: "postgresql://x:y@localhost:5432/z" };

  it("defaults MINIMUM_GOAL_MODE to live, also when empty", () => {
    expect(envSchema.parse(base).MINIMUM_GOAL_MODE).toBe("live");
    expect(envSchema.parse({ ...base, MINIMUM_GOAL_MODE: "" }).MINIMUM_GOAL_MODE).toBe("live");
    expect(envSchema.parse({ ...base, MINIMUM_GOAL_MODE: "test" }).MINIMUM_GOAL_MODE).toBe("test");
  });

  it("rejects any other mode value", () => {
    expect(envSchema.safeParse({ ...base, MINIMUM_GOAL_MODE: "off" }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, MINIMUM_GOAL_MODE: "Test" }).success).toBe(false);
  });
});

describe("GET /api/v1/gas/:chainId/minimum-goal", () => {
  it("answers in test mode with minGoalWei null and string numbers (floor fallback is stale)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ avg: null }], rowCount: 1 }).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).get("/api/v1/gas/421614/minimum-goal");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=30");
    expect(res.body.data).toMatchObject({
      mode: "test",
      minGoalWei: null,
      floor: "500000000000000000",
      gasPriceUsed: "0",
      l1FeeUsed: "60000000000000",
      gasUnits: "85020820",
      N: "100",
      M: "5",
      margin: "5000",
      windowHours: "24",
      stale: true,
    });
  });

  it("rejects chains outside the allow-list", async () => {
    expect((await request(app).get("/api/v1/gas/1/minimum-goal")).status).toBe(400);
    expect((await request(app).post("/api/v1/gas/421614/minimum-goal")).status).toBe(404);
  });

  it("serialises the live shape with minGoalWei and an optional ceiling", () => {
    const body = serializeMinimumGoal(
      {
        minGoalWei: 7n,
        floorWei: 5n,
        ceilingWei: 9n,
        gasPriceUsedWei: 3n,
        l1FeeUsedWei: 0n,
        gasUnits: 2n,
        n: 100,
        m: 5,
        marginBps: 5000,
        windowHours: 24,
        computedAt: new Date(0),
        stale: false,
      },
      "live"
    );
    expect(body).toMatchObject({ mode: "live", minGoalWei: "7", floor: "5", ceiling: "9", gasPriceUsed: "3", stale: false });
  });
});

describe("gas job", () => {
  it("does not start under NODE_ENV=test", () => {
    expect(startGasJob({ NODE_ENV: "test", GAS_SAMPLE_INTERVAL_MS: 300_000 })).toBeNull();
  });

  it("src/index.ts imports and calls the job and awaits its stop before pool.end()", () => {
    const text = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(text).toMatch(/import \{ startGasJob \} from "\.\/gas\/gasJob\.js"/);
    expect(text).toContain("const stopGas = startGasJob();");
    const stopAt = text.indexOf("stopGas ? stopGas()");
    expect(stopAt).toBeGreaterThan(text.indexOf("Promise.all(["));
    expect(stopAt).toBeLessThan(text.indexOf("pool.end()"));
  });
});
