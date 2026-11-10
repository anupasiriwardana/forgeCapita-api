/**
 * Personal profile: zod rules and the /api/v1/profile routes. The pg module is mocked; the SQL and the
 * audit row are covered by tests/integration/userProfile.itest.ts.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
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
const { profileBodySchema, isAdultDateOfBirth } = await import("../src/schemas/profileSchemas.js");
const app = createApp();

const ADDRESS = "0x" + "11".repeat(20);
const VALID = {
  firstName: " Ada ",
  lastName: "Lovelace",
  email: "Ada@Example.COM",
  phone: "+44 20 7946 0958",
  addressLine1: "1 Main Street",
  city: "London",
  postalCode: "N1 9GU",
  country: "gb",
  dateOfBirth: "1990-05-17",
};
const ROW = {
  first_name: "Ada",
  last_name: "Lovelace",
  email: "ada@example.com",
  phone: "+44 20 7946 0958",
  address_line1: "1 Main Street",
  address_line2: null,
  city: "London",
  region: null,
  postal_code: "N1 9GU",
  country: "GB",
  date_of_birth: "1990-05-17",
};

beforeEach(() => {
  mockQuery.mockReset();
});

describe("profileBodySchema", () => {
  it("accepts a valid body and normalises it", () => {
    const parsed = profileBodySchema.parse(VALID);
    expect(parsed).toMatchObject({ firstName: "Ada", email: "ada@example.com", country: "GB" });
  });

  it.each([
    ["under 18", { dateOfBirth: new Date(Date.now() - 17 * 365 * 86_400_000).toISOString().slice(0, 10) }],
    ["future date of birth", { dateOfBirth: "2999-01-01" }],
    ["impossible date", { dateOfBirth: "1990-02-31" }],
    ["before 1900", { dateOfBirth: "1899-12-31" }],
    ["bad email", { email: "not-an-email" }],
    ["bad country", { country: "GBR" }],
    ["bad phone", { phone: "abc" }],
    ["overlong name", { firstName: "a".repeat(81) }],
    ["extra key", { admin: true }],
  ])("rejects %s", (_name, override) => {
    expect(profileBodySchema.safeParse({ ...VALID, ...override }).success).toBe(false);
  });

  it("rejects a missing required field", () => {
    const { city: _city, ...rest } = VALID;
    expect(profileBodySchema.safeParse(rest).success).toBe(false);
  });

  it("turns 18 exactly on the birthday", () => {
    const now = new Date(Date.UTC(2026, 5, 10));
    expect(isAdultDateOfBirth("2008-06-10", now)).toBe(true);
    expect(isAdultDateOfBirth("2008-06-11", now)).toBe(false);
  });
});

describe("/api/v1/profile/me", () => {
  it("GET is 401 when signed out", async () => {
    const res = await request(app).get("/api/v1/profile/me");
    expect(res.status).toBe(401);
  });

  it("GET returns the owner profile, uncached", async () => {
    mockSession(mockQuery, "investor", ADDRESS, { rows: [ROW], rowCount: 1 });
    const res = await request(app).get("/api/v1/profile/me").set("Cookie", SESSION_COOKIE_HEADER);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.data.profileComplete).toBe(true);
    expect(res.body.data.profile).toMatchObject({ firstName: "Ada", country: "GB", dateOfBirth: "1990-05-17" });
  });

  it("GET returns null and incomplete without a profile", async () => {
    mockSession(mockQuery, "investor", ADDRESS, { rows: [], rowCount: 0 });
    const res = await request(app).get("/api/v1/profile/me").set("Cookie", SESSION_COOKIE_HEADER);
    expect(res.body.data).toEqual({ profile: null, profileComplete: false });
  });

  it("PUT is 401 when signed out", async () => {
    const res = await request(app).put("/api/v1/profile/me").set("Origin", ALLOWED_ORIGIN).send(VALID);
    expect(res.status).toBe(401);
  });

  it("PUT rejects a cross-origin request before touching the database", async () => {
    const calls = mockSession(mockQuery, "investor", ADDRESS);
    const res = await request(app)
      .put("/api/v1/profile/me")
      .set("Cookie", SESSION_COOKIE_HEADER)
      .set("Origin", "https://evil.example")
      .send(VALID);
    expect(res.status).toBe(403);
    expect(calls()).toHaveLength(0);
  });

  it("PUT is 400 on an invalid body and never echoes values", async () => {
    mockSession(mockQuery, "investor", ADDRESS);
    const res = await request(app)
      .put("/api/v1/profile/me")
      .set("Cookie", SESSION_COOKIE_HEADER)
      .set("Origin", ALLOWED_ORIGIN)
      .send({ ...VALID, email: "secret-not-email", extra: "secret-extra" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain("secret");
  });

  it("PUT upserts with normalised, parameterised values", async () => {
    const calls = mockSession(mockQuery, "investor", ADDRESS, { rows: [ROW], rowCount: 1 });
    const res = await request(app)
      .put("/api/v1/profile/me")
      .set("Cookie", SESSION_COOKIE_HEADER)
      .set("Origin", ALLOWED_ORIGIN)
      .send(VALID);
    expect(res.status).toBe(200);
    expect(res.body.data.profileComplete).toBe(true);
    const [sql, params] = calls()[0] as [string, unknown[]];
    expect(sql).toContain("profile.save");
    expect(params).toContain("ada@example.com");
    expect(params).toContain("GB");
  });
});
