import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import type { Express } from "express";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { hashSessionToken } from "../../src/auth/session.js";
import { auditRows, bootstrapDatabase, closePool, createSession, createUser, resetData } from "./db.js";

beforeAll(bootstrapDatabase);
beforeEach(resetData);
afterAll(closePool);

const ORIGIN = "http://localhost:3000";
const BODY = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  phone: "+44 20 7946 0958",
  addressLine1: "1 Main Street",
  city: "London",
  postalCode: "N1 9GU",
  country: "GB",
  dateOfBirth: "1990-05-17",
};

let app: Express;
beforeEach(() => {
  app = createApp();
});

describe("personal profile", () => {
  it("upserts, flips profileComplete and audits without any profile value", async () => {
    const user = await createUser(1, "investor");
    const token = "p".repeat(43);
    await createSession(user.id, hashSessionToken(token));
    const cookie = `fc_session=${token}`;

    const before = await request(app).get("/api/v1/auth/me").set("Cookie", cookie);
    expect(before.body.data.user.profileComplete).toBe(false);

    const first = await request(app).put("/api/v1/profile/me").set("Cookie", cookie).set("Origin", ORIGIN).send(BODY);
    expect(first.status).toBe(200);
    const second = await request(app)
      .put("/api/v1/profile/me")
      .set("Cookie", cookie)
      .set("Origin", ORIGIN)
      .send({ ...BODY, city: "Leeds", region: "Yorkshire" });
    expect(second.status).toBe(200);

    const got = await request(app).get("/api/v1/profile/me").set("Cookie", cookie);
    expect(got.body.data.profileComplete).toBe(true);
    expect(got.body.data.profile).toMatchObject({ city: "Leeds", region: "Yorkshire", dateOfBirth: "1990-05-17" });

    const me = await request(app).get("/api/v1/auth/me").set("Cookie", cookie);
    expect(me.body.data.user.profileComplete).toBe(true);
    expect(JSON.stringify(me.body)).not.toContain("Lovelace");

    const rows = await auditRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ action: "profile.save", before_value: null, after_value: null });
      expect(row.target).toMatch(/^0x[0-9a-f]{40}$/);
      expect(JSON.stringify(row)).not.toContain("Lovelace");
    }
  });
});
