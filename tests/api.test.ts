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
    connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
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
const ESCROW = "0x" + "aB".repeat(20);
const ID = `421614:${ESCROW.toLowerCase()}`;

describe("POST /api/projects/profile", () => {
  const validBody = {
    projectId: `421614:${ESCROW}`,
    name: "ForgeCapita Demo Startup",
    description: "A SaaS platform tokenising startup equity on-chain.",
    logoUrl: "https://cdn.example.com/logo.png",
    pitchDeckUrl: "https://cdn.example.com/pitch.pdf",
    founderBio: "Serial entrepreneur, ex-Google.",
    websiteUrl: "https://forgecapita.io",
    category: "fintech",
    shadowWallet: "0x" + "c".repeat(40),
  };

  it("returns 201 with the public profile only and derives the key server-side", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          name: validBody.name,
          description: validBody.description,
          logo_url: validBody.logoUrl,
          pitch_deck_url: validBody.pitchDeckUrl,
          founder_bio: validBody.founderBio,
          website_url: validBody.websiteUrl,
          category: "fintech",
          updated_at: new Date(0),
        },
      ],
      rowCount: 1,
    });

    const res = await request(app).post("/api/projects/profile").send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.message).toBe("Profile saved");
    expect(res.body.data.name).toBe(validBody.name);
    expect(res.body.data.logoUrl).toBe(validBody.logoUrl);
    expect(res.text).not.toMatch(/shadow|kyc|_/);
    const params = mockQuery.mock.calls[0]?.[1] as unknown[];
    expect(params.slice(0, 3)).toEqual([ID, 421614, ESCROW.toLowerCase()]);
    expect(params).toContain(validBody.shadowWallet);
  });

  it("rejects a non-composite projectId and an unsupported chain", async () => {
    for (const projectId of ["0xabc123", ESCROW, `1:${ESCROW}`]) {
      const res = await request(app)
        .post("/api/projects/profile")
        .send({ ...validBody, projectId });
      expect(res.status).toBe(400);
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await request(app)
      .post("/api/projects/profile")
      .send({ projectId: ID });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns 500 when the DB throws during upsert", async () => {
    mockQuery.mockRejectedValueOnce(new Error("unique constraint violation"));

    const res = await request(app).post("/api/projects/profile").send(validBody);

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET /api/projects — list
// ─────────────────────────────────────────────────────────────────────────────
const projectRow = {
  id: ID,
  chain_id: 421614,
  escrow_address: ESCROW.toLowerCase(),
  token_address: "0x" + "01".repeat(20),
  distributor_address: "0x" + "02".repeat(20),
  developer: "0x" + "03".repeat(20),
  funding_goal: "9007199254740993000000",
  total_raised: "9007199254740993",
  funding_deadline: "1700000000",
  close_grace: "1",
  refund_window: "2",
  voting_period: "3",
  funding_closed_at: null,
  platform_fee: null,
  cancelled_at: null,
  shutdown_at: null,
  total_staked: "0",
  created_at: "1699999999",
  is_funding_active: true,
  state: "FUNDING",
  failed_milestone_index: null,
  is_invalidated: false,
  current_milestone_index: 0,
  token_name: "Tok",
  token_symbol: "TK",
  profile_project_id: null,
  profile_name: null,
  profile_description: null,
  profile_logo_url: null,
  profile_pitch_deck_url: null,
  profile_founder_bio: null,
  profile_website_url: null,
  profile_category: null,
  profile_updated_at: null,
};

function mockListAndCount(rows: unknown[], total: string): void {
  mockQuery.mockImplementation(async (sql: unknown) =>
    String(sql).includes("count(*)")
      ? { rows: [{ total }], rowCount: 1 }
      : { rows, rowCount: rows.length }
  );
}

describe("GET /api/projects", () => {
  const dev = "0x" + "Ab".repeat(20);

  it("returns the paginated envelope with defaults and public camelCase items", async () => {
    mockListAndCount([projectRow], "1");

    const res = await request(app).get("/api/projects");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ total: 1, limit: 20, offset: 0 });
    const item = res.body.data.items[0];
    expect(item.fundingGoal).toBe("9007199254740993000000");
    expect(item.fundingClosedAt).toBeNull();
    expect(item.profile).toBeNull();
    expect(res.text).not.toMatch(/shadow|kyc|chain_id|token_name/i);
    const listParams = mockQuery.mock.calls.find((c) => String(c[0]).includes('p."id"'))?.[1];
    expect(listParams).toEqual([20, 0]);
  });

  it("accepts the caps and lowercases developer", async () => {
    mockListAndCount([], "0");
    const res = await request(app).get(`/api/projects?limit=100&offset=10000&developer=${dev}`);
    expect(res.status).toBe(200);
    const listParams = mockQuery.mock.calls.find((c) => String(c[0]).includes('p."id"'))?.[1];
    expect(listParams).toEqual([dev.toLowerCase(), 100, 10000]);
  });

  it("does not coerce hasProfile=false to true", async () => {
    mockListAndCount([], "0");
    await request(app).get("/api/projects?hasProfile=false");
    const sql = String(mockQuery.mock.calls.find((c) => String(c[0]).includes('p."id"'))?.[0]);
    expect(sql).toContain("s.project_id IS NULL");
  });

  it.each([
    "foo=1",
    "limit=0",
    "limit=101",
    "offset=10001",
    "chainId=1",
    "state=BOGUS",
    "developer=0x123",
    "hasProfile=yes",
    "limit=1&limit=2",
    "sort=id",
    "category=Bad_Cat",
  ])("rejects ?%s with 400", async (qs) => {
    const res = await request(app).get(`/api/projects?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. GET /api/projects/:projectId — detail
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/projects/:projectId", () => {
  it("returns 200 with the project and lowercases the escrow before querying", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [projectRow], rowCount: 1 });

    const res = await request(app).get(`/api/projects/421614:${ESCROW}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(ID);
    expect(res.body.data.profile).toBeNull();
    expect(res.text).not.toMatch(/shadow|kyc|chain_id/i);
    expect(mockQuery.mock.calls[0]?.[1]).toEqual([ID]);
  });

  it("returns 404 when the project does not exist", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get(`/api/projects/97:${ESCROW}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Project not found.");
  });

  it("returns 400 for a non-composite id or unsupported chain", async () => {
    for (const id of ["0xabc123", ESCROW, `1:${ESCROW}`]) {
      const res = await request(app).get(`/api/projects/${id}`);
      expect(res.status).toBe(400);
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("GET /ready", () => {
  it("returns 200 when no migration is pending", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: Array.from({ length: 99 }, (_, i) => ({ version: i + 1, name: `m${i + 1}`, checksum: "x" })),
    });
    const res = await request(app).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { status: "ready" } });
  });

  it("returns 503 with a generic body when the query rejects", async () => {
    mockQuery.mockRejectedValueOnce(new Error("secret db detail"));
    const res = await request(app).get("/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, error: "Not ready" });
  });

  it("returns 503 when a migration is pending", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, error: "Not ready" });
  });
});

describe("/api/v1 prefix and OpenAPI", () => {
  it("serves the list on /api/v1/projects and the legacy /api/projects alias", async () => {
    for (const base of ["/api/v1/projects", "/api/projects"]) {
      mockListAndCount([projectRow], "1");
      const res = await request(app).get(base);
      expect(res.status).toBe(200);
      expect(res.body.data.items[0].id).toBe(ID);
    }
  });

  it("returns 404 on /api/v1/projects/:id for an unknown id", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).get(`/api/v1/projects/97:${ESCROW}`);
    expect(res.status).toBe(404);
  });

  it("serves openapi.json outside production", async () => {
    const res = await request(app).get("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.0.3");
    expect(Object.keys(res.body.paths)).toContain("/api/v1/projects");
  });
});
