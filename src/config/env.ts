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
