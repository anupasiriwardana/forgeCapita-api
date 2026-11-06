import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { readFileSync } from "node:fs";

const mockQuery = jest.fn();

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: mockQuery,
    connect: jest.fn(),
    end: jest.fn(),
  })),
}));

const { upsertProfile, getProjectById, listProjects, toProjectDto } = await import(
  "../src/services/projectService.js"
);
const { escapeLike } = await import("../src/repositories/projectRepository.js");
const { qualified } = await import("../src/db/pool.js");
const { envSchema } = await import("../src/config/env.js");

const ESCROW = "0x" + "ab".repeat(20);
const ID = `421614:${ESCROW}`;

function sqlOf(call: number): string {
  return String(mockQuery.mock.calls[call]?.[0]);
}

function paramsOf(call: number): unknown[] {
  return mockQuery.mock.calls[call]?.[1] as unknown[];
}

/** Finds the list and count calls regardless of Promise.all ordering. */
function listAndCount(): { list: number; count: number } {
  const sqls = mockQuery.mock.calls.map((c) => String(c[0]));
  return {
    list: sqls.findIndex((s) => s.includes('p."id"')),
    count: sqls.findIndex((s) => s.includes("count(*)")),
  };
}

function whereOf(sql: string): string {
  const end = sql.indexOf("ORDER BY");
  return sql.slice(sql.indexOf("WHERE"), end > 0 ? end : undefined).trim();
}

const defaults = { limit: 20, offset: 0, sort: "created_at", order: "desc" } as const;

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("projectRepository SQL", () => {
  it("joins on chain_id and escrow_address with the qualified Ponder table", async () => {
    await listProjects({ ...defaults });
    const { list, count } = listAndCount();
    for (const i of [list, count]) {
      expect(sqlOf(i)).toContain('FROM "ponder"."project" p');
      expect(sqlOf(i)).toContain(
        'LEFT JOIN app.startup_profiles s ON s.chain_id = p."chain_id" AND s.escrow_address = p."escrow_address"'
      );
    }
    expect(sqlOf(list)).not.toMatch(/\bp\.\*|\bs\.\*/);
  });

  it.each([
    ["created_at", "desc", 'ORDER BY p."created_at" DESC, p."id" ASC'],
    ["total_raised", "asc", 'ORDER BY p."total_raised" ASC, p."id" ASC'],
    ["funding_goal", "desc", 'ORDER BY p."funding_goal" DESC, p."id" ASC'],
  ] as const)("orders by %s %s from constants only", async (sort, order, expected) => {
    await listProjects({ ...defaults, sort, order });
    expect(sqlOf(listAndCount().list)).toContain(expected);
  });

  it("binds every filter value and uses the same WHERE for list and count", async () => {
    const evil = "x'; DROP TABLE y;--";
    await listProjects({
      ...defaults,
      chainId: 97,
      state: "ACTIVE",
      developer: ESCROW,
      q: evil,
      category: "saas",
      hasProfile: true,
    });
    const { list, count } = listAndCount();
    expect(whereOf(sqlOf(list))).toBe(whereOf(sqlOf(count)));
    expect(sqlOf(list)).not.toContain("DROP TABLE");
    expect(sqlOf(list)).toContain("s.project_id IS NOT NULL");
    expect(paramsOf(list)).toEqual([97, "ACTIVE", ESCROW, `%${evil}%`, "saas", 20, 0]);
    expect(paramsOf(count)).toEqual([97, "ACTIVE", ESCROW, `%${evil}%`, "saas"]);
  });

  it("escapes LIKE wildcards in q and declares ESCAPE", async () => {
    expect(escapeLike("50%_a\\b")).toBe("50\\%\\_a\\\\b");
    await listProjects({ ...defaults, q: "a%b" });
    const { list } = listAndCount();
    expect(sqlOf(list)).toContain("ILIKE $1 ESCAPE '\\'");
    expect(paramsOf(list)[0]).toBe("%a\\%b%");
  });

  it("hasProfile=false filters on a join miss", async () => {
    await listProjects({ ...defaults, hasProfile: false });
    expect(sqlOf(listAndCount().list)).toContain("s.project_id IS NULL");
  });

  it("looks up one project by composite id parameter", async () => {
    await getProjectById(ID);
    expect(sqlOf(0)).toContain('WHERE p."id" = $1');
    expect(paramsOf(0)).toEqual([ID]);
  });

  it("upsert writes to app.startup_profiles and derives chain_id and escrow_address", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ name: "n", description: "d", updated_at: new Date(0) }],
      rowCount: 1,
    });
    await upsertProfile(
      { projectId: ID, name: "n", description: "d", category: "ai" },
      { id: "u", address: "0x" + "11".repeat(20), role: "staff" }
    );
    expect(sqlOf(0)).toContain("INSERT INTO app.startup_profiles");
    expect(sqlOf(0)).toContain("category          = EXCLUDED.category");
    expect(sqlOf(0)).not.toContain("RETURNING *");
    expect(paramsOf(0).slice(0, 3)).toEqual([ID, 421614, ESCROW]);
  });
});

describe("projectService mapping", () => {
  const row = {
    id: ID,
    chain_id: 421614,
    escrow_address: ESCROW,
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

  it("keeps big numeric strings exact and nulls as null, with profile null on a join miss", () => {
    const dto = toProjectDto(row);
    expect(dto.fundingGoal).toBe("9007199254740993000000");
    expect(dto.totalRaised).toBe("9007199254740993");
    expect(dto.fundingClosedAt).toBeNull();
    expect(dto.failedMilestoneIndex).toBeNull();
    expect(dto.profile).toBeNull();
  });

  it("exposes only public profile fields in camelCase", () => {
    const dto = toProjectDto({
      ...row,
      profile_project_id: ID,
      profile_name: "P",
      profile_description: "D",
      profile_category: "ai",
      profile_updated_at: new Date(0),
    });
    expect(Object.keys(dto.profile ?? {}).sort()).toEqual(
      [
        "name",
        "description",
        "logoUrl",
        "pitchDeckUrl",
        "founderBio",
        "websiteUrl",
        "category",
        "updatedAt",
      ].sort()
    );
    expect(Object.keys(dto).some((k) => k.includes("_"))).toBe(false);
    expect(JSON.stringify(dto)).not.toMatch(/shadow|kyc/i);
  });

  it("returns total with clamped limit and offset", async () => {
    mockQuery.mockImplementation(async (sql: unknown) =>
      String(sql).includes("count(*)")
        ? { rows: [{ total: "7" }], rowCount: 1 }
        : { rows: [row], rowCount: 1 }
    );
    const out = await listProjects({ ...defaults, limit: 500, offset: 99999 });
    expect(out).toMatchObject({ total: 7, limit: 100, offset: 10000 });
    expect(out.items).toHaveLength(1);
  });
});

describe("migration 003", () => {
  const sql = readFileSync(
    new URL("../migrations/003_startup_profiles_project_key.sql", import.meta.url),
    "utf8"
  );

  it("is forward-only and idempotent", () => {
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT|CONCURRENTLY)\b/i);
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS");
    expect(sql).toContain("DROP CONSTRAINT IF EXISTS startup_profiles_project_key");
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS startup_profiles_chain_escrow_uidx");
    expect(sql).not.toMatch(/application_status|repo_url|owner/);
  });
});

describe("qualified()", () => {
  it("quotes the schema and table", () => {
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
