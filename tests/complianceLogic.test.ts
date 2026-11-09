/** Revenue audit step B unit tests: shortfall math, state machine, job gating and wiring. No database. */

import { jest, describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({ query: jest.fn(), connect: jest.fn(), end: jest.fn() })),
}));

const { computeShortfall, nextState } = await import("../src/audit/complianceLogic.js");
const { COMPLIANCE_LOCK_ID, startComplianceJob } = await import("../src/audit/complianceJob.js");
const { formatWei } = await import("../src/controllers/adminController.js");

describe("computeShortfall", () => {
  it("exactly the tolerance is OK, one bps more flags", () => {
    expect(computeShortfall(10_000n, 9_600n, 400)).toEqual({ shortfallBps: 400, flagged: false });
    expect(computeShortfall(10_000n, 9_599n, 400)).toEqual({ shortfallBps: 401, flagged: true });
  });

  it("a fractional shortfall above the tolerance still flags (no rounding into tolerance)", () => {
    // 400.5 bps: floor is 400 but it is strictly above 400.
    expect(computeShortfall(20_000n, 19_199n, 400)).toEqual({ shortfallBps: 400, flagged: true });
  });

  it("routed >= observed and zero observed are OK", () => {
    expect(computeShortfall(5n, 5n, 400)).toEqual({ shortfallBps: 0, flagged: false });
    expect(computeShortfall(5n, 9n, 400)).toEqual({ shortfallBps: 0, flagged: false });
    expect(computeShortfall(0n, 0n, 400)).toEqual({ shortfallBps: 0, flagged: false });
  });

  it("is exact for amounts beyond 2^53", () => {
    const observed = 10n ** 30n;
    expect(computeShortfall(observed, observed - 4n * 10n ** 28n, 400).flagged).toBe(false);
    expect(computeShortfall(observed, observed - 4n * 10n ** 28n - 1n, 400).flagged).toBe(true);
    expect(computeShortfall(observed, 0n, 400).shortfallBps).toBe(10_000);
  });
});

describe("nextState", () => {
  const now = new Date("2026-06-30T00:00:00Z");
  const opened = (days: number): Date => new Date(now.getTime() - days * 86_400_000);

  it("opens, escalates after 14 days and resolves automatically", () => {
    expect(nextState(null, false, now)).toBe("OK");
    expect(nextState(null, true, now)).toBe("WARNED");
    expect(nextState({ state: "OK", openedAt: opened(99) }, true, now)).toBe("WARNED");
    expect(nextState({ state: "WARNED", openedAt: opened(13) }, true, now)).toBe("WARNED");
    expect(nextState({ state: "WARNED", openedAt: opened(14) }, true, now)).toBe("ESCALATED");
    expect(nextState({ state: "ESCALATED", openedAt: opened(1) }, true, now)).toBe("ESCALATED");
    expect(nextState({ state: "WARNED", openedAt: opened(1) }, false, now)).toBe("RESOLVED");
    expect(nextState({ state: "ESCALATED", openedAt: opened(30) }, false, now)).toBe("RESOLVED");
  });
});

describe("startComplianceJob", () => {
  const base = {
    NODE_ENV: "development" as const,
    REVENUE_AUDIT_ENABLED: true,
    ETHERSCAN_API_KEY: "key" as string | undefined,
    REVENUE_AUDIT_CHAINS: [421614],
    EXPLORER_POLL_INTERVAL_MS: 900_000,
    REVENUE_TOLERANCE_BPS: 400,
  };

  it("uses its own advisory lock id", () => {
    expect(COMPLIANCE_LOCK_ID).toBe(727361005);
  });

  it("is null under test, when disabled, or without the key", () => {
    expect(startComplianceJob()).toBeNull();
    expect(startComplianceJob({ ...base, NODE_ENV: "test" })).toBeNull();
    expect(startComplianceJob({ ...base, REVENUE_AUDIT_ENABLED: false })).toBeNull();
    expect(startComplianceJob({ ...base, ETHERSCAN_API_KEY: undefined })).toBeNull();
  });

  it("src/index.ts imports and calls the job and awaits its stop before pool.end()", () => {
    const text = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(text).toMatch(/import \{ startComplianceJob \} from "\.\/audit\/complianceJob\.js"/);
    expect(text).toContain("const stopCompliance = startComplianceJob();");
    const stopAt = text.indexOf("stopCompliance ? stopCompliance()");
    expect(stopAt).toBeGreaterThan(text.indexOf("Promise.all(["));
    expect(stopAt).toBeLessThan(text.indexOf("pool.end()"));
  });
});

describe("formatWei", () => {
  it("formats 18-decimal amounts exactly", () => {
    expect(formatWei(0n)).toBe("0");
    expect(formatWei(10n ** 18n)).toBe("1");
    expect(formatWei(15n * 10n ** 17n)).toBe("1.5");
    expect(formatWei(1n)).toBe("0.000000000000000001");
    expect(formatWei(123456789012345678901234567890n)).toBe("123456789012.34567890123456789");
  });
});
