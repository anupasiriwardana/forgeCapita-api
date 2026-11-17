/**
 * GitHub repository provisioning: env parsing, App JWT, provider HTTP behaviour (fake fetch),
 * provisioning service flow (fake provider, mocked pg) and route guards. No network is used.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
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
const { envSchema } = await import("../src/config/env.js");
const { GithubProvider, signAppJwt } = await import("../src/repos/githubProvider.js");
const { buildRepoName, slugify } = await import("../src/repos/repoNaming.js");
const { provisionRepo, revokeRepoAccess } = await import("../src/repos/repoService.js");
const { AppError } = await import("../src/errors.js");
import type { RepoProvider } from "../src/repos/repoProvider.js";
import type { AuthUser } from "../src/types/index.js";

const app = createApp();
const FOUNDER = "0x" + "11".repeat(20);
const USER: AuthUser = { id: "11111111-1111-1111-1111-111111111111", address: FOUNDER, role: "founder" } as AuthUser;
const BODY = { githubUsername: "octocat", projectName: "My Cool App" };

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const KEY_B64 = Buffer.from(privateKey).toString("base64");

beforeEach(() => {
  mockQuery.mockReset();
});

// --- env ----------------------------------------------------------------------

describe("env parsing", () => {
  const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };

  it("defaults to disabled, empty values count as unset and protection is off", () => {
    const parsed = envSchema.parse({ ...base, GITHUB_APP_ID: "", GITHUB_ORG: "", REPO_BRANCH_PROTECTION: "" });
    expect(parsed.githubConfigured).toBe(false);
    expect(parsed.githubMissing).toHaveLength(4);
    expect(parsed.REPO_BRANCH_PROTECTION).toBe(false);
  });

  it("is configured only when all four variables are set, and names the missing ones", () => {
    const all = {
      ...base,
      GITHUB_APP_ID: "123",
      GITHUB_APP_INSTALLATION_ID: "456",
      GITHUB_APP_PRIVATE_KEY_BASE64: KEY_B64,
      GITHUB_ORG: "forge-org",
      REPO_BRANCH_PROTECTION: "true",
    };
    const ok = envSchema.parse(all);
    expect(ok.githubConfigured).toBe(true);
    expect(ok.REPO_BRANCH_PROTECTION).toBe(true);
    const partial = envSchema.parse({ ...all, GITHUB_ORG: "" });
    expect(partial.githubConfigured).toBe(false);
    expect(partial.githubMissing).toEqual(["GITHUB_ORG"]);
  });

  it("rejects malformed values", () => {
    expect(envSchema.safeParse({ ...base, GITHUB_APP_ID: "abc" }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, GITHUB_ORG: "-bad-" }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, REPO_BRANCH_PROTECTION: "yes" }).success).toBe(false);
  });
});

// --- naming -------------------------------------------------------------------

describe("repo naming", () => {
  it("slugifies and builds fc-<slug>-<6 hex>", () => {
    expect(slugify("  Ünï Çodé -- App!! ")).toBe("uni-code-app");
    expect(slugify("!!!")).toBe("");
    expect(buildRepoName("My Cool App")).toMatch(/^fc-my-cool-app-[0-9a-f]{6}$/);
    expect(slugify("a".repeat(80)).length).toBeLessThanOrEqual(40);
  });
});

// --- JWT ----------------------------------------------------------------------

describe("App JWT", () => {
  it("is RS256 with backdated iat, short lifetime, iss = app id and a verifiable signature", () => {
    const nowMs = 1_700_000_000_000;
    const jwt = signAppJwt("12345", privateKey, nowMs);
    const [h, c, s] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(c, "base64url").toString()) as { iat: number; exp: number; iss: string };
    expect(claims.iss).toBe("12345");
    expect(claims.iat).toBe(nowMs / 1000 - 60);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(claims.exp).toBeGreaterThan(nowMs / 1000);
    const verifier = createVerify("RSA-SHA256").update(`${h}.${c}`);
    expect(verifier.verify(createPublicKey(publicKey), Buffer.from(s, "base64url"))).toBe(true);
  });
});

// --- provider -----------------------------------------------------------------

interface Call {
  method: string;
  url: string;
  auth: string;
  body: unknown;
}

function fakeFetch(
  respond: (call: Call) => { status: number; body?: unknown; headers?: Record<string, string> }
): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const call: Call = {
      method: String(init.method),
      url,
      auth: headers["Authorization"] ?? "",
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const r = respond(call);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const REPO_BODY = {
  id: 99,
  name: "fc-x-abcdef",
  full_name: "forge-org/fc-x-abcdef",
  html_url: "https://github.com/forge-org/fc-x-abcdef",
  default_branch: "main",
};

function githubRouter(nowMs: number): (call: Call) => { status: number; body?: unknown } {
  return (call) => {
    if (call.url.endsWith("/access_tokens")) {
      return { status: 201, body: { token: "inst-token", expires_at: new Date(nowMs + 3_600_000).toISOString() } };
    }
    if (call.method === "GET") return { status: call.url.endsWith("/ghost") ? 404 : 200, body: { login: "x" } };
    if (call.method === "POST") return { status: 201, body: REPO_BODY };
    if (call.url.includes("/collaborators/")) return { status: 201, body: { id: 7 } };
    return { status: 200, body: {} };
  };
}

describe("GithubProvider", () => {
  let nowMs = 1_700_000_000_000;
  const make = (respond: (call: Call) => { status: number; body?: unknown; headers?: Record<string, string> }) => {
    const { fetchFn, calls } = fakeFetch(respond);
    const provider = new GithubProvider({
      appId: "123",
      installationId: "456",
      privateKeyBase64: KEY_B64,
      org: "forge-org",
      fetchFn,
      now: () => nowMs,
    });
    return { provider, calls };
  };

  beforeEach(() => {
    nowMs = 1_700_000_000_000;
  });

  it("reuses the installation token until about 60 s before expiry, then refreshes", async () => {
    const { provider, calls } = make(githubRouter(nowMs));
    await provider.userExists("octocat");
    await provider.userExists("octocat");
    expect(calls.filter((c) => c.url.endsWith("/access_tokens"))).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.github.com/app/installations/456/access_tokens");
    expect(calls[0]?.auth.startsWith("Bearer ey")).toBe(true);
    nowMs += 3_600_000 - 30_000;
    await provider.userExists("octocat");
    expect(calls.filter((c) => c.url.endsWith("/access_tokens"))).toHaveLength(2);
    expect(calls.at(-1)?.auth).toBe("Bearer inst-token");
  });

  it("creates a private repo, then invites with push permission", async () => {
    const { provider, calls } = make(githubRouter(nowMs));
    const repo = await provider.createRepo("fc-x-abcdef");
    const collab = await provider.addCollaborator(repo.name, "octocat");
    const create = calls.find((c) => c.url.endsWith("/orgs/forge-org/repos"));
    expect(create?.body).toEqual({ name: "fc-x-abcdef", private: true, auto_init: true, has_wiki: false, has_projects: false });
    const invite = calls.find((c) => c.url.endsWith("/repos/forge-org/fc-x-abcdef/collaborators/octocat"));
    expect(invite?.method).toBe("PUT");
    expect(invite?.body).toEqual({ permission: "push" });
    expect(collab).toEqual({ status: "invited", collaboratorId: 7 });
    expect(repo.fullName).toBe("forge-org/fc-x-abcdef");
  });

  it("treats 204 as already a collaborator and 404 as an unknown user", async () => {
    const { provider } = make((call) => {
      if (call.url.endsWith("/access_tokens")) return { status: 201, body: { token: "t", expires_at: new Date(nowMs + 3_600_000).toISOString() } };
      return { status: call.method === "PUT" ? 204 : 404 };
    });
    expect(await provider.addCollaborator("r", "octocat")).toEqual({ status: "active", collaboratorId: null });
    expect(await provider.userExists("ghost")).toBe(false);
  });

  it("maps failures to safe errors without leaking provider bodies", async () => {
    const secretBody = { message: "leak-me-token-abc" };
    const { provider } = make((call) => {
      if (call.url.endsWith("/access_tokens")) return { status: 201, body: { token: "t", expires_at: new Date(nowMs + 3_600_000).toISOString() } };
      if (call.method === "PUT") return { status: 422, body: secretBody };
      if (call.method === "POST") return { status: 403, body: secretBody, headers: { "x-ratelimit-remaining": "0" } };
      return { status: 500, body: secretBody };
    });
    const invite = await provider.addCollaborator("r", "octocat").catch((e: unknown) => e);
    expect(invite).toBeInstanceOf(AppError);
    expect((invite as InstanceType<typeof AppError>).status).toBe(422);
    const limited = await provider.createRepo("n").catch((e: unknown) => e);
    expect((limited as InstanceType<typeof AppError>).status).toBe(503);
    const failed = await provider.userExists("octocat").catch((e: unknown) => e);
    expect((failed as InstanceType<typeof AppError>).status).toBe(502);
    for (const e of [invite, limited, failed]) expect((e as Error).message).not.toContain("leak-me");
  });

  it("removes the collaborator and cancels only the matching pending invitation", async () => {
    const { provider, calls } = make((call) => {
      if (call.url.endsWith("/access_tokens")) return { status: 201, body: { token: "t", expires_at: new Date(nowMs + 3_600_000).toISOString() } };
      if (call.method === "GET") {
        return { status: 200, body: [{ id: 5, invitee: { login: "OctoCat" } }, { id: 6, invitee: { login: "other" } }] };
      }
      return { status: 204 };
    });
    await provider.removeCollaborator("fc-x-abcdef", "octocat");
    const base = "https://api.github.com/repos/forge-org/fc-x-abcdef";
    const deletes = calls.filter((c) => c.method === "DELETE").map((c) => c.url);
    expect(deletes).toEqual([`${base}/collaborators/octocat`, `${base}/invitations/5`]);
  });

  it("treats 404 on removal and on invitation deletion as success, and maps other failures", async () => {
    const ok = make((call) => {
      if (call.url.endsWith("/access_tokens")) return { status: 201, body: { token: "t", expires_at: new Date(nowMs + 3_600_000).toISOString() } };
      if (call.method === "GET") return { status: 200, body: [{ id: 5, invitee: { login: "octocat" } }] };
      return { status: 404 };
    });
    await expect(ok.provider.removeCollaborator("r", "octocat")).resolves.toBeUndefined();
    const bad = make((call) => {
      if (call.url.endsWith("/access_tokens")) return { status: 201, body: { token: "t", expires_at: new Date(nowMs + 3_600_000).toISOString() } };
      return { status: 500, body: { message: "leak-me" } };
    });
    const err = await bad.provider.removeCollaborator("r", "octocat").catch((e: unknown) => e);
    expect((err as InstanceType<typeof AppError>).status).toBe(502);
    expect((err as Error).message).not.toContain("leak-me");
  });

  it("sends the branch protection request to the default branch", async () => {
    const { provider, calls } = make(githubRouter(nowMs));
    await provider.protectDefaultBranch("fc-x-abcdef", "main");
    const put = calls.find((c) => c.url.endsWith("/repos/forge-org/fc-x-abcdef/branches/main/protection"));
    expect(put?.method).toBe("PUT");
  });
});

// --- service ------------------------------------------------------------------

function fakeProvider(overrides: Partial<RepoProvider> = {}): RepoProvider & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    userExists: jest.fn(async (login: string) => {
      log.push(`exists:${login}`);
      return true;
    }),
    createRepo: jest.fn(async (name: string) => {
      log.push(`create:${name}`);
      return { id: 99, name, fullName: `forge-org/${name}`, htmlUrl: `https://github.com/forge-org/${name}`, defaultBranch: "main" };
    }),
    addCollaborator: jest.fn(async (repo: string, login: string) => {
      log.push(`invite:${repo}:${login}`);
      return { status: "invited" as const, collaboratorId: 7 };
    }),
    removeCollaborator: jest.fn(async (repo: string, login: string) => {
      log.push(`remove:${repo}:${login}`);
    }),
    protectDefaultBranch: jest.fn(async () => {
      log.push("protect");
    }),
    ...overrides,
  };
}

function repoRow(status: string): Record<string, unknown> {
  return {
    id: "rid-1",
    user_id: USER.id,
    founder_wallet: FOUNDER,
    provider: "github",
    repo_id: "99",
    repo_name: "fc-my-cool-app-abcdef",
    full_name: "forge-org/fc-my-cool-app-abcdef",
    html_url: "https://github.com/forge-org/fc-my-cool-app-abcdef",
    founder_login: "octocat",
    collaborator_id: null,
    collaborator_status: status,
    project_id: null,
    created_at: new Date(1_700_000_000_000),
  };
}

function mockDb(existing: Record<string, unknown> | null): string[] {
  const sql: string[] = [];
  mockQuery.mockImplementation(async (text: unknown) => {
    const q = String(text);
    sql.push(q);
    if (q.includes("FROM app.project_repos r")) return { rows: existing ? [existing] : [], rowCount: existing ? 1 : 0 };
    if (q.includes("INSERT INTO app.project_repos")) return { rows: [{ id: "rid-1" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  return sql;
}

describe("provisionRepo", () => {
  it("answers 503 when provisioning is not configured", async () => {
    const err = await provisionRepo(USER, BODY, null, { provider: null, branchProtection: false }).catch((e: unknown) => e);
    expect((err as InstanceType<typeof AppError>).status).toBe(503);
    expect((err as Error).message).toBe("Repository provisioning is not configured");
  });

  it("rejects an unknown GitHub user with 422 and creates nothing", async () => {
    mockDb(null);
    const provider = fakeProvider({ userExists: jest.fn(async () => false) });
    const err = await provisionRepo(USER, BODY, null, { provider, branchProtection: false }).catch((e: unknown) => e);
    expect((err as InstanceType<typeof AppError>).status).toBe(422);
    expect(provider.createRepo).not.toHaveBeenCalled();
  });

  it("creates, stores, invites, audits, and skips branch protection when the flag is off", async () => {
    const sql = mockDb(null);
    const provider = fakeProvider();
    const { repo, created } = await provisionRepo(USER, BODY, "1.2.3.4", { provider, branchProtection: false });
    expect(created).toBe(true);
    expect(repo.status).toBe("invited");
    expect(provider.log[0]).toBe("exists:octocat");
    expect(provider.log[1]).toMatch(/^create:fc-my-cool-app-[0-9a-f]{6}$/);
    expect(provider.log[2]).toMatch(/^invite:fc-my-cool-app-[0-9a-f]{6}:octocat$/);
    expect(provider.protectDefaultBranch).not.toHaveBeenCalled();
    const order = ["pg_advisory_xact_lock", "INSERT INTO app.project_repos", "UPDATE app.project_repos", "INSERT INTO app.audit_log", "COMMIT"];
    const indexes = order.map((needle) => sql.findIndex((q) => q.includes(needle)));
    expect(indexes.every((i) => i >= 0)).toBe(true);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
    const audit = mockQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO app.audit_log"));
    expect(audit?.[1]).toEqual([USER.id, FOUNDER, null, "invited", "1.2.3.4"]);
  });

  it("applies branch protection exactly once when the flag is on", async () => {
    mockDb(null);
    const provider = fakeProvider();
    await provisionRepo(USER, BODY, null, { provider, branchProtection: true });
    expect(provider.protectDefaultBranch).toHaveBeenCalledTimes(1);
  });

  it("keeps the repo as failed when the invite fails, and the retry only re-invites", async () => {
    const sql = mockDb(null);
    const provider = fakeProvider({
      addCollaborator: jest.fn(async () => {
        throw new AppError(502, "Repository provider request failed", true);
      }),
    });
    const err = await provisionRepo(USER, BODY, null, { provider, branchProtection: true }).catch((e: unknown) => e);
    expect((err as InstanceType<typeof AppError>).status).toBe(502);
    expect(provider.createRepo).toHaveBeenCalledTimes(1);
    expect(provider.protectDefaultBranch).not.toHaveBeenCalled();
    expect(sql.some((q) => q.includes("INSERT INTO app.project_repos"))).toBe(true);
    expect(sql).toContain("COMMIT");
    const audit = mockQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO app.audit_log"));
    expect((audit?.[1] as unknown[])[3]).toBe("failed");

    mockQuery.mockReset();
    const retryDb = mockDb(repoRow("failed"));
    const retryProvider = fakeProvider();
    const retry = await provisionRepo(USER, BODY, null, { provider: retryProvider, branchProtection: false });
    expect(retry.created).toBe(false);
    expect(retry.repo.status).toBe("invited");
    expect(retryProvider.createRepo).not.toHaveBeenCalled();
    expect(retryProvider.userExists).not.toHaveBeenCalled();
    expect(retryProvider.addCollaborator).toHaveBeenCalledWith("fc-my-cool-app-abcdef", "octocat");
    expect(retryDb.some((q) => q.includes("INSERT INTO app.project_repos"))).toBe(false);
  });

  it("returns an existing healthy repo unchanged, and 409 for a different GitHub user", async () => {
    mockDb(repoRow("invited"));
    const provider = fakeProvider();
    const same = await provisionRepo(USER, BODY, null, { provider, branchProtection: false });
    expect(same.created).toBe(false);
    expect(provider.createRepo).not.toHaveBeenCalled();
    const err = await provisionRepo(USER, { ...BODY, githubUsername: "someone-else" }, null, { provider, branchProtection: false }).catch(
      (e: unknown) => e
    );
    expect((err as InstanceType<typeof AppError>).status).toBe(409);
  });
});

describe("revokeRepoAccess", () => {
  const ADMIN_ID = "22222222-2222-2222-2222-222222222222";

  function mockRevokeDb(row: Record<string, unknown> | null): string[] {
    const sql: string[] = [];
    mockQuery.mockImplementation(async (text: unknown) => {
      const q = String(text);
      sql.push(q);
      if (q.includes("FOR UPDATE OF r")) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      if (q.includes("SET collaborator_status = 'revoked'")) return { rows: [{ revoked_at: new Date(1_700_000_100_000) }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    return sql;
  }

  it("removes access, marks revoked and audits with the old status", async () => {
    const sql = mockRevokeDb(repoRow("invited"));
    const provider = fakeProvider();
    const repo = await revokeRepoAccess("rid-1", ADMIN_ID, "9.9.9.9", provider);
    expect(provider.removeCollaborator).toHaveBeenCalledWith("fc-my-cool-app-abcdef", "octocat");
    expect(repo.status).toBe("revoked");
    expect(repo.revokedAt).toEqual(new Date(1_700_000_100_000));
    const audit = mockQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO app.audit_log"));
    expect(String(audit?.[0])).toContain("'repo.revoke'");
    expect(audit?.[1]).toEqual([ADMIN_ID, FOUNDER, "invited", "9.9.9.9"]);
    expect(sql).toContain("COMMIT");
  });

  it("is idempotent: an already revoked repo makes no provider call and no audit row", async () => {
    const sql = mockRevokeDb(repoRow("revoked"));
    const provider = fakeProvider();
    const repo = await revokeRepoAccess("rid-1", ADMIN_ID, null, provider);
    expect(repo.status).toBe("revoked");
    expect(provider.removeCollaborator).not.toHaveBeenCalled();
    expect(sql.some((q) => q.includes("INSERT INTO app.audit_log"))).toBe(false);
  });

  it("leaves row and audit untouched when the provider fails", async () => {
    const sql = mockRevokeDb(repoRow("active"));
    const provider = fakeProvider({
      removeCollaborator: jest.fn(async () => {
        throw new AppError(502, "Repository provider request failed", true);
      }),
    });
    const err = await revokeRepoAccess("rid-1", ADMIN_ID, null, provider).catch((e: unknown) => e);
    expect((err as InstanceType<typeof AppError>).status).toBe(502);
    expect(sql).toContain("ROLLBACK");
    expect(sql.some((q) => q.includes("SET collaborator_status = 'revoked'") || q.includes("INSERT INTO app.audit_log"))).toBe(false);
  });

  it("answers 404 for an unknown repo and 503 when the provider is not configured", async () => {
    mockRevokeDb(null);
    const missing = await revokeRepoAccess("rid-1", ADMIN_ID, null, fakeProvider()).catch((e: unknown) => e);
    expect((missing as InstanceType<typeof AppError>).status).toBe(404);
    mockRevokeDb(repoRow("active"));
    const unconfigured = await revokeRepoAccess("rid-1", ADMIN_ID, null, null).catch((e: unknown) => e);
    expect((unconfigured as InstanceType<typeof AppError>).status).toBe(503);
  });
});

describe("POST /api/v1/admin/repos/:id/revoke guards", () => {
  const URL = "/api/v1/admin/repos/33333333-3333-3333-3333-333333333333/revoke";

  it("401 anonymous, 403 bad origin, 403 staff and founder", async () => {
    mockSession(mockQuery, "admin", FOUNDER);
    expect((await request(app).post(URL).set("Origin", ALLOWED_ORIGIN).send({})).status).toBe(401);
    expect((await request(app).post(URL).set("Origin", "https://evil.example").set("Cookie", SESSION_COOKIE_HEADER).send({})).status).toBe(403);
    for (const role of ["staff", "founder"]) {
      mockSession(mockQuery, role, FOUNDER);
      expect((await request(app).post(URL).set("Origin", ALLOWED_ORIGIN).set("Cookie", SESSION_COOKIE_HEADER).send({})).status).toBe(403);
    }
  });

  it("rejects a malformed id and unknown body fields for an admin", async () => {
    mockSession(mockQuery, "admin", FOUNDER);
    const send = (url: string, body: object) =>
      request(app).post(url).set("Origin", ALLOWED_ORIGIN).set("Cookie", SESSION_COOKIE_HEADER).send(body);
    expect((await send("/api/v1/admin/repos/not-a-uuid/revoke", {})).status).toBe(400);
    expect((await send(URL, { extra: 1 })).status).toBe(400);
  });
});

// --- routes -------------------------------------------------------------------

describe("repo routes", () => {
  it("guards POST: 401 anonymous, 403 bad origin, 403 non-founder, 503 when unconfigured", async () => {
    mockSession(mockQuery, "founder", FOUNDER);
    const anon = await request(app).post("/api/v1/founders/me/repo").set("Origin", ALLOWED_ORIGIN).send(BODY);
    expect(anon.status).toBe(401);
    const badOrigin = await request(app)
      .post("/api/v1/founders/me/repo")
      .set("Origin", "https://evil.example")
      .set("Cookie", SESSION_COOKIE_HEADER)
      .send(BODY);
    expect(badOrigin.status).toBe(403);
    mockSession(mockQuery, "investor", FOUNDER);
    const investor = await request(app)
      .post("/api/v1/founders/me/repo")
      .set("Origin", ALLOWED_ORIGIN)
      .set("Cookie", SESSION_COOKIE_HEADER)
      .send(BODY);
    expect(investor.status).toBe(403);
    mockSession(mockQuery, "founder", FOUNDER);
    const unconfigured = await request(app)
      .post("/api/v1/founders/me/repo")
      .set("Origin", ALLOWED_ORIGIN)
      .set("Cookie", SESSION_COOKIE_HEADER)
      .send(BODY);
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.body.error).toBe("Repository provisioning is not configured");
  });

  it("validates the body strictly", async () => {
    mockSession(mockQuery, "founder", FOUNDER);
    const send = (body: object) =>
      request(app).post("/api/v1/founders/me/repo").set("Origin", ALLOWED_ORIGIN).set("Cookie", SESSION_COOKIE_HEADER).send(body);
    expect((await send({ githubUsername: "bad name", projectName: "Valid Name" })).status).toBe(400);
    expect((await send({ githubUsername: "octocat", projectName: "!!!" })).status).toBe(400);
    expect((await send({ ...BODY, extra: 1 })).status).toBe(400);
  });

  it("guards the reads: GET own repo needs a founder, admin list needs staff or admin", async () => {
    expect((await request(app).get("/api/v1/founders/me/repo")).status).toBe(401);
    mockSession(mockQuery, "investor", FOUNDER);
    expect((await request(app).get("/api/v1/founders/me/repo").set("Cookie", SESSION_COOKIE_HEADER)).status).toBe(403);
    expect((await request(app).get("/api/v1/admin/repos").set("Cookie", SESSION_COOKIE_HEADER)).status).toBe(403);
    mockSession(mockQuery, "founder", FOUNDER, { rows: [], rowCount: 0 });
    const none = await request(app).get("/api/v1/founders/me/repo").set("Cookie", SESSION_COOKIE_HEADER);
    expect(none.status).toBe(404);
    expect(none.headers["cache-control"]).toBe("no-store");
  });

  it("GET /founders/me/repos returns the own-repo DTO without internal ids", async () => {
    const created = new Date("2026-01-02T03:04:05.000Z");
    const row = (projectName: string | null) => ({
      id: "22222222-2222-2222-2222-222222222222",
      user_id: USER.id,
      founder_wallet: FOUNDER,
      provider: "github",
      repo_id: "42",
      repo_name: "my-app",
      full_name: "org/my-app",
      html_url: "https://github.com/org/my-app",
      founder_login: "octocat",
      collaborator_id: "7",
      collaborator_status: "active",
      project_id: projectName === null ? null : "421614:0x" + "ab".repeat(20),
      created_at: created,
      revoked_at: null,
      project_name: projectName,
      reserved: false,
    });
    mockSession(mockQuery, "founder", FOUNDER, { rows: [row("Acme"), row(null)], rowCount: 2 });
    const res = await request(app).get("/api/v1/founders/me/repos").set("Cookie", SESSION_COOKIE_HEADER);
    expect(res.status).toBe(200);
    const [first, second] = res.body.data.items;
    expect(Object.keys(first).sort()).toEqual(
      ["createdAt", "founderLogin", "fullName", "htmlUrl", "id", "projectId", "projectName", "reserved", "status"].sort()
    );
    expect(first.userId).toBeUndefined();
    expect(first.collaboratorId).toBeUndefined();
    expect(first.founderWallet).toBeUndefined();
    expect(first.createdAt).toBe(created.toISOString());
    expect(first.projectName).toBe("Acme");
    expect(second.projectName).toBeNull();
  });
});
