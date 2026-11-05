/**
 * Integration tests for the forgeCapita API.
 *
 * Strategy:
 *  - The `pg` module is mocked before any app module is imported.
 *  - `app` is imported via a dynamic import ONCE after the mock is established —
 *    Jest hoisting guarantees the mock is in place.
 *  - `mockQuery` is reset in a top-level `beforeEach` so each test begins with a
 *    clean call queue.  Boot-time migration verification is skipped under
 *    NODE_ENV=test, so queries are purely from request handlers.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import request from "supertest";

// ─── Mock pg BEFORE importing anything that resolves it ──────────────────────

const mockQuery = jest.fn();

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: mockQuery,
    connect: jest.fn().mockResolvedValue({ release: jest.fn() }),
    end: jest.fn(),
  })),
}));

// ─── Import app after mock is in place ───────────────────────────────────────

// ts-jest / @swc/jest supports top-level await in ESM mode
const { default: app } = await import("../src/index.js");


// ─────────────────────────────────────────────────────────────────────────────
// Global reset — runs before every individual test
// ─────────────────────────────────────────────────────────────────────────────
beforeEach(() => {
  mockQuery.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET /health
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /health", () => {
  it("returns 200 liveness without touching the DB", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("ok");
    expect(typeof res.body.data.uptime).toBe("number");
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("GET /health/db", () => {
  it("returns 200 when the DB is reachable", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/health/db");

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "ok", database: "connected" });
  });

  it("returns 503 without error text when the DB query throws", async () => {
    mockQuery.mockRejectedValueOnce(new Error("DB unavailable"));

    const res = await request(app).get("/health/db");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, error: "Database unavailable" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. POST /api/projects/profile — Upsert
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/projects/profile", () => {
  const validBody = {
    projectId: "0xabc123",
    name: "ForgeCapita Demo Startup",
    description: "A SaaS platform tokenising startup equity on-chain.",
    logoUrl: "https://cdn.example.com/logo.png",
    pitchDeckUrl: "https://cdn.example.com/pitch.pdf",
    founderBio: "Serial entrepreneur, ex-Google.",
    websiteUrl: "https://forgecapita.io",
  };

  it("returns 201 with the saved profile on success", async () => {
    const dbRow = {
      project_id: validBody.projectId,
      name: validBody.name,
      description: validBody.description,
      logo_url: validBody.logoUrl,
      pitch_deck_url: validBody.pitchDeckUrl,
      founder_bio: validBody.founderBio,
      website_url: validBody.websiteUrl,
      created_at: new Date().toISOString(),
    };

    // The upsert INSERT ... RETURNING *
    mockQuery.mockResolvedValueOnce({ rows: [dbRow], rowCount: 1 });

    const res = await request(app)
      .post("/api/projects/profile")
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe("Profile saved");
    expect(res.body.data.project_id).toBe(validBody.projectId);
    expect(res.body.data.name).toBe(validBody.name);
  });

  it("returns 400 when required fields are missing", async () => {
    // No DB call — validation short-circuits before hitting the service
    const res = await request(app)
      .post("/api/projects/profile")
      .send({ projectId: "0xabc123" }); // missing name & description

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("Validation failed");
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns 500 when the DB throws during upsert", async () => {
    mockQuery.mockRejectedValueOnce(new Error("unique constraint violation"));

    const res = await request(app)
      .post("/api/projects/profile")
      .send(validBody);

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET /api/projects — All Unified Projects
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/projects", () => {
  const mergedRows = [
    {
      id: "0xabc123",
      total_funded: "5000000000000000000",
      milestone_count: 3,
      milestones_passed: 1,
      is_active: true,
      name: "ForgeCapita Demo Startup",
      description: "A SaaS platform tokenising startup equity on-chain.",
      logo_url: "https://cdn.example.com/logo.png",
      website_url: "https://forgecapita.io",
    },
  ];

  it("returns 200 with an array of merged project data", async () => {
    mockQuery.mockResolvedValueOnce({ rows: mergedRows, rowCount: 1 });

    const res = await request(app).get("/api/projects");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data[0].id).toBe("0xabc123");
    expect(res.body.data[0].name).toBe("ForgeCapita Demo Startup");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. GET /api/projects/:projectId — Single Unified Project
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/projects/:projectId", () => {
  it("returns 200 with the merged project when found", async () => {
    const row = {
      id: "0xabc123",
      name: "ForgeCapita Demo Startup",
      description: "A SaaS platform tokenising startup equity on-chain.",
    };

    mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

    const res = await request(app).get("/api/projects/0xabc123");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe("0xabc123");
  });

  it("returns 404 when the project does not exist", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/api/projects/0xdeadbeef");

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/not found/i);
  });
});
