import { createSign } from "node:crypto";
import { AppError } from "../errors.js";
import { logger } from "../logger.js";
import type { CollaboratorResult, CreatedRepo, RepoProvider } from "./repoProvider.js";

const API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "forgecapita-api";
const REQUEST_TIMEOUT_MS = 10_000;
const JWT_BACKDATE_SEC = 60;
const JWT_LIFETIME_SEC = 300;
const TOKEN_REFRESH_MARGIN_MS = 60_000;

export interface GithubProviderOptions {
  appId: string;
  installationId: string;
  /** Base64 of the App private key PEM; decoded in memory only. */
  privateKeyBase64: string;
  org: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}

interface GithubResponse {
  status: number;
  rateLimited: boolean;
  body: unknown;
}

type Auth = "app" | "installation";

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** RS256 GitHub App JWT: iat backdated 60 s for clock skew, 5 minute lifetime, iss = app id. */
export function signAppJwt(appId: string, privateKeyPem: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - JWT_BACKDATE_SEC;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({ iat, exp: iat + JWT_BACKDATE_SEC + JWT_LIFETIME_SEC, iss: appId }));
  const signingInput = `${header}.${claims}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKeyPem);
  return `${signingInput}.${base64Url(signature)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function providerError(): AppError {
  return new AppError(502, "Repository provider request failed", true);
}

/** Maps a failed GitHub response to a safe error; neither body nor headers reach the client. */
function mapFailure(res: GithubResponse, unprocessable: AppError | null): AppError {
  if (res.rateLimited) return new AppError(503, "Repository provider is rate limited, try again later", true);
  if (res.status === 422 && unprocessable) return unprocessable;
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    return new AppError(502, "Repository provider rejected the request", true);
  }
  return providerError();
}

export class GithubProvider implements RepoProvider {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private cachedToken: { token: string; expiresAtMs: number } | null = null;
  private pendingToken: Promise<string> | null = null;

  constructor(private readonly options: GithubProviderOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async userExists(login: string): Promise<boolean> {
    const res = await this.request("GET", `/users/${encodeURIComponent(login)}`, "installation");
    if (res.status === 200) return true;
    if (res.status === 404 && !res.rateLimited) return false;
    throw mapFailure(res, null);
  }

  async createRepo(name: string): Promise<CreatedRepo> {
    const res = await this.request("POST", `/orgs/${encodeURIComponent(this.options.org)}/repos`, "installation", {
      name,
      private: true,
      auto_init: true,
      has_wiki: false,
      has_projects: false,
    });
    if (res.status !== 201) throw mapFailure(res, null);
    const b = res.body;
    if (
      !isRecord(b) ||
      typeof b["id"] !== "number" ||
      typeof b["name"] !== "string" ||
      typeof b["full_name"] !== "string" ||
      typeof b["html_url"] !== "string" ||
      typeof b["default_branch"] !== "string"
    ) {
      throw providerError();
    }
    return { id: b["id"], name: b["name"], fullName: b["full_name"], htmlUrl: b["html_url"], defaultBranch: b["default_branch"] };
  }

  async addCollaborator(repoName: string, login: string): Promise<CollaboratorResult> {
    const path = `/repos/${encodeURIComponent(this.options.org)}/${encodeURIComponent(repoName)}/collaborators/${encodeURIComponent(login)}`;
    const res = await this.request("PUT", path, "installation", { permission: "push" });
    if (res.status === 204) return { status: "active", collaboratorId: null };
    if (res.status === 201) {
      const id = isRecord(res.body) ? res.body["id"] : undefined;
      return { status: "invited", collaboratorId: typeof id === "number" ? id : null };
    }
    throw mapFailure(res, new AppError(422, "GitHub user cannot be invited", true));
  }

  /** DELETE the collaborator (204 removed, 404 gone) and cancel any pending invitation for the login. */
  async removeCollaborator(repoName: string, login: string): Promise<void> {
    const repoPath = `/repos/${encodeURIComponent(this.options.org)}/${encodeURIComponent(repoName)}`;
    const removed = await this.request("DELETE", `${repoPath}/collaborators/${encodeURIComponent(login)}`, "installation");
    if (removed.status !== 204 && !(removed.status === 404 && !removed.rateLimited)) throw mapFailure(removed, null);

    const listed = await this.request("GET", `${repoPath}/invitations?per_page=100`, "installation");
    if (listed.status === 404 && !listed.rateLimited) return;
    if (listed.status !== 200 || !Array.isArray(listed.body)) throw mapFailure(listed, null);
    for (const invitation of listed.body as unknown[]) {
      if (!isRecord(invitation) || typeof invitation["id"] !== "number") continue;
      const invitee = invitation["invitee"];
      if (!isRecord(invitee) || typeof invitee["login"] !== "string") continue;
      if (invitee["login"].toLowerCase() !== login.toLowerCase()) continue;
      const cancelled = await this.request("DELETE", `${repoPath}/invitations/${invitation["id"]}`, "installation");
      if (cancelled.status !== 204 && !(cancelled.status === 404 && !cancelled.rateLimited)) throw mapFailure(cancelled, null);
    }
  }

  async protectDefaultBranch(repoName: string, branch: string): Promise<void> {
    const path = `/repos/${encodeURIComponent(this.options.org)}/${encodeURIComponent(repoName)}/branches/${encodeURIComponent(branch)}/protection`;
    const res = await this.request("PUT", path, "installation", {
      required_status_checks: null,
      enforce_admins: false,
      required_pull_request_reviews: null,
      restrictions: null,
      allow_force_pushes: false,
      allow_deletions: false,
    });
    if (res.status !== 200) throw mapFailure(res, null);
  }

  private async installationToken(): Promise<string> {
    const cached = this.cachedToken;
    if (cached && cached.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > this.now()) return cached.token;
    this.pendingToken ??= this.fetchInstallationToken().finally(() => {
      this.pendingToken = null;
    });
    return this.pendingToken;
  }

  private async fetchInstallationToken(): Promise<string> {
    const res = await this.request("POST", `/app/installations/${this.options.installationId}/access_tokens`, "app");
    const b = res.body;
    if (res.status !== 201 || !isRecord(b) || typeof b["token"] !== "string" || typeof b["expires_at"] !== "string") {
      throw mapFailure(res, null);
    }
    const expiresAtMs = Date.parse(b["expires_at"]);
    if (Number.isNaN(expiresAtMs)) throw providerError();
    this.cachedToken = { token: b["token"], expiresAtMs };
    return b["token"];
  }

  private appJwt(): string {
    try {
      const pem = Buffer.from(this.options.privateKeyBase64, "base64").toString("utf8");
      return signAppJwt(this.options.appId, pem, this.now());
    } catch {
      // The node:crypto error is dropped on purpose: keep key material out of logs.
      logger.error("github app private key could not be used to sign");
      throw providerError();
    }
  }

  private async request(method: string, path: string, auth: Auth, body?: unknown): Promise<GithubResponse> {
    const credential = auth === "app" ? this.appJwt() : await this.installationToken();
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${credential}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": USER_AGENT,
    };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await this.fetchFn(`${API_BASE}${path}`, init);
    } catch {
      logger.warn({ method }, "github request failed before a response");
      throw new AppError(502, "Repository provider is unreachable", true);
    }
    const rateLimited =
      response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (response.status >= 400) logger.warn({ method, status: response.status }, "github request rejected");
    return { status: response.status, rateLimited, body: parsed };
  }
}
