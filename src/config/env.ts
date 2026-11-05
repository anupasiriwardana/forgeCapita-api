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
  })
  .transform((value, ctx) => {
    const rawOrigins = value.CORS_ORIGINS?.trim() ?? "";
    let origins: string[] | null;
    if (rawOrigins === "") {
      origins = value.NODE_ENV === "production" ? [] : [DEFAULT_DEV_ORIGIN];
    } else {
      origins = parseCorsOrigins(rawOrigins);
    }
    if (origins === null || origins.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["CORS_ORIGINS"],
        message: "invalid",
      });
      return z.NEVER;
    }
    return { ...value, CORS_ORIGINS: origins };
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
