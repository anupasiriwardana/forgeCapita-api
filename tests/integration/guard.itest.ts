import { describe, expect, it } from "@jest/globals";
import { DEFAULT_TEST_DATABASE_URL, assertSafeTestDatabaseUrl, withSslDisabled } from "./guard.js";

describe("integration safety guard", () => {
  it("accepts the local test databases only", () => {
    expect(assertSafeTestDatabaseUrl(DEFAULT_TEST_DATABASE_URL)).toBe("pg_test");
    expect(assertSafeTestDatabaseUrl("postgresql://test:test@localhost:5433/forgecapita_test")).toBe("localhost");
    expect(assertSafeTestDatabaseUrl("postgres://test:test@127.0.0.1:5432/forgecapita_test")).toBe("127.0.0.1");
  });

  it("aborts for a remote host (Neon style) without echoing credentials", () => {
    const neon = "postgresql://user:secret@ep-cool-123.us-east-2.aws.neon.tech/forgecapita_test?sslmode=require";
    expect(() => assertSafeTestDatabaseUrl(neon)).toThrow(/refuse to run/);
    try {
      assertSafeTestDatabaseUrl(neon);
    } catch (err) {
      expect((err as Error).message).not.toContain("secret");
    }
  });

  it("aborts for a look-alike host or a different database", () => {
    expect(() => assertSafeTestDatabaseUrl("postgresql://t:t@localhost.evil.com:5432/forgecapita_test")).toThrow();
    expect(() => assertSafeTestDatabaseUrl("postgresql://t:t@pg_test.example.com/forgecapita_test")).toThrow();
    expect(() => assertSafeTestDatabaseUrl("postgresql://t:t@localhost:5432/neondb")).toThrow(/database must be/);
    expect(() => assertSafeTestDatabaseUrl("postgresql://t:t@localhost:5432/")).toThrow();
  });

  it("aborts for missing, malformed or non-postgres URLs", () => {
    expect(() => assertSafeTestDatabaseUrl(undefined)).toThrow();
    expect(() => assertSafeTestDatabaseUrl("not a url")).toThrow();
    expect(() => assertSafeTestDatabaseUrl("http://localhost/forgecapita_test")).toThrow();
  });

  it("the running suite is bound to the guarded URL", () => {
    expect(assertSafeTestDatabaseUrl(process.env["DATABASE_URL"]?.replace(/\?.*$/, ""))).toMatch(/^(pg_test|localhost|127\.0\.0\.1)$/);
    expect(withSslDisabled("postgresql://t:t@localhost/forgecapita_test")).toContain("sslmode=disable");
  });
});
