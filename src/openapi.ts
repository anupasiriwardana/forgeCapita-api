/** Hand-written OpenAPI 3.0.3 document for the existing routes. Amounts are decimal strings. */

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

const projectIdParam = {
  name: "projectId",
  in: "path",
  required: true,
  description: "Composite id <chainId>:<escrow address>",
  schema: { type: "string", pattern: "^[0-9]{1,10}:0x[a-fA-F0-9]{40}$" },
};

const statusOk = (description: string): object => ({
  description,
  content: {
    "application/json": {
      schema: okEnvelope({ type: "object", properties: { status: { type: "string" } } }),
    },
  },
});

export const openApiDocument = {
  openapi: "3.0.3",
  info: { title: "forgeCapita API", version: "1.0.0" },
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
    "/api/v1/projects/profile": {
      post: {
        summary: "Create or update a project profile (session cookie required; developer, staff or admin)",
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
    schemas: {
      ErrorEnvelope: {
        type: "object",
        required: ["success", "error"],
        properties: {
          success: { type: "boolean", enum: [false] },
          error: { type: "string" },
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
        },
      },
    },
  },
} as const;
