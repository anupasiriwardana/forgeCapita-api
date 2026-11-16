/**
 * withTransactionLock against plain Postgres (pg_test). Neon's pgbouncer itself cannot be tested here;
 * this proves the lock is taken, exclusive and released at COMMIT/ROLLBACK on one backend.
 * The lock transaction pins one pool connection, so fn runs its own queries on other pool connections.
 */

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { withTransactionLock } from "../../src/db/advisoryLock.js";
import { bootstrapDatabase, closePool, pool } from "./db.js";

beforeAll(bootstrapDatabase);
afterAll(closePool);

const LOCK_ID = 727361199;

describe("withTransactionLock", () => {
  it("lets only one of two concurrent callers run and releases at COMMIT", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let runs = 0;
    const first = withTransactionLock(LOCK_ID, "first", async () => {
      runs += 1;
      entered();
      await pool.query("SELECT 1");
      await gate;
    });
    await started;
    const second = await withTransactionLock(LOCK_ID, "second", async () => {
      runs += 1;
    });
    expect(second).toBe(false);
    release();
    await expect(first).resolves.toBe(true);
    expect(runs).toBe(1);
    await expect(withTransactionLock(LOCK_ID, "third", async () => undefined)).resolves.toBe(true);
  });

  it("releases the lock when fn throws", async () => {
    await expect(
      withTransactionLock(LOCK_ID, "failing", async () => {
        throw new Error("pass failed");
      })
    ).rejects.toThrow("pass failed");
    await expect(withTransactionLock(LOCK_ID, "after-failure", async () => undefined)).resolves.toBe(true);
  });

  it("leaves no advisory lock behind", async () => {
    await withTransactionLock(LOCK_ID, "clean", async () => undefined);
    const held = await pool.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objid = $1::oid", [LOCK_ID]);
    expect(held.rowCount).toBe(0);
  });
});
