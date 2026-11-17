/** Pool error listeners and transient-network-error classification. */

import { jest, describe, it, expect, afterEach } from "@jest/globals";
import { EventEmitter } from "node:events";

const { pool } = await import("../src/db/pool.js");
const { logger } = await import("../src/logger.js");
const { isTransientNetworkError } = await import("../src/db/transientErrors.js");

const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => undefined);

afterEach(() => warnSpy.mockClear());

describe("pool error listeners", () => {
  it("survives an idle client error and warns", () => {
    expect(() => pool.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warnSpy.mock.calls[0])).not.toMatch(/postgres(ql)?:\/\//);
  });

  it("attaches a persistent error listener to each connected client", () => {
    const fake = new EventEmitter();
    pool.emit("connect", fake);
    expect(() => fake.emit("error", new Error("connect ETIMEDOUT"))).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

function coded(code: string): Error {
  return Object.assign(new Error("db failure"), { code });
}

describe("isTransientNetworkError", () => {
  const transientCodes = [
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "ENOTFOUND",
    "EAI_AGAIN",
    "57P01",
    "57P03",
    "08006",
    "08003",
  ];

  it.each(transientCodes)("is transient for code %s", (code) => {
    expect(isTransientNetworkError(coded(code))).toBe(true);
  });

  it.each(["Connection terminated unexpectedly", "Connection terminated due to connection timeout"])(
    "is transient for message %s",
    (message) => {
      expect(isTransientNetworkError(new Error(message))).toBe(true);
    }
  );

  it("is transient for an AggregateError wrapping ETIMEDOUT", () => {
    expect(isTransientNetworkError(new AggregateError([coded("ETIMEDOUT"), coded("ETIMEDOUT")]))).toBe(true);
  });

  it("is not transient for an AggregateError of ordinary errors", () => {
    expect(isTransientNetworkError(new AggregateError([new Error("boom")]))).toBe(false);
  });

  it.each([
    ["generic Error", new Error("boom")],
    ["TypeError", new TypeError("x is undefined")],
    ["string", "ETIMEDOUT"],
    ["undefined", undefined],
    ["pg unique violation", coded("23505")],
    ["pg undefined table", coded("42P01")],
  ])("is not transient for %s", (_label, err) => {
    expect(isTransientNetworkError(err)).toBe(false);
  });
});
