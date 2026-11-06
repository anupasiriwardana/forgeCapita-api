/**
 * Hardening tests: headers, request ids, CORS, body limits, validation,
 * error-handler leakage, health, env parsing and log redaction.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import express from "express";
import request from "supertest";
import { Writable } from "node:stream";
import { ALLOWED_ORIGIN, SESSION_COOKIE_HEADER, mockSession } from "./authHelpers.js";

const mockQuery = jest.fn();

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: mockQuery,
    connect: jest.fn().mockResolvedValue({ release: jest.fn() }),
    end: jest.fn(),
  })),
}));

const { createApp } = await import("../src/app.js");
const { createLimiter } = await import("../src/middlewares/rateLimit.js");
const { parseCorsOrigins, envSchema } = await import("../src/config/env.js");
const { createLoggerWithStream } = await import("../src/logger.js");
const { errorHandler, toLoggableError } = await import("../src/middlewares/errorHandler.js");

const app = createApp();

const validBody = {
  projectId: "421614:0x" + "ab".repeat(20),
  name: "Demo",
  description: "A demo startup.",
};

const STAFF = "0x" + "11".repeat(20);
const postProfile = (body: object | string) =>
  request(app)
    .post("/api/projects/profile")
    .set("Cookie", SESSION_COOKIE_HEADER)
    .set("Origin", ALLOWED_ORIGIN)
    .send(body);

beforeEach(() => {
  mockQuery.mockReset();
});

describe("security headers", () => {
  it("sets helmet headers and hides x-powered-by", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["x-request-id"]).toBeDefined();
    expect(res.headers["strict-transport-security"]).toBeUndefined();
  });
});

describe("request id", () => {
  it("echoes a valid incoming id", async () => {
    const res = await request(app).get("/health").set("X-Request-Id", "abc-123_X.y");
    expect(res.headers["x-request-id"]).toBe("abc-123_X.y");
  });

  it("replaces malformed and over-long ids", async () => {
    const bad = await request(app).get("/health").set("X-Request-Id", "bad id;<x>");
    expect(bad.headers["x-request-id"]).not.toBe("bad id;<x>");
    const long = "a".repeat(65);
    const over = await request(app).get("/health").set("X-Request-Id", long);
    expect(over.headers["x-request-id"]).not.toBe(long);
    expect(over.headers["x-request-id"]).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
  });
});

describe("CORS", () => {
  it("allows an exact allow-listed origin", async () => {
    const res = await request(app).get("/health").set("Origin", "https://app.example.com");
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.com");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("denies unknown origins with 403 and no CORS headers", async () => {
    const res = await request(app).get("/health").set("Origin", "https://evil.example.com");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Origin not allowed");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers preflight from an allowed origin", async () => {
    const res = await request(app)
      .options("/api/projects/profile")
      .set("Origin", "http://localhost:3000")
      .set("Access-Control-Request-Method", "POST");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
  });

  it("serves requests without an Origin header", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("body handling", () => {
  it("rejects oversized bodies with 413 and a uniform body", async () => {
    const dataCalls = mockSession(mockQuery, "staff", STAFF);
    const res = await postProfile({ ...validBody, description: "x".repeat(150 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("Payload too large");
    expect(res.text).not.toMatch(/stack| at /);
    expect(dataCalls()).toHaveLength(0);
  });

  it("rejects malformed JSON with 400", async () => {
    const dataCalls = mockSession(mockQuery, "staff", STAFF);
    const res = await request(app)
      .post("/api/projects/profile")
      .set("Cookie", SESSION_COOKIE_HEADER)
      .set("Origin", ALLOWED_ORIGIN)
      .set("Content-Type", "application/json")
      .send('{"projectId": ');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid JSON body");
    expect(dataCalls()).toHaveLength(0);
  });
});

describe("validation", () => {
  const rejects = async (body: object): Promise<void> => {
    mockQuery.mockReset();
    const dataCalls = mockSession(mockQuery, "staff", STAFF);
    const res = await postProfile(body);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("Validation failed");
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(dataCalls()).toHaveLength(0);
  };

  it("rejects missing fields", () => rejects({ projectId: "421614:0x" + "ab".repeat(20) }));

  it("rejects unknown keys without echoing them", async () => {
    const dataCalls = mockSession(mockQuery, "staff", STAFF);
    const res = await postProfile({ ...validBody, secretKeyName: "x" });
    expect(res.status).toBe(400);
    expect(res.text).not.toContain("secretKeyName");
    expect(dataCalls()).toHaveLength(0);
  });

  it("rejects javascript: and data: URLs", async () => {
    await rejects({ ...validBody, websiteUrl: "javascript:alert(1)" });
    await rejects({ ...validBody, logoUrl: "data:text/html,hi" });
  });

  it("rejects a bad shadow wallet", () => rejects({ ...validBody, shadowWallet: "0x123" }));

  it("rejects an over-long description", () =>
    rejects({ ...validBody, description: "x".repeat(5001) }));

  it("rejects projectId with ';' or spaces in the body", async () => {
    await rejects({ ...validBody, projectId: "abc;drop" });
    await rejects({ ...validBody, projectId: "abc def" });
  });

  it("rejects projectId with ';' or spaces in the path", async () => {
    const semi = await request(app).get("/api/projects/abc;drop");
    expect(semi.status).toBe(400);
    const space = await request(app).get("/api/projects/abc%20def");
    expect(space.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("accepts a valid body and chain-prefixed ids", async () => {
    mockSession(
      mockQuery,
      "staff",
      STAFF,
      { rows: [{ id: "bbbbbbbb-0000-4000-8000-000000000001", user_id: "u", address: "0x" + "a".repeat(40) }], rowCount: 1 },
      { rows: [{ name: "n", description: "d", updated_at: new Date(0) }], rowCount: 1 }
    );
    const res = await postProfile({
        ...validBody,
        projectId: "421614:0x" + "ab".repeat(20),
        shadowWallet: "0x" + "a".repeat(40),
      });
    expect(res.status).toBe(201);
  });

  it("404 does not echo the project id", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).get("/api/projects/97:0x" + "cd".repeat(20));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Project not found.");
    expect(res.text).not.toContain("cdcdcd");
  });

  it("unknown route 404 does not echo the query string", async () => {
    const res = await request(app).get("/nope?token=supersecret");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("supersecret");
  });
});

describe("error handler", () => {
  it("does not leak SQL, stack or host on DB failure", async () => {
    const err = new Error("SELECT * FROM startup_profiles failed at pg host db.internal.example");
    err.stack = "Error: boom\n    at pg/lib/client.js:1:1";
    mockSession(mockQuery, "staff", STAFF, err);
    const res = await postProfile(validBody);
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("Internal server error");
    for (const needle of ["SELECT", "stack", "at ", "pg", "db.internal.example", "localhost:5432"]) {
      expect(res.text).not.toContain(needle);
    }
  });
});

describe("client error statuses", () => {
  it("returns 400 for a malformed percent escape without echoing input", async () => {
    const res = await request(app).get("/api/projects/%E0%A4%A");
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("Bad request");
    expect(res.text).not.toContain("%E0");
    expect(res.text).not.toMatch(/URI|decode/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  const appWith = (thrown: unknown): express.Express => {
    const a = express();
    a.get("/", () => {
      throw thrown;
    });
    a.use(errorHandler);
    return a;
  };

  it("maps an exposed 4xx error to a generic message, never err.message", async () => {
    const err = Object.assign(new Error("secret-user-input"), { status: 415, expose: true });
    const res = await request(appWith(err)).get("/");
    expect(res.status).toBe(415);
    expect(res.body).toEqual({ success: false, error: "Unsupported media type" });
    expect(res.text).not.toContain("secret-user-input");
  });

  it("keeps 500 generic for 5xx and for non-exposed 4xx errors", async () => {
    const five = Object.assign(new Error("boom detail"), { status: 503, expose: true });
    const res5 = await request(appWith(five)).get("/");
    expect(res5.status).toBe(500);
    expect(res5.body.error).toBe("Internal server error");
    const hidden = Object.assign(new Error("boom detail"), { status: 400 });
    const res4 = await request(appWith(hidden)).get("/");
    expect(res4.status).toBe(500);
    expect(res4.text).not.toContain("boom detail");
  });
});

describe("loggable errors", () => {
  it("omits the stack in production and keeps it otherwise", () => {
    const err = new Error("connect ECONNREFUSED db.internal.example:5432");
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });
    createLoggerWithStream("info", stream).error({ err: toLoggableError(err, true) }, "x");
    const entry = JSON.parse(chunks.join("")) as { err: { stack?: string } };
    expect(entry.err.stack ?? "").toBe("");
    expect(chunks.join("")).toContain("ECONNREFUSED");
    expect(toLoggableError(err, false)).toBe(err);
  });
});

describe("rate limiting", () => {
  it("createLimiter returns a uniform 429 with rate-limit headers", async () => {
    const small = express();
    small.use(createLimiter({ windowMs: 60_000, max: 2 }));
    small.get("/", (_req, res) => {
      res.json({ ok: true });
    });
    await request(small).get("/");
    const second = await request(small).get("/");
    expect(second.headers["ratelimit"] ?? second.headers["ratelimit-policy"]).toBeDefined();
    const third = await request(small).get("/");
    expect(third.status).toBe(429);
    expect(third.body).toEqual({ success: false, error: "Too many requests." });
    expect(third.headers["x-ratelimit-limit"]).toBeUndefined();
  });
});

describe("health", () => {
  it("/health works without a DB call", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("/health/ behaves like /health", async () => {
    const res = await request(app).get("/health/");
    expect(res.status).toBe(200);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("/health/db returns 503 with no error text", async () => {
    mockQuery.mockRejectedValueOnce(new Error("password authentication failed for user x"));
    const res = await request(app).get("/health/db");
    expect(res.status).toBe(503);
    expect(res.text).not.toContain("password");
  });
});

describe("env parsing", () => {
  it("parses a valid list, trimming and dropping empties", () => {
    expect(parseCorsOrigins(" http://localhost:3000 ,, https://app.example.com ")).toEqual([
      "http://localhost:3000",
      "https://app.example.com",
    ]);
  });

  it("rejects wildcard, trailing slash, path and non-http schemes", () => {
    expect(parseCorsOrigins("*")).toBeNull();
    expect(parseCorsOrigins("https://*.example.com")).toBeNull();
    expect(parseCorsOrigins("https://app.example.com/")).toBeNull();
    expect(parseCorsOrigins("https://app.example.com/path")).toBeNull();
    expect(parseCorsOrigins("ftp://app.example.com")).toBeNull();
    expect(parseCorsOrigins("not a url")).toBeNull();
  });

  const base = { DATABASE_URL: "postgresql://u:p@h/db" };

  it("requires CORS_ORIGINS in production", () => {
    expect(envSchema.safeParse({ ...base, NODE_ENV: "production" }).success).toBe(false);
    expect(
      envSchema.safeParse({ ...base, NODE_ENV: "production", CORS_ORIGINS: " , " }).success
    ).toBe(false);
    expect(
      envSchema.safeParse({
        ...base,
        NODE_ENV: "production",
        CORS_ORIGINS: "https://app.example.com",
      }).success
    ).toBe(true);
  });

  it("defaults to localhost:3000 in development and rejects bad TRUST_PROXY", () => {
    const ok = envSchema.safeParse({ ...base, NODE_ENV: "development" });
    expect(ok.success && ok.data.CORS_ORIGINS).toEqual(["http://localhost:3000"]);
    expect(envSchema.safeParse({ ...base, TRUST_PROXY: "true" }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, TRUST_PROXY: "9" }).success).toBe(false);
  });
});

describe("logger redaction", () => {
  it("redacts sensitive fields", () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });
    const log = createLoggerWithStream("info", stream);
    log.info(
      {
        req: { headers: { authorization: "Bearer s3cr3t", cookie: "sid=s3cr3t" } },
        user: { password: "s3cr3t", token: "s3cr3t" },
      },
      "test"
    );
    const out = chunks.join("");
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("s3cr3t");
  });
});
