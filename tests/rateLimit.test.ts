import { jest, describe, it, expect } from "@jest/globals";
import request from "supertest";

// Overrides must be set before the config module is first imported.
process.env["PROFILE_RATE_LIMIT_MAX"] = "2";
process.env["RATE_LIMIT_MAX"] = "5";

const mockQuery = jest.fn();

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: mockQuery,
    connect: jest.fn().mockResolvedValue({ release: jest.fn() }),
    end: jest.fn(),
  })),
}));

const { createApp } = await import("../src/app.js");
const app = createApp();

describe("app rate limits", () => {
  it("applies the stricter limit to POST /api/projects/profile", async () => {
    const send = () => request(app).post("/api/projects/profile").send({});
    expect((await send()).status).toBe(401);
    expect((await send()).status).toBe(401);
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ success: false, error: "Too many requests." });
  });

  it("never rate limits /health but limits /health/db globally", async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await request(app).get("/health")).status).toBe(200);
      expect((await request(app).get("/health/")).status).toBe(200);
    }
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await request(app).get("/health/db")).status);
    }
    expect(statuses).toContain(429);
  });
});
