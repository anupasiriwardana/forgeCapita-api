import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { config } from "../config/env.js";
import { AppError } from "../errors.js";
import { logger } from "../logger.js";

export interface ErrorDetail {
  path: string;
  message: string;
}

interface ErrorBody {
  success: false;
  error: string;
  requestId?: string;
  details?: ErrorDetail[];
}

interface ResolvedError {
  status: number;
  error: string;
  details?: ErrorDetail[];
}

/** Keeps only path and message; zod messages for unknown keys would echo input. */
export function toValidationDetails(err: ZodError): ErrorDetail[] {
  return err.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.code === "unrecognized_keys" ? "Unknown field" : issue.message,
  }));
}

function bodyParserType(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const type: unknown = (err as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

function resolveError(err: unknown): ResolvedError {
  if (err instanceof ZodError) {
    return { status: 400, error: "Validation failed", details: toValidationDetails(err) };
  }
  if (err instanceof AppError) {
    return err.expose
      ? { status: err.status, error: err.message }
      : { status: err.status, error: "Internal server error" };
  }
  switch (bodyParserType(err)) {
    case "entity.parse.failed":
      return { status: 400, error: "Invalid JSON body" };
    case "entity.too.large":
      return { status: 413, error: "Payload too large" };
    case "encoding.unsupported":
    case "charset.unsupported":
      return { status: 415, error: "Unsupported media type" };
    default:
      return { status: 500, error: "Internal server error" };
  }
}

function requestIdOf(res: Response): string | undefined {
  const id: unknown = res.locals["requestId"];
  return typeof id === "string" ? id : undefined;
}

/**
 * Global error-handling middleware (must be registered last, 4-arg signature).
 * Responses never contain stacks, SQL, DB details or user input. The full error is
 * logged server-side; the stack is included in logs only outside production.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const requestId = requestIdOf(res);
  const resolved = resolveError(err);
  const log = req.log ?? logger;

  const logged =
    err instanceof Error
      ? config.NODE_ENV === "production"
        ? { type: err.name, message: err.message }
        : err
      : { message: "non-error thrown" };
  if (resolved.status >= 500) {
    log.error({ err: logged, requestId }, "request failed");
  } else {
    log.warn({ err: { message: resolved.error }, requestId }, "request rejected");
  }

  if (res.headersSent) {
    next(err);
    return;
  }

  const body: ErrorBody = {
    success: false,
    error: resolved.error,
    ...(requestId ? { requestId } : {}),
    ...(resolved.details ? { details: resolved.details } : {}),
  };
  res.status(resolved.status).json(body);
}

/** 404 handler for unmatched routes; never echoes the query string. */
export function notFoundHandler(req: Request, res: Response): void {
  const safePath = req.path.replace(/[^A-Za-z0-9/_.:-]/g, "?").slice(0, 200);
  const requestId = requestIdOf(res);
  const body: ErrorBody = {
    success: false,
    error: `Route not found: ${req.method.replace(/[^A-Z]/g, "")} ${safePath}`,
    ...(requestId ? { requestId } : {}),
  };
  res.status(404).json(body);
}
