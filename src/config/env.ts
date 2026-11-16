import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ quiet: true });

const DEFAULT_DEV_ORIGIN = "http://localhost:3000";

/**
 * Parses a comma-separated CORS origin list. Entries are trimmed, empties are
 * dropped, and each must be an exact http(s) origin (no path, no trailing
 * slash, no wildcard). Returns null when any entry is invalid.
 */
export function parseCorsOrigins(raw: string): string[] | null {
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  for (const entry of entries) {
    if (entry.includes("*")) return null;
    let origin: string;
    let protocol: string;
    try {
      const url = new URL(entry);
      origin = url.origin;
      protocol = url.protocol;
    } catch {
      return null;
    }
    if (protocol !== "http:" && protocol !== "https:") return null;
    if (origin !== entry) return null;
  }
  return entries;
}

/**
 * Parses the comma-separated admin wallet list into lowercase addresses.
 * Empty means none; returns null when any entry is not a 0x + 40 hex address.
 */
export function parseAdminWallets(raw: string): string[] | null {
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (!entries.every((entry) => /^0x[a-fA-F0-9]{40}$/.test(entry))) return null;
  return entries.map((entry) => entry.toLowerCase());
}

export const GITHUB_LOGIN_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

const GITHUB_VARS = ["GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY_BASE64", "GITHUB_ORG"] as const;

/** Names (never values) of the GitHub provisioning variables that are not set. */
export function missingGithubVars(value: Partial<Record<(typeof GITHUB_VARS)[number], string | undefined>>): string[] {
  return GITHUB_VARS.filter((name) => value[name] === undefined);
}

/** Treats an empty variable (KEY=) as unset. */
function emptyAsUndefined<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === "" ? undefined : value), schema);
}

function gweiSchema(fallback: string): z.ZodDefault<z.ZodString> {
  return z
    .string()
    .regex(/^\d{1,6}(\.\d{1,9})?$/, "must be a positive decimal gwei amount")
    .refine((value) => Number(value) > 0, "must be positive")
    .default(fallback);
}

function weiSchema(fallback: string): z.ZodDefault<z.ZodString> {
  return z.string().regex(/^\d{1,30}$/, "must be an integer wei amount").default(fallback);
}

export const envSchema = z
  .object({
    DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\//, "must be a postgres:// or postgresql:// URL"),
    PONDER_SCHEMA: z
      .string()
      .regex(/^[a-z_][a-z0-9_]{0,62}$/, "must be a lowercase SQL identifier")
      .default("ponder"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    CORS_ORIGINS: z.string().optional(),
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    BODY_LIMIT: z
      .string()
      .regex(/^\d+(b|kb|mb)$/i, "must look like 100kb")
      .default("100kb"),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(3_600_000).default(60_000),
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100_000).default(120),
    PROFILE_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100_000).default(10),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100_000).default(10),
    DRAFT_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(5000).max(3_600_000).default(15_000),
    ADMIN_WALLETS: z.string().optional(),
    RELAYER_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // Read only by src/relay/signer.ts; never log or echo it.
    RELAYER_PRIVATE_KEY: emptyAsUndefined(z.string().regex(/^0x[a-fA-F0-9]{64}$/, "must be 0x followed by 64 hex characters (no quotes or spaces)").optional()),
    RELAYER_REGISTRY_ADDRESS: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .default("0x2e6A22fd249930b9F2905D1bD66443CbE366AacB"),
    RPC_URL_421614: emptyAsUndefined(z.string().url().startsWith("https://").optional()),
    RPC_URL_97: emptyAsUndefined(z.string().url().startsWith("https://").optional()),
    RELAYER_MAX_GAS_PRICE_GWEI_421614: gweiSchema("1"),
    RELAYER_MAX_GAS_PRICE_GWEI_97: gweiSchema("10"),
    RELAYER_MIN_BALANCE_WEI_421614: weiSchema("100000000000000"),
    RELAYER_MIN_BALANCE_WEI_97: weiSchema("1000000000000000"),
    RELAYER_USER_DAILY_LIMIT: z.coerce.number().int().min(1).max(10_000).default(20),
    RELAYER_CHAIN_DAILY_LIMIT: z.coerce.number().int().min(1).max(100_000).default(500),
    RELAYER_CONFIRMATIONS: z.coerce.number().int().min(1).max(64).default(2),
    // Automatic executeMilestone at the end of a voting period; anything but "true" keeps it off.
    MILESTONE_AUTOMATIC_EXECUTION: emptyAsUndefined(z.enum(["true", "false"]).optional()).transform(
      (value) => value === "true"
    ),
    MILESTONE_AUTOEXEC_INTERVAL_MS: z.coerce.number().int().min(15_000).max(3_600_000).default(60_000),
    MILESTONE_AUTOEXEC_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    // Revenue audit (inflow ingestion). Only the exact value "true" enables it.
    REVENUE_AUDIT_ENABLED: emptyAsUndefined(z.string().optional()).transform((value) => value === "true"),
    // Read only by src/audit/explorerClient.ts; never log or echo it.
    ETHERSCAN_API_KEY: emptyAsUndefined(z.string().trim().min(1).max(200).optional()),
    REVENUE_AUDIT_CHAINS: emptyAsUndefined(z.string().optional()).transform((value, ctx): number[] => {
      const ids = (value ?? "421614").split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
      if (ids.length === 0 || !ids.every((id) => id === "421614" || id === "97")) {
        ctx.addIssue({ code: "custom", message: "invalid" });
        return z.NEVER;
      }
      return [...new Set(ids.map(Number))];
    }),
    EXPLORER_POLL_INTERVAL_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(900_000),
    // Allowed shortfall (basis points) between explorer-observed inflow and on-chain routed revenue.
    REVENUE_TOLERANCE_BPS: emptyAsUndefined(z.coerce.number().int().min(0).max(10_000).default(400)),
    EXPLORER_MIN_INTERVAL_MS: z.coerce.number().int().min(0).max(60_000).default(600),
    EXPLORER_BASE_URL: emptyAsUndefined(z.string().url().startsWith("https://").optional()).transform(
      (value) => value ?? "https://api.etherscan.io/v2/api"
    ),
    // Live minimum funding goal. Only "test" disables enforcement; anything else invalid fails startup.
    MINIMUM_GOAL_MODE: emptyAsUndefined(z.enum(["test", "live"]).default("live")),
    MIN_GOAL_FLOOR_WEI_421614: emptyAsUndefined(weiSchema("500000000000000000")),
    MIN_GOAL_FLOOR_WEI_97: emptyAsUndefined(weiSchema("1000000000000000000")),
    MIN_GOAL_CEILING_WEI_421614: emptyAsUndefined(z.string().regex(/^\d{1,30}$/).optional()),
    MIN_GOAL_CEILING_WEI_97: emptyAsUndefined(z.string().regex(/^\d{1,30}$/).optional()),
    MIN_GOAL_L1_FEE_WEI_421614: emptyAsUndefined(weiSchema("60000000000000")),
    MIN_GOAL_GAS_UNITS: emptyAsUndefined(z.string().regex(/^[1-9]\d{0,15}$/).default("85020820")),
    MIN_GOAL_N: emptyAsUndefined(z.coerce.number().int().min(1).max(100_000).default(100)),
    MIN_GOAL_M: emptyAsUndefined(z.coerce.number().int().min(0).max(1000).default(5)),
    MIN_GOAL_MARGIN_BPS: emptyAsUndefined(z.coerce.number().int().min(0).max(100_000).default(5000)),
    GAS_WINDOW_HOURS: emptyAsUndefined(z.coerce.number().int().min(1).max(48).default(24)),
    GAS_SAMPLE_INTERVAL_MS: emptyAsUndefined(z.coerce.number().int().min(15_000).max(3_600_000).default(300_000)),
    // GitHub repository provisioning (GitHub App). All four must be set to enable it; empty = unset.
    GITHUB_APP_ID: emptyAsUndefined(z.string().regex(/^[1-9][0-9]{0,15}$/, "must be a positive integer").optional()),
    GITHUB_APP_INSTALLATION_ID: emptyAsUndefined(z.string().regex(/^[1-9][0-9]{0,15}$/, "must be a positive integer").optional()),
    // Base64 of the App private key PEM. Decoded in memory by src/repos/githubProvider.ts only; never log or echo it.
    GITHUB_APP_PRIVATE_KEY_BASE64: emptyAsUndefined(
      z.string().trim().regex(/^[A-Za-z0-9+/]+={0,2}$/, "must be base64").min(100).max(16_000).optional()
    ),
    GITHUB_ORG: emptyAsUndefined(z.string().regex(GITHUB_LOGIN_PATTERN, "must be a GitHub login").optional()),
    // Branch protection on the default branch of new repos; only the exact value "true" enables it.
    REPO_BRANCH_PROTECTION: emptyAsUndefined(z.enum(["true", "false"]).optional()).transform((value) => value === "true"),
    // Internal base URL of the indexer (e.g. http://indexer:42069; http is allowed on the docker network).
    // Unset = opening a takeover vote fails closed with 503.
    INDEXER_URL: emptyAsUndefined(
      z
        .string()
        .trim()
        .url()
        .refine((value) => /^https?:\/\//i.test(value), "must be an http(s) URL")
        .transform((value) => value.replace(/\/+$/, ""))
        .optional()
    ),
    // Maximum indexer lag (seconds) allowed when freezing a takeover stake snapshot.
    TAKEOVER_MAX_LAG_SECONDS: emptyAsUndefined(z.coerce.number().int().min(30).max(86_400).default(300)),
    // Takeover vote (advisory): quorum as a percentage of the snapshot total staked, voting window, cooldown after a failed case.
    TAKEOVER_QUORUM_PERCENT: emptyAsUndefined(z.coerce.number().int().min(1).max(100).default(20)),
    TAKEOVER_VOTE_DAYS: emptyAsUndefined(z.coerce.number().int().min(1).max(90).default(7)),
    TAKEOVER_COOLDOWN_DAYS: emptyAsUndefined(z.coerce.number().int().min(0).max(365).default(30)),
    AUTH_DOMAIN: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9.-]+(:\d{1,5})?$/, "must be a host[:port]")
      .optional(),
    SESSION_COOKIE_SAMESITE: z.enum(["lax", "none"]).default("lax"),
  })
  .transform((value, ctx) => {
    const rawOrigins = value.CORS_ORIGINS?.trim() ?? "";
    let origins: string[] | null;
    if (rawOrigins === "") {
      origins = value.NODE_ENV === "production" ? [] : [DEFAULT_DEV_ORIGIN];
    } else {
      origins = parseCorsOrigins(rawOrigins);
    }
    const primaryOrigin = origins?.[0];
    if (origins === null || primaryOrigin === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["CORS_ORIGINS"],
        message: "invalid",
      });
      return z.NEVER;
    }
    const adminWallets = parseAdminWallets(value.ADMIN_WALLETS ?? "");
    if (adminWallets === null) {
      ctx.addIssue({ code: "custom", path: ["ADMIN_WALLETS"], message: "invalid" });
      return z.NEVER;
    }
    return {
      ...value,
      CORS_ORIGINS: origins,
      ADMIN_WALLETS: adminWallets,
      githubMissing: missingGithubVars(value),
      githubConfigured: missingGithubVars(value).length === 0,
      AUTH_DOMAIN: value.AUTH_DOMAIN ?? new URL(primaryOrigin).host,
    };
  });

export type AppConfig = z.output<typeof envSchema>;

function loadConfig(): Readonly<AppConfig> {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    // The logger depends on this config, so it does not exist yet: print variable
    // names and generic reasons only (never values) straight to stderr.
    console.error("Invalid environment configuration:");
    for (const issue of result.error.issues) {
      const name = issue.path.join(".") || "(env)";
      const reason =
        process.env[name] === undefined || process.env[name] === ""
          ? "required"
          : issue.code === "invalid_format" || issue.code === "invalid_value"
            ? "invalid format"
            : issue.code === "too_small" || issue.code === "too_big"
              ? "out of range"
              : "invalid";
      console.error(`  - ${name}: ${reason}`);
    }
    process.exit(1);
  }
  return Object.freeze(result.data);
}

export const config: Readonly<AppConfig> = loadConfig();
