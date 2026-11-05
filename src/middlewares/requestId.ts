import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Resolves the request id: a well-formed incoming x-request-id, else a new UUID. */
export function resolveRequestId(incoming: unknown): string {
  return typeof incoming === "string" && VALID_REQUEST_ID.test(incoming)
    ? incoming
    : randomUUID();
}

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = resolveRequestId(req.headers["x-request-id"]);
  res.locals["requestId"] = id;
  res.setHeader("X-Request-Id", id);
  next();
}
