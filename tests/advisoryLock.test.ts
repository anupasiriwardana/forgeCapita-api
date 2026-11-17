/** withTransactionLock unit tests: mocked pg client, statement order and release behaviour. */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<{ rows: Array<{ locked: boolean }> }>>();
const mockRelease = jest.fn();

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: jest.fn(),
    connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    end: jest.fn(), on: jest.fn(),
  })),
}));

const { withTransactionLock } = await import("../src/db/advisoryLock.js");
const { logger } = await import("../src/logger.js");

const sqlOf = (): string[] => mockQuery.mock.calls.map((c) => c[0]);

function answer(locked: boolean): void {
  mockQuery.mockImplementation(async (sql) => ({ rows: sql.includes("pg_try_advisory_xact_lock") ? [{ locked }] : [] }));
}

beforeEach(() => {
  mockQuery.mockReset();
  mockRelease.mockReset();
});

describe("withTransactionLock", () => {
  it("runs fn between BEGIN and COMMIT when the lock is granted", async () => {
    answer(true);
    const fn = jest.fn(async () => {
      expect(sqlOf()).toEqual(["BEGIN", "SELECT pg_try_advisory_xact_lock($1::bigint) AS locked"]);
    });
    await expect(withTransactionLock(42, "job", fn)).resolves.toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sqlOf()).toEqual(["BEGIN", "SELECT pg_try_advisory_xact_lock($1::bigint) AS locked", "COMMIT"]);
    expect(mockQuery.mock.calls[1]?.[1]).toEqual([42]);
    expect(mockRelease).toHaveBeenCalledWith(undefined);
  });

  it("rolls back, logs and skips fn when the lock is held elsewhere", async () => {
    answer(false);
    const info = jest.spyOn(logger, "info");
    const fn = jest.fn(async () => undefined);
    await expect(withTransactionLock(42, "job", fn)).resolves.toBe(false);
    expect(fn).not.toHaveBeenCalled();
    expect(sqlOf()).toEqual(["BEGIN", "SELECT pg_try_advisory_xact_lock($1::bigint) AS locked", "ROLLBACK"]);
    expect(info).toHaveBeenCalledWith({ job: "job", lockId: 42 }, "job pass skipped, lock held elsewhere");
    expect(mockRelease).toHaveBeenCalledWith(undefined);
  });

  it("rolls back, releases and rethrows when fn throws", async () => {
    answer(true);
    const boom = new Error("boom");
    await expect(
      withTransactionLock(42, "job", async () => {
        throw boom;
      })
    ).rejects.toBe(boom);
    expect(sqlOf().at(-1)).toBe("ROLLBACK");
    expect(sqlOf()).not.toContain("COMMIT");
    expect(mockRelease).toHaveBeenCalledWith(undefined);
  });

  it("discards the connection when the rollback itself fails", async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (sql === "ROLLBACK") throw new Error("connection lost");
      return { rows: sql.includes("pg_try_advisory_xact_lock") ? [{ locked: true }] : [] };
    });
    const boom = new Error("boom");
    await expect(
      withTransactionLock(42, "job", async () => {
        throw boom;
      })
    ).rejects.toBe(boom);
    expect(mockRelease.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});
