/**
 * Takeover repository handover (WS-11.4d-2): service flow with a fake provider and a mocked pg,
 * plus the route guards. No network is used.
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
const { handoverRepository } = await import("../src/takeover/takeoverHandover.js");
const { AppError } = await import("../src/errors.js");
import type { RepoProvider } from "../src/repos/repoProvider.js";

const app = createApp();
const CASE_ID = "22222222-2222-2222-2222-222222222222";
const ADMIN_ID = "33333333-3333-3333-3333-333333333333";
const CANDIDATE = "0x" + "11".repeat(20);
const PROJECT = `421614:0x${"44".repeat(20)}`;
const CLOSED_AT = new Date(1_700_000_000_000);
const T0 = 1_700_000_000;
const NEW_LOGIN = "new-dev";

interface Setup {
  accepted?: boolean;
  repoStatus?: string | null;
  handover?: { login: string; status: "invited" | "active" } | null;
}

function caseRow(handover: Setup["handover"]): Record<string, unknown> {
  return {
    id: CASE_ID,
    chain_id: 421614,
    project_id: PROJECT,
    candidate_wallet: CANDIDATE,
    candidate_user_id: "11111111-1111-1111-1111-111111111111",
    reason: "r",
    evidence_links: [],
    status: "closed",
    created_by: "u",
    created_at: new Date(),
    closed_at: CLOSED_AT,
    result: "passed",
    voting_ended: true,
    new_developer_github_login: handover?.login ?? null,
    handover_status: handover?.status ?? null,
    handover_repo_id: handover ? "rid-1" : null,
    handed_over_at: handover ? new Date(1_700_000_500_000) : null,
    handed_over_by: handover ? ADMIN_ID : null,
  };
}

function repoRow(status: string): Record<string, unknown> {
  return {
    id: "rid-1",
    user_id: "11111111-1111-1111-1111-111111111111",
    founder_wallet: "0x" + "55".repeat(20),
    provider: "github",
    repo_id: "99",
    repo_name: "fc-app-abcdef",
    full_name: "forge-org/fc-app-abcdef",
    html_url: "https://github.com/forge-org/fc-app-abcdef",
    founder_login: "old-dev",
    collaborator_id: null,
    collaborator_status: status,
    project_id: PROJECT,
    created_at: new Date(1_700_000_000_000),
  };
}

function setup({ accepted = true, repoStatus = "active", handover = null }: Setup = {}): string[] {
  const sql: string[] = [];
  mockQuery.mockImplementation(async (text: unknown) => {
    const q = String(text);
    sql.push(q);
    if (q.includes("FROM app.takeover_cases WHERE id")) return { rows: [caseRow(handover)], rowCount: 1 };
    if (q.includes("developer_change")) {
      const rows = accepted
        ? [
            { kind: "accepted", new_developer: CANDIDATE, tx_from: CANDIDATE, tx_hash: "0x" + "bb".repeat(32), block_number: "11", timestamp: String(T0 + 20) },
            { kind: "proposed", new_developer: CANDIDATE, tx_from: CANDIDATE, tx_hash: "0x" + "aa".repeat(32), block_number: "10", timestamp: String(T0 + 10) },
          ]
        : [];
      return { rows, rowCount: rows.length };
    }
    if (q.includes('."project"')) {
      return { rows: [{ id: PROJECT, chain_id: 421614, escrow_address: "0xe", developer: CANDIDATE, state: "ACTIVE", is_invalidated: false }], rowCount: 1 };
    }
    if (q.includes("FROM app.project_repos r")) {
      return repoStatus === null ? { rows: [], rowCount: 0 } : { rows: [repoRow(repoStatus)], rowCount: 1 };
    }
    if (q.includes("RETURNING handed_over_at")) return { rows: [{ handed_over_at: new Date(1_700_000_900_000) }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  return sql;
}

function fakeProvider(overrides: Partial<RepoProvider> = {}): RepoProvider {
  return {
    userExists: jest.fn(async () => true),
    createRepo: jest.fn(async () => {
      throw new Error("not used");
    }),
    addCollaborator: jest.fn(async () => ({ status: "invited" as const, collaboratorId: 7 })),
    removeCollaborator: jest.fn(async () => undefined),
    ...overrides,
  };
}

async function failure(promise: Promise<unknown>): Promise<InstanceType<typeof AppError>> {
  return (await promise.catch((e: unknown) => e)) as InstanceType<typeof AppError>;
}

const written = (sql: string[]): boolean =>
  sql.some((q) => q.includes("SET new_developer_github_login") || q.includes("SET handover_status") || q.includes("INSERT INTO app.audit_log"));

beforeEach(() => {
  mockQuery.mockReset();
});

describe("handoverRepository", () => {
  it("409 when the new developer has not accepted on chain", async () => {
    setup({ accepted: false });
    const provider = fakeProvider();
    const err = await failure(handoverRepository(CASE_ID, NEW_LOGIN, ADMIN_ID, null, provider));
    expect(err.status).toBe(409);
    expect(err.message).toBe("The new developer has not accepted on chain yet");
    expect(provider.addCollaborator).not.toHaveBeenCalled();
  });

  it("409 without a linked repository and no provider call", async () => {
    setup({ repoStatus: null });
    const provider = fakeProvider();
    const err = await failure(handoverRepository(CASE_ID, NEW_LOGIN, ADMIN_ID, null, provider));
    expect(err.status).toBe(409);
    expect(err.message).toBe("No repository is linked to this project");
    expect(provider.userExists).not.toHaveBeenCalled();
  });

  it("422 when the login is the previous developer (case-insensitive)", async () => {
    setup();
    const provider = fakeProvider();
    const err = await failure(handoverRepository(CASE_ID, "OLD-dev", ADMIN_ID, null, provider));
    expect(err.status).toBe(422);
    expect(provider.addCollaborator).not.toHaveBeenCalled();
  });

  it("422 when the GitHub user does not exist", async () => {
    const sql = setup();
    const provider = fakeProvider({ userExists: jest.fn(async () => false) });
    const err = await failure(handoverRepository(CASE_ID, NEW_LOGIN, ADMIN_ID, null, provider));
    expect(err.status).toBe(422);
    expect(err.message).toBe("GitHub user not found");
    expect(written(sql)).toBe(false);
  });

  it("503 when provisioning is not configured", async () => {
    setup();
    const err = await failure(handoverRepository(CASE_ID, NEW_LOGIN, ADMIN_ID, null, null));
    expect(err.status).toBe(503);
    expect(err.message).toBe("Repository provisioning is not configured");
  });

  it("records an invited handover with write access and an audit row free of the login", async () => {
    const sql = setup();
    const provider = fakeProvider();
    const result = await handoverRepository(CASE_ID, NEW_LOGIN, ADMIN_ID, "1.2.3.4", provider);
    expect(result.status).toBe("invited");
    expect(result.alreadyHandedOver).toBe(false);
    expect(provider.addCollaborator).toHaveBeenCalledWith("fc-app-abcdef", NEW_LOGIN);
    expect(sql).toContain("COMMIT");
    const audit = mockQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO app.audit_log"));
    expect(audit?.[1]).toEqual([ADMIN_ID, "takeover.handover", CANDIDATE, null, "handover invited", "1.2.3.4"]);
    expect(JSON.stringify(audit?.[1])).not.toContain(NEW_LOGIN);
  });

  it("records an active handover when the user is already a collaborator", async () => {
    setup();
    const provider = fakeProvider({ addCollaborator: jest.fn(async () => ({ status: "active" as const, collaboratorId: null })) });
    const result = await handoverRepository(CASE_ID, NEW_LOGIN, ADMIN_ID, null, provider);
    expect(result.status).toBe("active");
    const audit = mockQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO app.audit_log"));
    expect((audit?.[1] as unknown[])[4]).toBe("handover active");
  });

  it("rolls everything back when the provider fails", async () => {
    const sql = setup();
    const provider = fakeProvider({
      addCollaborator: jest.fn(async () => {
        throw new AppError(502, "Repository provider request failed", true);
      }),
    });
    const err = await failure(handoverRepository(CASE_ID, NEW_LOGIN, ADMIN_ID, null, provider));
    expect(err.status).toBe(502);
    expect(sql).toContain("ROLLBACK");
    expect(sql).not.toContain("COMMIT");
    expect(written(sql)).toBe(false);
  });

  it("is idempotent for an active handover: no provider call and no audit row", async () => {
    const sql = setup({ handover: { login: NEW_LOGIN, status: "active" } });
    const provider = fakeProvider();
    const result = await handoverRepository(CASE_ID, "NEW-DEV", ADMIN_ID, null, provider);
    expect(result.alreadyHandedOver).toBe(true);
    expect(result.status).toBe("active");
    expect(provider.addCollaborator).not.toHaveBeenCalled();
    expect(written(sql)).toBe(false);
  });

  it("retries an invited handover and audits only when the status changes", async () => {
    const stillInvited = setup({ handover: { login: NEW_LOGIN, status: "invited" } });
    await handoverRepository(CASE_ID, NEW_LOGIN, ADMIN_ID, null, fakeProvider());
    expect(stillInvited.some((q) => q.includes("SET handover_status"))).toBe(true);
    expect(stillInvited.some((q) => q.includes("INSERT INTO app.audit_log"))).toBe(false);

    mockQuery.mockReset();
    const nowActive = setup({ handover: { login: NEW_LOGIN, status: "invited" } });
    const provider = fakeProvider({ addCollaborator: jest.fn(async () => ({ status: "active" as const, collaboratorId: null })) });
    const result = await handoverRepository(CASE_ID, NEW_LOGIN, ADMIN_ID, null, provider);
    expect(result.status).toBe("active");
    expect(nowActive.some((q) => q.includes("INSERT INTO app.audit_log"))).toBe(true);
  });

  it("409 for a different login on an already handed-over case", async () => {
    setup({ handover: { login: NEW_LOGIN, status: "invited" } });
    const provider = fakeProvider();
    const err = await failure(handoverRepository(CASE_ID, "someone-else", ADMIN_ID, null, provider));
    expect(err.status).toBe(409);
    expect(provider.addCollaborator).not.toHaveBeenCalled();
  });

  it("still allows a handover after the previous developer was revoked", async () => {
    setup({ repoStatus: "revoked" });
    const result = await handoverRepository(CASE_ID, NEW_LOGIN, ADMIN_ID, null, fakeProvider());
    expect(result.status).toBe("invited");
    expect(result.repo.status).toBe("revoked");
  });
});

describe("POST /api/v1/admin/takeover-cases/:id/handover guards", () => {
  const URL = `/api/v1/admin/takeover-cases/${CASE_ID}/handover`;
  const send = (body: object) =>
    request(app).post(URL).set("Origin", ALLOWED_ORIGIN).set("Cookie", SESSION_COOKIE_HEADER).send(body);

  it("401 anonymous, 403 bad origin, 403 staff", async () => {
    mockSession(mockQuery, "admin", CANDIDATE);
    expect((await request(app).post(URL).set("Origin", ALLOWED_ORIGIN).send({ githubLogin: NEW_LOGIN })).status).toBe(401);
    const badOrigin = await request(app).post(URL).set("Origin", "https://evil.example").set("Cookie", SESSION_COOKIE_HEADER).send({ githubLogin: NEW_LOGIN });
    expect(badOrigin.status).toBe(403);
    mockSession(mockQuery, "staff", CANDIDATE);
    expect((await send({ githubLogin: NEW_LOGIN })).status).toBe(403);
  });

  it("400 for an invalid login or an unknown field", async () => {
    mockSession(mockQuery, "admin", CANDIDATE);
    expect((await send({ githubLogin: "bad name" })).status).toBe(400);
    expect((await send({ githubLogin: NEW_LOGIN, extra: 1 })).status).toBe(400);
    expect((await send({})).status).toBe(400);
  });
});
