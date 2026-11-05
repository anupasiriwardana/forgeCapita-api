import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const mockQuery = jest.fn();

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: mockQuery,
    connect: jest.fn(),
    end: jest.fn(),
  })),
}));

const { upsertProfile, getProjectById, getAllProjects } = await import(
  "../src/services/projectService.js"
);
const { qualified } = await import("../src/db/pool.js");
const { envSchema } = await import("../src/config/env.js");

function lastSql(): string {
  const call = mockQuery.mock.calls.at(-1);
  return String(call?.[0]);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("projectService SQL qualification", () => {
  it("writes to app.startup_profiles", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ project_id: "x" }], rowCount: 1 });
    await upsertProfile({ projectId: "x", name: "n", description: "d" });
    expect(lastSql()).toContain("INSERT INTO app.startup_profiles");
  });

  it("joins the configured Ponder schema for a single project", async () => {
    await getProjectById("x");
    const sql = lastSql();
    expect(sql).toContain('"ponder"."project" p');
    expect(sql).toContain("LEFT JOIN app.startup_profiles s");
    expect(sql).not.toMatch(/FROM project\b/);
  });

  it("joins the configured Ponder schema for the listing", async () => {
    await getAllProjects();
    const sql = lastSql();
    expect(sql).toContain('"ponder"."project" p');
    expect(sql).toContain("LEFT JOIN app.startup_profiles s");
    expect(sql).toContain("ORDER BY p.created_at DESC");
  });

  it("quotes the schema and table in qualified()", () => {
    expect(qualified("project")).toBe('"ponder"."project"');
  });
});

describe("PONDER_SCHEMA validation", () => {
  const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };

  it("defaults to ponder", () => {
    const result = envSchema.safeParse({ ...base, CORS_ORIGINS: "http://localhost:3000" });
    expect(result.success && result.data.PONDER_SCHEMA).toBe("ponder");
  });

  it.each(["public; drop", 'a"b', "Ponder", "1ponder", "pon-der", "", "a".repeat(64)])(
    "rejects %j",
    (value) => {
      const result = envSchema.safeParse({ ...base, PONDER_SCHEMA: value });
      expect(result.success).toBe(false);
    }
  );

  it.each(["ponder", "_ponder_2", "a".repeat(63)])("accepts %j", (value) => {
    const result = envSchema.safeParse({ ...base, PONDER_SCHEMA: value });
    expect(result.success).toBe(true);
  });
});
