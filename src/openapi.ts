/** Hand-written OpenAPI 3.0.3 document for the existing routes. Amounts are decimal wei strings; dates are ISO strings. */

const errorResponse = (description: string): object => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
});

const okEnvelope = (data: object): object => ({
  type: "object",
  required: ["success"],
  properties: {
    success: { type: "boolean", enum: [true] },
    data,
    message: { type: "string" },
    requestId: { type: "string" },
  },
});

const query = (name: string, schema: object): object => ({
  name,
  in: "query",
  required: false,
  schema,
});

const ref = (name: string): object => ({ $ref: `#/components/schemas/${name}` });
const limitParam = { $ref: "#/components/parameters/Limit" };
const offsetParam = { $ref: "#/components/parameters/Offset" };

const pathParam = (name: string, schema: object, description?: string): object => ({
  name,
  in: "path",
  required: true,
  ...(description === undefined ? {} : { description }),
  schema,
});

const projectIdParam = pathParam("projectId", { type: "string", pattern: "^[0-9]{1,10}:0x[a-fA-F0-9]{40}$" }, "Composite id <chainId>:<escrow address>");
const idParam = pathParam("id", ref("Uuid"));
const addressParam = pathParam("address", ref("Address"));

const str = { type: "string" };
const nullableStr = { type: "string", nullable: true };
const iso = { type: "string", format: "date-time" };
const nullableIso = { type: "string", format: "date-time", nullable: true };
const note = (max: number): object => ({ type: "string", minLength: 1, maxLength: max });

/** Free-form object whose keys are listed in the description. */
const generic = (description: string): object => ({ type: "object", additionalProperties: true, description });

const paged = (items: object): object => ({
  type: "object",
  required: ["items", "total", "limit", "offset"],
  properties: {
    items: { type: "array", items },
    total: { type: "integer" },
    limit: { type: "integer" },
    offset: { type: "integer" },
  },
});

const jsonBody = (schema: object, required = true): object => ({
  required,
  content: { "application/json": { schema } },
});

const ERROR_TEXT: Record<number, string> = {
  400: "Validation failed",
  401: "Authentication required",
  403: "Forbidden: wrong role or origin not allowed",
  404: "Not found",
  409: "Conflict with the current state",
  422: "Unprocessable request",
  429: "Too many requests",
  502: "Upstream provider failed",
  503: "Service unavailable",
};

interface Success {
  code: string;
  description: string;
  data?: object;
  headers?: object;
}

interface OpSpec {
  summary: string;
  session?: boolean;
  parameters?: object[];
  body?: object;
  success: Success[];
  errors?: number[];
  notes?: Record<number, string>;
  cache?: string;
}

/** One operation: success responses plus the standard error responses (429 always applies). */
function op(spec: OpSpec): object {
  const cacheHeader = spec.cache === undefined ? {} : { "Cache-Control": { schema: str, description: spec.cache } };
  const responses: Record<string, object> = {};
  for (const s of spec.success) {
    const headers = { ...cacheHeader, ...(s.headers ?? {}) };
    responses[s.code] = {
      description: s.description,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(s.data === undefined ? {} : { content: { "application/json": { schema: okEnvelope(s.data) } } }),
    };
  }
  for (const code of [...(spec.errors ?? []), 429]) {
    responses[String(code)] = errorResponse(spec.notes?.[code] ?? ERROR_TEXT[code] ?? "Error");
  }
  return {
    summary: spec.summary,
    ...(spec.session === true ? { security: [{ cookieSession: [] }] } : {}),
    ...(spec.parameters === undefined ? {} : { parameters: spec.parameters }),
    ...(spec.body === undefined ? {} : { requestBody: spec.body }),
    responses,
  };
}

const ok = (description: string, data?: object): Success[] => [
  { code: "200", description, ...(data === undefined ? {} : { data }) },
];

const repoDto = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid", description: "Present on the POST response only" },
    fullName: { type: "string" },
    htmlUrl: { type: "string" },
    founderLogin: { type: "string" },
    status: { type: "string", enum: ["invited", "active", "failed", "revoked"] },
    createdAt: { type: "string", format: "date-time" },
  },
};

const repoOk = (description: string): object => ({
  description,
  content: {
    "application/json": { schema: okEnvelope({ type: "object", properties: { repo: repoDto } }) },
  },
});

const statusOk = (description: string): object => ({
  description,
  content: {
    "application/json": {
      schema: okEnvelope({ type: "object", properties: { status: { type: "string" } } }),
    },
  },
});

const itemsOf = (description: string): object => ({
  type: "object",
  properties: { items: { type: "array", items: generic(description) } },
});

const pagedGeneric = (description: string): object => paged(generic(description));

const caseData = (description: string, extra: object = {}): object => ({
  type: "object",
  properties: { case: ref("TakeoverCase"), ...extra },
  description,
});

const emptyBody = jsonBody({ type: "object", additionalProperties: false, maxProperties: 0 }, false);

const COMPLIANCE_STATES = ["OK", "WARNED", "ESCALATED", "RESOLVED", "SHUTDOWN"];
const chainQuery = query("chainId", { type: "integer", enum: [421614, 97] });
const projectIdQuery = query("projectId", { type: "string", pattern: "^[0-9]+:0x[0-9a-f]{40}$" });

const SESSION = true;

export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "forgeCapita API",
    version: "1.0.0",
    description:
      "Session routes use the fc_session cookie. State-changing cookie routes also require a same-origin Origin header (requireSameOrigin), else 403. Amounts are decimal wei strings; dates are ISO strings.",
  },
  paths: {
    "/api/v1/projects": {
      get: {
        summary: "List indexed projects",
        parameters: [
          query("limit", { type: "integer", minimum: 1, maximum: 100, default: 20 }),
          query("offset", { type: "integer", minimum: 0, maximum: 10000, default: 0 }),
          query("chainId", { type: "integer", enum: [421614, 97] }),
          query("state", {
            type: "string",
            enum: ["FUNDING", "ACTIVE", "COMPLETED", "FAILED", "CANCELLED", "SHUTDOWN"],
          }),
          query("developer", { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }),
          query("q", { type: "string", minLength: 1, maxLength: 64 }),
          query("category", { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,31}$" }),
          query("hasProfile", { type: "string", enum: ["true", "false"] }),
          query("sort", {
            type: "string",
            enum: ["created_at", "total_raised", "funding_goal"],
            default: "created_at",
          }),
          query("order", { type: "string", enum: ["asc", "desc"], default: "desc" }),
        ],
        responses: {
          "200": {
            description: "Paginated projects",
            content: {
              "application/json": {
                schema: okEnvelope({
                  type: "object",
                  properties: {
                    items: { type: "array", items: { $ref: "#/components/schemas/Project" } },
                    total: { type: "integer" },
                    limit: { type: "integer" },
                    offset: { type: "integer" },
                  },
                }),
              },
            },
          },
          "400": errorResponse("Validation failed"),
          "429": errorResponse("Too many requests"),
        },
      },
    },
    "/api/v1/projects/{projectId}": {
      get: {
        summary: "Get one project",
        parameters: [projectIdParam],
        responses: {
          "200": {
            description: "The project",
            content: {
              "application/json": {
                schema: okEnvelope({ $ref: "#/components/schemas/Project" }),
              },
            },
          },
          "400": errorResponse("Invalid project id"),
          "404": errorResponse("Project not found"),
          "429": errorResponse("Too many requests"),
        },
      },
    },
    "/api/v1/projects/{projectId}/transparency": {
      get: op({
        summary: "Public revenue-audit status of a project (no-store)",
        parameters: [projectIdParam],
        cache: "no-store",
        success: ok(
          "Audit status",
          generic(
            "projectId, chainId, auditStatus (audited|unaudited), note, complianceState, shadowWallet, lastCheckedAt, windowDays, observedNative and routedNative (wei strings or null), shortfallBps, toleranceBps, frozen (always null)"
          )
        ),
        errors: [400, 404],
      }),
    },
    "/api/v1/projects/profile": {
      post: {
        summary: "Create or update a project profile (session cookie required; developer, staff or admin)",
        security: [{ cookieSession: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/ProfileBody" } },
          },
        },
        responses: {
          "201": {
            description: "Profile saved",
            content: {
              "application/json": {
                schema: okEnvelope({ type: "object", additionalProperties: true }),
              },
            },
          },
          "400": errorResponse("Validation failed"),
          "401": errorResponse("Authentication required"),
          "403": errorResponse("Not the project developer"),
          "404": errorResponse("Project not indexed"),
          "429": errorResponse("Too many requests"),
        },
      },
    },
    "/api/v1/auth/nonce": {
      post: op({
        summary: "Request a sign-in challenge for a wallet address (no-store)",
        cache: "no-store",
        body: jsonBody({
          type: "object",
          required: ["address"],
          additionalProperties: false,
          properties: { address: ref("Address") },
        }),
        success: ok("Challenge", generic("The nonce and the message the wallet must sign")),
        errors: [400],
      }),
    },
    "/api/v1/auth/verify": {
      post: op({
        summary: "Verify the signed challenge and start a session (sets the fc_session cookie; no-store)",
        cache: "no-store",
        body: jsonBody({
          type: "object",
          required: ["address", "signature"],
          additionalProperties: false,
          properties: { address: ref("Address"), signature: ref("Signature") },
        }),
        success: [
          {
            code: "200",
            description: "Signed in",
            data: { type: "object", properties: { user: ref("User") } },
            headers: { "Set-Cookie": { schema: str, description: "fc_session cookie" } },
          },
        ],
        errors: [400, 401],
      }),
    },
    "/api/v1/auth/me": {
      get: op({
        summary: "The signed-in user (no-store)",
        session: SESSION,
        cache: "no-store",
        success: ok("Current user", { type: "object", properties: { user: ref("User") } }),
        errors: [401],
      }),
    },
    "/api/v1/auth/logout": {
      post: op({
        summary: "End the session and clear the cookie (same-origin required; no-store)",
        cache: "no-store",
        success: [{ code: "204", description: "Logged out" }],
        errors: [403],
      }),
    },
    "/api/v1/profile/me": {
      get: op({
        summary: "Own personal profile (PII, no-store)",
        session: SESSION,
        cache: "no-store",
        success: ok("Profile or null", {
          type: "object",
          properties: {
            profile: generic("firstName, lastName, email, phone, addressLine1, addressLine2, city, region, postalCode, country, dateOfBirth"),
            profileComplete: { type: "boolean" },
          },
        }),
        errors: [401],
      }),
      put: op({
        summary: "Save own personal profile (PII; values are never echoed in validation errors; no-store)",
        session: SESSION,
        cache: "no-store",
        body: jsonBody(ref("UserProfileBody")),
        success: ok("Saved", {
          type: "object",
          properties: { profile: generic("The saved profile"), profileComplete: { type: "boolean", enum: [true] } },
        }),
        errors: [400, 401, 403],
      }),
    },
    "/api/v1/admin/users/{address}/profile": {
      get: op({
        summary: "Read a user's personal profile (admin or staff; audited as profile.view; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [addressParam],
        success: ok("Profile", { type: "object", properties: { profile: generic("Personal profile fields") } }),
        errors: [400, 401, 403, 404],
        notes: { 404: "User has no profile" },
      }),
    },
    "/api/v1/applications": {
      post: op({
        summary: "Submit a founder application (investor or founder; no-store)",
        session: SESSION,
        cache: "no-store",
        body: jsonBody(ref("ApplicationBody")),
        success: [
          {
            code: "201",
            description: "Application created",
            data: { type: "object", properties: { application: generic("Owner view: id, walletAddress, about, linkedinUrl, githubUrl, portfolioUrl, otherLinks, legacy project fields (null on new applications), status, reviewNote, reviewedAt, kycVerifiedAt, createdAt, updatedAt (never resumeUrl, kycDocsUrl or kycNote)") } },
          },
        ],
        errors: [400, 401, 403, 409],
        notes: { 409: "An open application already exists" },
      }),
    },
    "/api/v1/applications/mine": {
      get: op({
        summary: "Own latest application, or null (no-store)",
        session: SESSION,
        cache: "no-store",
        success: ok("Application or null", { type: "object", properties: { application: { type: "object", nullable: true, additionalProperties: true } } }),
        errors: [401],
      }),
    },
    "/api/v1/admin/applications": {
      get: op({
        summary: "List applications (admin or staff; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [query("status", { type: "string", enum: ["pending", "approved", "rejected"] }), limitParam, offsetParam],
        success: ok("Page of applications", pagedGeneric("Staff view: owner fields plus userId, reviewedBy, kycVerifiedBy, resumeUrl, kycDocsUrl, kycNote")),
        errors: [400, 401, 403],
      }),
    },
    "/api/v1/admin/applications/{id}": {
      get: op({
        summary: "One application (admin or staff; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [idParam],
        success: ok("The application", { type: "object", properties: { application: generic("Staff view of the application") } }),
        errors: [400, 401, 403, 404],
      }),
    },
    "/api/v1/admin/applications/{id}/approve": {
      post: op({
        summary: "Approve an application after KYC (admin or staff; not the applicant; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [idParam],
        body: jsonBody({
          type: "object",
          required: ["kycVerified"],
          additionalProperties: false,
          properties: { kycVerified: { type: "boolean", enum: [true] }, note: note(500) },
        }),
        success: ok("Updated application", { type: "object", properties: { application: generic("Staff view of the application") } }),
        errors: [400, 401, 403, 404, 409],
        notes: { 409: "Application is not pending" },
      }),
    },
    "/api/v1/admin/applications/{id}/reject": {
      post: op({
        summary: "Reject an application (admin or staff; not the applicant; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [idParam],
        body: jsonBody({
          type: "object",
          required: ["note"],
          additionalProperties: false,
          properties: { note: note(500) },
        }),
        success: ok("Updated application", { type: "object", properties: { application: generic("Staff view of the application") } }),
        errors: [400, 401, 403, 404, 409],
        notes: { 409: "Application is not pending" },
      }),
    },
    "/api/v1/agreement": {
      get: op({
        summary: "Current founder agreement text (public, no-store)",
        cache: "no-store",
        success: ok("Agreement", {
          type: "object",
          properties: { version: str, textHash: str, text: str, messageTemplate: str },
        }),
      }),
    },
    "/api/v1/founders/me": {
      get: op({
        summary: "Own agreement acceptance and shadow wallets (founder; no-store)",
        session: SESSION,
        cache: "no-store",
        success: ok("Founder state", ref("FounderMe")),
        errors: [401, 403],
      }),
    },
    "/api/v1/founders/me/launch-eligibility": {
      get: op({
        summary: "Whether the caller may create a launch draft (no-store)",
        session: SESSION,
        cache: "no-store",
        success: ok("Eligibility", {
          type: "object",
          properties: {
            eligible: { type: "boolean" },
            checks: {
              type: "object",
              properties: {
                applicationApproved: { type: "boolean" },
                agreementAccepted: { type: "boolean" },
                shadowWalletAvailable: { type: "boolean" },
                repoProvisioned: { type: "boolean" },
              },
            },
          },
        }),
        errors: [401],
      }),
    },
    "/api/v1/founders/me/agreement": {
      post: op({
        summary: "Accept the founder agreement with a wallet signature (founder; no-store)",
        session: SESSION,
        cache: "no-store",
        body: jsonBody({
          type: "object",
          required: ["typedName", "issuedAt", "signature"],
          additionalProperties: false,
          properties: {
            typedName: { type: "string", minLength: 2, maxLength: 120 },
            issuedAt: { type: "string", format: "date-time", maxLength: 40 },
            signature: ref("Signature"),
          },
        }),
        success: [
          {
            code: "201",
            description: "Accepted",
            data: { type: "object", properties: { version: str, textHash: str, acceptedAt: iso } },
          },
        ],
        errors: [400, 401, 403, 409],
        notes: { 409: "Agreement already accepted" },
      }),
    },
    "/api/v1/founders/me/shadow-wallet": {
      post: op({
        summary: "Request approval of a shadow wallet (founder; no-store)",
        session: SESSION,
        cache: "no-store",
        body: jsonBody({
          type: "object",
          required: ["address"],
          additionalProperties: false,
          properties: { address: ref("Address") },
        }),
        success: [
          {
            code: "201",
            description: "Request created",
            data: {
              type: "object",
              properties: {
                shadowWallet: generic("id, address, status (pending|approved|rejected), reviewNote"),
              },
            },
          },
        ],
        errors: [400, 401, 403, 409],
        notes: { 409: "An open request exists or the address is approved for another founder" },
      }),
    },
    "/api/v1/founders/me/repo": {
      post: {
        summary: "Provision a private GitHub repo and invite the founder with push access (session cookie, founder)",
        security: [{ cookieSession: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["githubUsername", "projectName"],
                additionalProperties: false,
                properties: {
                  githubUsername: { type: "string", pattern: "^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$" },
                  projectName: { type: "string", minLength: 3, maxLength: 60 },
                },
              },
            },
          },
        },
        responses: {
          "200": repoOk("Existing repo returned, or a failed invite was retried"),
          "201": repoOk("Repo created"),
          "400": errorResponse("Validation failed"),
          "401": errorResponse("Authentication required"),
          "403": errorResponse("Not a founder, or origin not allowed"),
          "409": errorResponse("A repo request exists for a different GitHub user"),
          "422": errorResponse("GitHub user not found or cannot be invited"),
          "429": errorResponse("Too many requests"),
          "502": errorResponse("Repository provider failed"),
          "503": errorResponse("Provisioning not configured or provider rate limited"),
        },
      },
      get: {
        summary: "Own provisioned repo (session cookie, founder)",
        security: [{ cookieSession: [] }],
        responses: {
          "200": repoOk("The repo"),
          "401": errorResponse("Authentication required"),
          "403": errorResponse("Not a founder"),
          "404": errorResponse("No repo yet"),
          "429": errorResponse("Too many requests"),
        },
      },
    },
    "/api/v1/founders/me/repos": {
      get: op({
        summary: "All own repos with linked project name and draft reservation (founder; no-store)",
        session: SESSION,
        cache: "no-store",
        success: ok("Own repos, newest first", {
          type: "object",
          properties: { items: { type: "array", items: ref("OwnRepoItem") } },
        }),
        errors: [401, 403],
      }),
    },
    "/api/v1/admin/shadow-wallets": {
      get: op({
        summary: "List shadow wallet requests (admin or staff; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [query("status", { type: "string", enum: ["pending", "approved", "rejected"] }), limitParam, offsetParam],
        success: ok("Page of shadow wallets", pagedGeneric("id, address, status, reviewNote, userId, founderWallet, reviewedBy, reviewedAt, createdAt")),
        errors: [400, 401, 403],
      }),
    },
    "/api/v1/admin/shadow-wallets/{id}/approve": {
      post: op({
        summary: "Approve a shadow wallet (admin or staff; not the owner; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [idParam],
        body: jsonBody({ type: "object", additionalProperties: false, properties: { note: note(500) } }, false),
        success: ok("Updated wallet", { type: "object", properties: { shadowWallet: generic("Staff view of the shadow wallet") } }),
        errors: [400, 401, 403, 404, 409],
        notes: { 409: "Shadow wallet is not pending, or the address is approved for another founder" },
      }),
    },
    "/api/v1/admin/shadow-wallets/{id}/reject": {
      post: op({
        summary: "Reject a shadow wallet (admin or staff; not the owner; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [idParam],
        body: jsonBody({
          type: "object",
          required: ["note"],
          additionalProperties: false,
          properties: { note: note(500) },
        }),
        success: ok("Updated wallet", { type: "object", properties: { shadowWallet: generic("Staff view of the shadow wallet") } }),
        errors: [400, 401, 403, 404, 409],
        notes: { 409: "Shadow wallet is not pending" },
      }),
    },
    "/api/v1/admin/repos": {
      get: op({
        summary: "List provisioned repos (admin or staff)",
        session: SESSION,
        parameters: [query("userId", ref("Uuid")), limitParam, offsetParam],
        success: ok("Page of repos", paged(ref("StaffRepoItem"))),
        errors: [400, 401, 403],
      }),
    },
    "/api/v1/admin/repos/{id}/revoke": {
      post: op({
        summary: "Revoke a founder's repo access (ADMIN only)",
        session: SESSION,
        parameters: [idParam],
        body: emptyBody,
        success: ok("Revoked repo", {
          type: "object",
          properties: {
            repo: { allOf: [ref("StaffRepoItem"), { type: "object", properties: { id: ref("Uuid") } }] },
          },
        }),
        errors: [400, 401, 403, 404, 502, 503],
        notes: { 502: "Repository provider failed", 503: "Provisioning not configured or provider rate limited" },
      }),
    },
    "/api/v1/launch-drafts/mine": {
      get: op({
        summary: "Own launch drafts (no-store)",
        session: SESSION,
        cache: "no-store",
        success: ok(
          "Drafts",
          itemsOf("id, status, chainId, projectId, escrowAddress, name, createdAt, appliedAt")
        ),
        errors: [401],
      }),
    },
    "/api/v1/launch-drafts": {
      post: op({
        summary: "Create a launch draft (founder, staff or admin; no-store)",
        session: SESSION,
        cache: "no-store",
        body: jsonBody(ref("LaunchDraftBody")),
        success: [
          {
            code: "201",
            description: "Draft created",
            data: { type: "object", properties: { draft: generic("id, status, chainId, shadowWalletId, createdAt") } },
          },
        ],
        errors: [400, 401, 403, 409, 422],
        notes: {
          400: "Validation failed, shadow wallet or repo unavailable, or repoId sent by staff",
          403: "Origin not allowed, wrong role, or launch prerequisites missing",
          409: "Shadow wallet or repo is already reserved or bound",
          422: "Funding goal is below the live minimum",
        },
      }),
    },
    "/api/v1/launch-drafts/{id}/attach": {
      post: op({
        summary: "Attach the deployed escrow address to a draft (founder, staff or admin; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [idParam],
        body: jsonBody({
          type: "object",
          required: ["escrowAddress"],
          additionalProperties: false,
          properties: { escrowAddress: ref("Address") },
        }),
        success: ok("Draft attached", { type: "object", properties: { draft: generic("id, status, chainId, shadowWalletId, createdAt, projectId, escrowAddress, appliedAt") } }),
        errors: [400, 401, 403, 404, 409],
      }),
    },
    "/api/v1/launch-drafts/{id}/cancel": {
      post: op({
        summary: "Cancel a draft (founder, staff or admin; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [idParam],
        success: ok("Draft cancelled", { type: "object", properties: { draft: generic("id, status, chainId, shadowWalletId, createdAt, projectId, escrowAddress, appliedAt") } }),
        errors: [400, 401, 403, 404, 409],
      }),
    },
    "/api/v1/gas/{chainId}/minimum-goal": {
      get: op({
        summary: "Current gas-based minimum funding goal (public)",
        parameters: [pathParam("chainId", { type: "integer", enum: [421614, 97] })],
        cache: "public, max-age=30",
        success: ok(
          "Minimum goal",
          generic(
            "mode (test|live); minGoalWei (wei string, null in test mode); floor; ceiling (only when set); gasPriceUsed; l1FeeUsed; gasUnits; N; M; margin; windowHours (all decimal strings); computedAt (ISO); stale (boolean)"
          )
        ),
        errors: [400],
      }),
    },
    "/api/v1/takeover-cases/mine": {
      get: op({
        summary: "The caller's own candidate takeover cases",
        session: SESSION,
        success: ok("Own cases", itemsOf("id, projectId, chainId, candidateWallet, status, acceptedAt, acceptMessage (text to sign or null), execution (state, proposedTxHash, pendingForCandidate)")),
        errors: [401],
      }),
    },
    "/api/v1/takeover-cases/by-project/{chainId}/{address}": {
      get: op({
        summary: "Public status and tally of the takeover case of a project",
        parameters: [pathParam("chainId", { type: "integer", minimum: 1 }), addressParam],
        success: ok("Public case", {
          type: "object",
          properties: {
            case: {
              allOf: [
                {
                  type: "object",
                  properties: { id: ref("Uuid"), snapshotBlock: nullableStr, holderCount: { type: "integer", nullable: true }, openedAt: nullableIso },
                },
                ref("TallyDto"),
              ],
            },
          },
        }),
        errors: [400, 404],
      }),
    },
    "/api/v1/takeover-cases/{id}/tally": {
      get: op({
        summary: "Public aggregate tally of an opened case (advisory vote)",
        parameters: [idParam],
        success: ok("Tally", { type: "object", properties: { tally: ref("TallyDto") } }),
        errors: [400, 404],
      }),
    },
    "/api/v1/takeover-cases/{id}/my-vote": {
      get: op({
        summary: "The caller's own voting state for a case (no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [idParam],
        success: ok("Own vote state", {
          type: "object",
          properties: {
            myVote: {
              type: "object",
              properties: {
                eligible: { type: "boolean" },
                canVote: { type: "boolean" },
                weight: { type: "string", nullable: true, description: "Snapshot weight, decimal string" },
                myChoice: { type: "string", nullable: true, enum: ["YES", "NO", null] },
                voteMessageTemplate: nullableStr,
              },
            },
          },
        }),
        errors: [400, 401, 404],
      }),
    },
    "/api/v1/takeover-cases/{id}/accept": {
      post: op({
        summary: "Candidate accepts the nomination with a wallet signature",
        session: SESSION,
        parameters: [idParam],
        body: jsonBody({
          type: "object",
          required: ["issuedAt", "signature"],
          additionalProperties: false,
          properties: { issuedAt: { type: "string", format: "date-time", maxLength: 40 }, signature: ref("Signature") },
        }),
        success: ok("Accepted", { type: "object", properties: { accepted: { type: "boolean" }, alreadyAccepted: { type: "boolean" } } }),
        errors: [400, 401, 403, 404, 409, 503],
        notes: { 403: "Not the candidate, or origin not allowed", 409: "Case is not awaiting acceptance" },
      }),
    },
    "/api/v1/takeover-cases/{id}/vote": {
      post: op({
        summary: "Cast or change an advisory vote with a wallet signature (snapshot stakers)",
        session: SESSION,
        parameters: [idParam],
        body: jsonBody({
          type: "object",
          required: ["choice", "issuedAt", "signature"],
          additionalProperties: false,
          properties: {
            choice: { type: "string", enum: ["YES", "NO"] },
            issuedAt: { type: "string", format: "date-time", maxLength: 40 },
            signature: ref("Signature"),
          },
        }),
        success: ok("Vote recorded", {
          type: "object",
          properties: {
            vote: { type: "object", properties: { choice: { type: "string", enum: ["YES", "NO"] }, weight: str, issuedAt: iso, updatedAt: iso } },
            tally: ref("TallyDto"),
          },
        }),
        errors: [400, 401, 403, 404, 409, 503],
        notes: { 403: "Not eligible, or origin not allowed", 409: "Voting is not open, or the vote is stale" },
      }),
    },
    "/api/v1/admin/takeover-cases": {
      get: op({
        summary: "List takeover cases (admin or staff; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [
          query("status", { type: "string", enum: ["prepared", "vote_open", "closed", "cancelled"] }),
          query("chainId", { type: "integer", minimum: 1 }),
          limitParam,
          offsetParam,
        ],
        success: ok("Page of cases", paged(ref("TakeoverCase"))),
        errors: [400, 401, 403],
      }),
      post: op({
        summary: "Prepare a takeover case (admin or staff; no-store)",
        session: SESSION,
        cache: "no-store",
        body: jsonBody({
          type: "object",
          required: ["chainId", "projectAddress", "candidateWallet", "reason"],
          additionalProperties: false,
          properties: {
            chainId: { type: "integer", minimum: 1, maximum: 2147483647 },
            projectAddress: ref("Address"),
            candidateWallet: ref("Address"),
            reason: { type: "string", minLength: 1, maxLength: 2000 },
            evidenceLinks: { type: "array", maxItems: 10, default: [], items: { type: "string", format: "uri", maxLength: 500, pattern: "^https://" } },
          },
        }),
        success: [{ code: "201", description: "Case prepared", data: caseData("The prepared case") }],
        errors: [400, 401, 403, 409, 422, 503],
        notes: {
          409: "Project not in a votable state, active case exists, or a recent failed case is in cooldown",
          422: "Candidate is already the developer, has no account, or lacks an approved application or agreement",
          503: "Indexer is behind or unavailable",
        },
      }),
    },
    "/api/v1/admin/takeover-cases/{id}": {
      get: op({
        summary: "Case detail with execution, repo, handover and holders (admin or staff; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [
          idParam,
          query("limit", { type: "integer", minimum: 1, maximum: 200, default: 50 }),
          query("offset", { type: "integer", minimum: 0, maximum: 1000000, default: 0 }),
        ],
        success: ok("Case detail", {
          type: "object",
          properties: {
            case: ref("TakeoverCaseDetail"),
            holders: {
              type: "object",
              properties: {
                items: { type: "array", items: generic("investorAddress, stakedBalance, unstakedBalance (decimal strings; unstaked may be null)") },
                limit: { type: "integer" },
                offset: { type: "integer" },
              },
            },
          },
        }),
        errors: [400, 401, 403, 404],
      }),
    },
    "/api/v1/admin/takeover-cases/{id}/votes": {
      get: op({
        summary: "Per-address votes of a case (admin or staff; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [
          idParam,
          query("limit", { type: "integer", minimum: 1, maximum: 200, default: 50 }),
          query("offset", { type: "integer", minimum: 0, maximum: 1000000, default: 0 }),
        ],
        success: ok(
          "Page of votes",
          paged({
            type: "object",
            properties: { voter: str, choice: { type: "string", enum: ["YES", "NO"] }, weight: str, issuedAt: iso, updatedAt: iso },
          })
        ),
        errors: [400, 401, 403, 404],
      }),
    },
    "/api/v1/admin/takeover-cases/{id}/open": {
      post: op({
        summary: "Open the vote and take the snapshot (ADMIN only; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [idParam],
        body: emptyBody,
        success: ok("Case opened", caseData("The case and whether it was already open", { alreadyOpen: { type: "boolean" } })),
        errors: [400, 401, 403, 404, 409, 503],
        notes: { 409: "Case cannot be opened in its status, or the candidate has not accepted", 503: "Indexer is behind or unavailable" },
      }),
    },
    "/api/v1/admin/takeover-cases/{id}/cancel": {
      post: op({
        summary: "Cancel a case (ADMIN only; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [idParam],
        body: emptyBody,
        success: ok("Case cancelled", caseData("The cancelled case")),
        errors: [400, 401, 403, 404, 409],
        notes: { 409: "Case cannot be cancelled in its status" },
      }),
    },
    "/api/v1/admin/takeover-cases/{id}/close": {
      post: op({
        summary: "Close a case after its voting window has ended (ADMIN only; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [idParam],
        body: emptyBody,
        success: ok("Case closed", caseData("The closed case")),
        errors: [400, 401, 403, 404, 409],
        notes: { 409: "Case cannot be closed in its status, or the voting window has not ended" },
      }),
    },
    "/api/v1/admin/takeover-cases/{id}/handover": {
      post: op({
        summary: "Hand the repository over to the new developer's GitHub user (ADMIN only; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [idParam],
        body: jsonBody({
          type: "object",
          required: ["githubLogin"],
          additionalProperties: false,
          properties: { githubLogin: { type: "string", pattern: "^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$" } },
        }),
        success: ok("Handover recorded", {
          type: "object",
          properties: {
            handover: { type: "object", properties: { githubLogin: str, status: { type: "string", enum: ["invited", "active"] }, handedOverAt: iso } },
            repo: { type: "object", properties: { id: ref("Uuid"), fullName: str, htmlUrl: str, status: str } },
            alreadyHandedOver: { type: "boolean" },
          },
        }),
        errors: [400, 401, 403, 404, 409, 422, 503],
        notes: {
          409: "New developer has not accepted on chain, no repo is linked, or it was handed to another user",
          422: "GitHub user not found or is the previous developer",
          503: "Provisioning not configured or the indexer could not be read",
        },
      }),
    },
    "/api/v1/complaints/mine": {
      get: op({
        summary: "Own complaints, newest first, capped at 100 (no-store)",
        session: SESSION,
        cache: "no-store",
        success: ok("Complaints", { type: "object", properties: { items: { type: "array", items: ref("ComplaintDto") } } }),
        errors: [401],
      }),
    },
    "/api/v1/complaints": {
      post: op({
        summary: "File a complaint about a project (no-store)",
        session: SESSION,
        cache: "no-store",
        body: jsonBody({
          type: "object",
          required: ["projectId", "category", "body"],
          additionalProperties: false,
          properties: {
            projectId: ref("ProjectId"),
            category: { type: "string", enum: ["MISREPRESENTATION", "REVENUE_UNDERREPORTING", "INACTIVITY", "SECURITY", "OTHER"] },
            body: { type: "string", minLength: 20, maxLength: 2000 },
            evidenceUrl: { type: "string", maxLength: 500, pattern: "^https://" },
          },
        }),
        success: [{ code: "201", description: "Complaint filed", data: { type: "object", properties: { complaint: ref("ComplaintDto") } } }],
        errors: [400, 401, 403, 404, 409],
        notes: { 409: "An active complaint of this category exists for the project", 429: "Too many complaints in the last 24 hours" },
      }),
    },
    "/api/v1/admin/complaints": {
      get: op({
        summary: "List complaints (admin or staff; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [
          limitParam,
          offsetParam,
          query("status", { type: "string", enum: ["OPEN", "INVESTIGATING", "RESOLVED", "DISMISSED"] }),
          projectIdQuery,
        ],
        success: ok("Page of complaints", paged({ allOf: [ref("ComplaintDto"), { type: "object", properties: { reporterAddress: str } }] })),
        errors: [400, 401, 403],
      }),
    },
    "/api/v1/admin/complaints/{id}": {
      patch: op({
        summary: "Change a complaint's status (admin or staff; note required for RESOLVED or DISMISSED; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [pathParam("id", { type: "string", pattern: "^[0-9]{1,15}$" })],
        body: jsonBody({
          type: "object",
          required: ["status"],
          additionalProperties: false,
          properties: {
            status: { type: "string", enum: ["OPEN", "INVESTIGATING", "RESOLVED", "DISMISSED"] },
            note: note(1000),
          },
        }),
        success: ok("Updated complaint", {
          type: "object",
          properties: { complaint: { allOf: [ref("ComplaintDto"), { type: "object", properties: { reporterAddress: str } }] } },
        }),
        errors: [400, 401, 403, 404, 409],
        notes: { 409: "Status change not allowed from the current status" },
      }),
    },
    "/api/v1/admin/users": {
      get: op({
        summary: "List users (admin or staff; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [
          limitParam,
          offsetParam,
          query("role", { type: "string", enum: ["founder", "staff", "investor", "admin"] }),
          query("q", { type: "string", pattern: "^0x[0-9a-f]{0,40}$", description: "Lowercase address prefix" }),
        ],
        success: ok("Page of users", pagedGeneric("id, address, role, createdAt, lastLoginAt (or null)")),
        errors: [400, 401, 403],
      }),
    },
    "/api/v1/admin/users/{address}/role": {
      patch: op({
        summary: "Change a user's role (ADMIN only; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [addressParam],
        body: jsonBody({
          type: "object",
          required: ["role"],
          additionalProperties: false,
          properties: { role: { type: "string", enum: ["founder", "staff", "investor"] } },
        }),
        success: ok("Updated user", { type: "object", properties: { user: generic("The user with the new role") } }),
        errors: [400, 401, 403, 404],
        notes: { 403: "Origin not allowed, not an admin, or the target is the caller, a configured admin or an admin" },
      }),
    },
    "/api/v1/admin/audit-log": {
      get: op({
        summary: "Audit log (admin or staff; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [
          limitParam,
          offsetParam,
          query("action", { type: "string", maxLength: 64, pattern: "^[a-z_]+(\\.[a-z_]+)?$" }),
          query("target", { type: "string", pattern: "^0x[0-9a-f]{40}$" }),
          query("actor", ref("Uuid")),
        ],
        success: ok("Page of audit entries", pagedGeneric("id, actorUserId, action, target, before, after, ip, createdAt")),
        errors: [400, 401, 403],
      }),
    },
    "/api/v1/admin/launch-drafts": {
      get: op({
        summary: "List launch drafts (admin or staff; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [
          limitParam,
          offsetParam,
          query("status", { type: "string", enum: ["pending", "attached", "applied", "cancelled", "expired", "conflict"] }),
          query("userId", ref("Uuid")),
          chainQuery,
        ],
        success: ok("Page of drafts", pagedGeneric("id, userId, walletAddress, status, chainId, founderWalletId, escrowAddress, projectId, name, createdAt, appliedAt")),
        errors: [400, 401, 403],
      }),
    },
    "/api/v1/admin/relay-requests": {
      get: op({
        summary: "List relay requests of all users (admin or staff; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [
          limitParam,
          offsetParam,
          query("kind", { type: "string", enum: ["claim", "stake", "vote", "execute"] }),
          query("status", { type: "string", enum: ["QUEUED", "SENDING", "SENT", "CONFIRMED", "FAILED", "EXPIRED"] }),
          chainQuery,
          query("system", { type: "string", enum: ["true"] }),
          projectIdQuery,
        ],
        success: ok("Page of relay requests", paged({ allOf: [ref("RelayRequestDto"), { type: "object", properties: { userId: nullableStr, account: nullableStr } }] })),
        errors: [400, 401, 403],
      }),
    },
    "/api/v1/admin/inflows": {
      get: op({
        summary: "Observed revenue inflows (admin or staff; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [limitParam, offsetParam, chainQuery, projectIdQuery, query("kind", { type: "string", enum: ["native", "internal", "erc20"] })],
        success: ok("Page of inflows", {
          type: "object",
          required: ["items", "total", "limit", "offset"],
          properties: {
            items: { type: "array", items: generic("Inflow row with amount (wei string), amountFormatted (null for erc20), firstSeenAt") },
            total: { type: "integer" },
            limit: { type: "integer" },
            offset: { type: "integer" },
            cursors: { type: "array", description: "Only when projectId is given", items: generic("kind, lastBlock, lastPolledAt, lastError") },
          },
        }),
        errors: [400, 401, 403],
      }),
    },
    "/api/v1/admin/compliance": {
      get: op({
        summary: "Revenue compliance cases (admin or staff; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [limitParam, offsetParam, chainQuery, query("state", { type: "string", enum: COMPLIANCE_STATES })],
        success: ok("Page of cases", pagedGeneric("id, projectId, chainId, state, openedAt, stateChangedAt, escalatedAt, resolvedAt, resolutionNote, lastCheckedAt, observedNative, routedNative, shortfallBps, windowStart, windowEnd")),
        errors: [400, 401, 403],
      }),
    },
    "/api/v1/admin/compliance/{projectId}/resolve": {
      post: op({
        summary: "Resolve a compliance case (admin or staff; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [projectIdParam],
        body: jsonBody({ type: "object", required: ["note"], additionalProperties: false, properties: { note: note(500) } }),
        success: ok("Updated case", { type: "object", properties: { case: generic("The compliance case") } }),
        errors: [400, 401, 403, 404, 409],
        notes: { 409: "No open compliance case in a state that allows this action" },
      }),
    },
    "/api/v1/admin/compliance/{projectId}/shutdown": {
      post: op({
        summary: "Mark a compliance case as shut down (admin or staff; no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [projectIdParam],
        body: jsonBody({ type: "object", required: ["note"], additionalProperties: false, properties: { note: note(500) } }),
        success: ok("Updated case", { type: "object", properties: { case: generic("The compliance case") } }),
        errors: [400, 401, 403, 404, 409],
        notes: { 409: "No open compliance case in a state that allows this action" },
      }),
    },
    "/api/v1/relay/status": {
      get: op({
        summary: "Coarse relayer health per chain (public, no-store)",
        cache: "no-store",
        success: ok("Status", {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            chains: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  chainId: { type: "integer" },
                  enabled: { type: "boolean" },
                  relayerAddress: str,
                  balance: { type: "string", enum: ["ok", "low", "empty", "unknown"] },
                },
              },
            },
          },
        }),
      }),
    },
    "/api/v1/relay": {
      get: op({
        summary: "Own relay requests (no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [limitParam],
        success: ok("Requests", { type: "object", properties: { items: { type: "array", items: ref("RelayRequestDto") } } }),
        errors: [400, 401],
      }),
    },
    "/api/v1/relay/{id}": {
      get: op({
        summary: "One own relay request (no-store)",
        session: SESSION,
        cache: "no-store",
        parameters: [idParam],
        success: ok("The request", { type: "object", properties: { request: ref("RelayRequestDto") } }),
        errors: [400, 401, 404],
      }),
    },
    "/api/v1/relay/claim": {
      post: op({
        summary: "Queue a gasless token claim (no-store)",
        session: SESSION,
        cache: "no-store",
        body: jsonBody({ type: "object", required: ["projectId"], additionalProperties: false, properties: { projectId: ref("ProjectId") } }),
        success: relayIntake(),
        errors: [400, 401, 403, 409, 422, 503],
        notes: relayNotes(),
      }),
    },
    "/api/v1/relay/vote": {
      post: op({
        summary: "Queue a gasless milestone vote signed by the caller (no-store)",
        session: SESSION,
        cache: "no-store",
        body: jsonBody({
          type: "object",
          required: ["projectId", "support", "deadline", "signature"],
          additionalProperties: false,
          properties: {
            projectId: ref("ProjectId"),
            support: { type: "boolean" },
            deadline: { type: "integer", minimum: 1, maximum: 9999999999, description: "Unix seconds" },
            signature: ref("Signature"),
          },
        }),
        success: relayIntake(),
        errors: [400, 401, 403, 409, 422, 503],
        notes: relayNotes(),
      }),
    },
    "/api/v1/relay/stake": {
      post: op({
        summary: "Queue a gasless stake signed by the caller (no-store)",
        session: SESSION,
        cache: "no-store",
        body: jsonBody({
          type: "object",
          required: ["projectId", "amount", "deadline", "signature"],
          additionalProperties: false,
          properties: {
            projectId: ref("ProjectId"),
            amount: { type: "string", pattern: "^[1-9][0-9]{0,77}$", description: "Token amount in wei" },
            deadline: { type: "integer", minimum: 1, maximum: 9999999999, description: "Unix seconds" },
            signature: ref("Signature"),
          },
        }),
        success: relayIntake(),
        errors: [400, 401, 403, 409, 422, 503],
        notes: relayNotes(),
      }),
    },
    "/health": {
      get: { summary: "Liveness", responses: { "200": statusOk("Process is up") } },
    },
    "/ready": {
      get: {
        summary: "Readiness: DB reachable and migrations applied",
        responses: { "200": statusOk("Ready"), "503": errorResponse("Not ready") },
      },
    },
    "/health/db": {
      get: {
        summary: "Database connectivity",
        responses: {
          "200": statusOk("Connected"),
          "429": errorResponse("Too many requests"),
          "503": errorResponse("Database unavailable"),
        },
      },
    },
  },
  components: {
    securitySchemes: {
      cookieSession: { type: "apiKey", in: "cookie", name: "fc_session" },
    },
    parameters: {
      Limit: { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
      Offset: { name: "offset", in: "query", required: false, schema: { type: "integer", minimum: 0, maximum: 10000, default: 0 } },
    },
    schemas: {
      Uuid: { type: "string", format: "uuid" },
      Address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
      ProjectId: { type: "string", pattern: "^[0-9]{1,10}:0x[a-fA-F0-9]{40}$", description: "<chainId>:<escrow address>" },
      Signature: { type: "string", pattern: "^0x[0-9a-fA-F]{130}$" },
      ErrorEnvelope: {
        type: "object",
        required: ["success", "error"],
        properties: {
          success: { type: "boolean", enum: [false] },
          error: { type: "string" },
          code: { type: "string", description: "Stable machine code; relay routes only" },
          requestId: { type: "string" },
          details: {
            type: "array",
            items: {
              type: "object",
              properties: { path: { type: "string" }, message: { type: "string" } },
            },
          },
        },
      },
      User: {
        type: "object",
        properties: {
          id: { $ref: "#/components/schemas/Uuid" },
          address: { type: "string", description: "Lowercase wallet address" },
          role: { type: "string", enum: ["investor", "founder", "staff", "admin"] },
          profileComplete: { type: "boolean" },
        },
      },
      Project: {
        type: "object",
        description: "On-chain bigint values are decimal strings or null; profile is null if none.",
        properties: {
          id: { type: "string" },
          chainId: { type: "integer" },
          fundingGoal: { type: "string", nullable: true },
          totalRaised: { type: "string", nullable: true },
          state: { type: "string" },
          profile: { type: "object", nullable: true, additionalProperties: true },
        },
        additionalProperties: true,
      },
      ProfileBody: {
        type: "object",
        required: ["projectId", "name", "description"],
        additionalProperties: false,
        properties: {
          projectId: { type: "string" },
          name: { type: "string", maxLength: 120 },
          description: { type: "string", maxLength: 5000 },
          founderBio: { type: "string", maxLength: 5000 },
          logoUrl: { type: "string", format: "uri" },
          pitchDeckUrl: { type: "string", format: "uri" },
          websiteUrl: { type: "string", format: "uri" },
          category: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,31}$" },
          shadowWallet: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
          shadowWalletId: { type: "string", format: "uuid" },
        },
      },
      UserProfileBody: {
        type: "object",
        required: ["firstName", "lastName", "email", "phone", "addressLine1", "city", "postalCode", "country", "dateOfBirth"],
        additionalProperties: false,
        properties: {
          firstName: { type: "string", minLength: 1, maxLength: 80 },
          lastName: { type: "string", minLength: 1, maxLength: 80 },
          email: { type: "string", maxLength: 254 },
          phone: { type: "string", pattern: "^\\+?[0-9 ()-]{7,20}$" },
          addressLine1: { type: "string", minLength: 1, maxLength: 120 },
          addressLine2: { type: "string", minLength: 1, maxLength: 120 },
          city: { type: "string", minLength: 1, maxLength: 80 },
          region: { type: "string", minLength: 1, maxLength: 80 },
          postalCode: { type: "string", minLength: 1, maxLength: 20 },
          country: { type: "string", pattern: "^[A-Za-z]{2}$", description: "ISO 3166-1 alpha-2" },
          dateOfBirth: { type: "string", format: "date", description: "YYYY-MM-DD; must be 18 or older" },
        },
      },
      ApplicationBody: {
        type: "object",
        required: ["resumeUrl", "about", "kycDocsUrl"],
        additionalProperties: false,
        description: "At least one of linkedinUrl, githubUrl or portfolioUrl is required",
        properties: {
          resumeUrl: { type: "string", maxLength: 500, pattern: "^https://", description: "Staff-only https link to a resume; no credentials" },
          about: { type: "string", minLength: 50, maxLength: 1500 },
          linkedinUrl: { type: "string", maxLength: 300, pattern: "^https://([a-z]{2}\\.|www\\.)?linkedin\\.com/in/[^/]+/?$", description: "LinkedIn profile URL" },
          githubUrl: { type: "string", maxLength: 300, pattern: "^https://(www\\.)?github\\.com/[A-Za-z0-9-]+/?$", description: "GitHub profile URL (not a repository)" },
          portfolioUrl: { type: "string", maxLength: 300, pattern: "^https://", description: "https URL without credentials" },
          otherLinks: { type: "array", maxItems: 3, items: { type: "string", maxLength: 300, pattern: "^https://" } },
          kycDocsUrl: { type: "string", maxLength: 500, pattern: "^https://", description: "https URL without credentials" },
          kycNote: { type: "string", minLength: 1, maxLength: 500 },
        },
      },
      LaunchDraftBody: {
        type: "object",
        required: ["chainId", "name", "description"],
        additionalProperties: false,
        properties: {
          chainId: { type: "integer", enum: [421614, 97] },
          name: { type: "string", minLength: 1, maxLength: 120 },
          description: { type: "string", minLength: 1, maxLength: 5000 },
          founderBio: { type: "string", maxLength: 5000 },
          logoUrl: { type: "string", maxLength: 2048 },
          pitchDeckUrl: { type: "string", maxLength: 2048 },
          websiteUrl: { type: "string", maxLength: 2048 },
          category: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,31}$" },
          shadowWalletId: { type: "string", format: "uuid", description: "Required for founders" },
          repoId: {
            type: "string",
            format: "uuid",
            description: "Founders only; defaults to the single selectable repo. Staff sending it get 400",
          },
          fundingGoalWei: { type: "string", pattern: "^[1-9]\\d{0,77}$", description: "Wei; required in live minimum-goal mode" },
        },
      },
      OwnRepoItem: {
        type: "object",
        required: ["id", "fullName", "htmlUrl", "founderLogin", "status", "createdAt", "projectId", "projectName", "reserved"],
        additionalProperties: false,
        properties: {
          id: { $ref: "#/components/schemas/Uuid" },
          fullName: { type: "string" },
          htmlUrl: { type: "string" },
          founderLogin: { type: "string" },
          status: { type: "string", enum: ["invited", "active", "failed", "revoked"] },
          createdAt: { type: "string", format: "date-time" },
          projectId: { type: "string", nullable: true },
          projectName: { type: "string", nullable: true },
          reserved: { type: "boolean", description: "A pending or attached launch draft holds the repo" },
        },
      },
      StaffRepoItem: {
        type: "object",
        properties: {
          fullName: { type: "string" },
          htmlUrl: { type: "string" },
          founderLogin: { type: "string" },
          status: { type: "string", enum: ["invited", "active", "failed", "revoked"] },
          createdAt: { type: "string", format: "date-time" },
          userId: { $ref: "#/components/schemas/Uuid" },
          founderWallet: { type: "string" },
          projectId: { type: "string", nullable: true },
          revokedAt: { type: "string", format: "date-time", nullable: true },
        },
      },
      FounderMe: {
        type: "object",
        properties: {
          agreement: {
            type: "object",
            nullable: true,
            properties: { version: { type: "string" }, acceptedAt: { type: "string", format: "date-time" } },
          },
          wallets: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { $ref: "#/components/schemas/Uuid" },
                address: { type: "string" },
                status: { type: "string", enum: ["pending", "approved", "rejected"] },
                reviewNote: { type: "string", nullable: true },
                projectId: { type: "string", nullable: true },
                reserved: { type: "boolean" },
              },
            },
          },
        },
      },
      TakeoverCase: {
        type: "object",
        description: "Staff view. Amounts and block numbers are decimal strings; dates are ISO strings or null.",
        properties: {
          id: { $ref: "#/components/schemas/Uuid" },
          chainId: { type: "integer" },
          projectId: { type: "string" },
          candidateWallet: { type: "string" },
          candidateUserId: { $ref: "#/components/schemas/Uuid" },
          reason: { type: "string" },
          evidenceLinks: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["prepared", "vote_open", "closed", "cancelled"] },
          createdBy: { type: "string" },
          openedBy: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          openedAt: { type: "string", format: "date-time", nullable: true },
          cancelledAt: { type: "string", format: "date-time", nullable: true },
          snapshotBlock: { type: "string", nullable: true },
          snapshotBlockTimestamp: { type: "string", format: "date-time", nullable: true },
          snapshotTakenAt: { type: "string", format: "date-time", nullable: true },
          snapshotLagSeconds: { type: "integer", nullable: true },
          snapshotTotalStaked: { type: "string", nullable: true },
          snapshotHolderCount: { type: "integer", nullable: true },
          candidateAcceptedAt: { type: "string", format: "date-time", nullable: true },
          developerAtOpen: { type: "string", nullable: true },
          endsAt: { type: "string", format: "date-time", nullable: true },
          closedAt: { type: "string", format: "date-time", nullable: true },
          result: { type: "string", nullable: true, enum: ["passed", "failed", "no_quorum", null] },
          quorumPercent: { type: "integer", nullable: true },
          yesWeight: { type: "string", nullable: true },
          noWeight: { type: "string", nullable: true },
          votedWeight: { type: "string", nullable: true },
          voterCount: { type: "integer", nullable: true },
        },
      },
      TakeoverCaseDetail: {
        description: "The staff case plus on-chain execution, linked repo, handover state and a GitHub login suggestion.",
        allOf: [
          { $ref: "#/components/schemas/TakeoverCase" },
          {
            type: "object",
            properties: {
              execution: {
                type: "object",
                additionalProperties: true,
                description:
                  "state (none|proposed|accepted|unknown), proposedTxHash, proposedBlock, proposedAt, proposedBy, acceptedTxHash, acceptedBlock, acceptedAt, pendingForCandidate, canPropose, canProposeReason",
              },
              repo: {
                type: "object",
                nullable: true,
                properties: {
                  id: { $ref: "#/components/schemas/Uuid" },
                  fullName: { type: "string" },
                  htmlUrl: { type: "string" },
                  status: { type: "string" },
                  founderLogin: { type: "string" },
                },
              },
              handover: {
                type: "object",
                nullable: true,
                properties: {
                  githubLogin: { type: "string" },
                  status: { type: "string", enum: ["invited", "active"] },
                  handedOverAt: { type: "string", format: "date-time" },
                  handedOverBy: { type: "string", nullable: true },
                },
              },
              suggestedGithubLogin: { type: "string", nullable: true },
            },
          },
        ],
      },
      TallyDto: {
        type: "object",
        description: "Aggregate advisory tally; weights are decimal strings. Never per-address data.",
        properties: {
          status: { type: "string", enum: ["prepared", "vote_open", "closed", "cancelled"] },
          result: { type: "string", nullable: true, enum: ["passed", "failed", "no_quorum", null] },
          candidateWallet: { type: "string" },
          endsAt: { type: "string", format: "date-time", nullable: true },
          quorumPercent: { type: "integer", nullable: true },
          quorumWeightRequired: { type: "string", nullable: true },
          snapshotTotalStaked: { type: "string", nullable: true },
          yesWeight: { type: "string" },
          noWeight: { type: "string" },
          votedWeight: { type: "string" },
          voterCount: { type: "integer" },
          quorumReached: { type: "boolean", nullable: true },
          closedAt: { type: "string", format: "date-time", nullable: true },
          advisory: { type: "boolean", enum: [true] },
        },
      },
      RelayRequestDto: {
        type: "object",
        description: "Never includes calldata or the signature.",
        properties: {
          id: { $ref: "#/components/schemas/Uuid" },
          kind: { type: "string", enum: ["claim", "stake", "vote", "execute"] },
          chainId: { type: "integer" },
          projectId: { type: "string" },
          status: { type: "string", enum: ["QUEUED", "SENDING", "SENT", "CONFIRMED", "FAILED", "EXPIRED"] },
          errorCode: { type: "string", nullable: true },
          errorMessage: { type: "string", nullable: true },
          txHash: { type: "string", nullable: true },
          gasUsed: { type: "string", nullable: true },
          effectiveGasPrice: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          sentAt: { type: "string", format: "date-time", nullable: true },
          confirmedAt: { type: "string", format: "date-time", nullable: true },
          expiresAt: { type: "string", format: "date-time" },
        },
      },
      ComplaintDto: {
        type: "object",
        description: "Reporter view: includes the staff note, never staff identity.",
        properties: {
          id: { type: "string" },
          projectId: { type: "string" },
          chainId: { type: "integer" },
          category: { type: "string", enum: ["MISREPRESENTATION", "REVENUE_UNDERREPORTING", "INACTIVITY", "SECURITY", "OTHER"] },
          body: { type: "string" },
          evidenceUrl: { type: "string", nullable: true },
          status: { type: "string", enum: ["OPEN", "INVESTIGATING", "RESOLVED", "DISMISSED"] },
          staffNote: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          resolvedAt: { type: "string", format: "date-time", nullable: true },
        },
      },
    },
  },
} as const;

/** 202 when queued, 200 when an identical request already exists. */
function relayIntake(): Success[] {
  const data = { type: "object", properties: { id: ref("Uuid"), status: { type: "string" } } };
  return [
    { code: "202", description: "Queued", data },
    { code: "200", description: "An identical request already exists", data },
  ];
}

function relayNotes(): Record<number, string> {
  return {
    400: "Validation failed, invalid signature or deadline out of range (error carries a stable code)",
    403: "Origin not allowed, or the signature does not belong to the signed-in wallet",
    409: "Self-pay required, already voted or claimed, or retry needed",
    422: "Simulation failed (no voting power, voting closed, insufficient balance, ...)",
    429: "Too many requests or a daily gasless limit was reached",
    503: "Relayer disabled, low on funds, or temporarily unavailable",
  };
}
