import { createRequire } from "node:module";
import { join } from "node:path";
import pino, { type DestinationStream, type LoggerOptions } from "pino";
import { config } from "./config/env.js";

// Resolve relative to the working directory (avoids import.meta, which differs
// between the tsx CJS runtime and the ESM test runtime).
const requireFromCwd = createRequire(join(process.cwd(), "noop.js"));

export const REDACT_PATHS: string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "*.password",
  "*.token",
  "*.signature",
  "*.secret",
  "*.privateKey",
  "*.DATABASE_URL",
  "*.connectionString",
];

export function buildLoggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  };
}

function isPrettyAvailable(): boolean {
  try {
    requireFromCwd.resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

const usePretty = config.NODE_ENV === "development" && isPrettyAvailable();

export const logger = usePretty
  ? pino({
      ...buildLoggerOptions(config.LOG_LEVEL),
      transport: { target: "pino-pretty" },
    })
  : pino(buildLoggerOptions(config.LOG_LEVEL));

/** Dedicated child for audit trail events (used by later steps). */
export const auditLogger = logger.child({ stream: "audit" });

/** Builds a logger writing to a custom stream; used by redaction tests. */
export function createLoggerWithStream(
  level: string,
  stream: DestinationStream
): pino.Logger {
  return pino(buildLoggerOptions(level), stream);
}
