import type { NextFunction, Request, RequestHandler, Response } from "express";
import { config } from "../config/env.js";
import { AppError } from "../errors.js";
import type { Role } from "../types/index.js";
import { hasSessionCookie, readSessionToken, resolveSession } from "./session.js";

const allowedOrigins: ReadonlySet<string> = new Set(config.CORS_ORIGINS);
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** Attaches req.user when the request carries a valid session cookie; never rejects. */
export const loadSession: RequestHandler = async (req, _res, next) => {
  try {
    const token = readSessionToken(req.headers.cookie);
    if (token) {
      const user = await resolveSession(token);
      if (user) req.user = user;
    }
    next();
  } catch (err) {
    next(err);
  }
};

export const requireAuth: RequestHandler = (req, _res, next) => {
  next(req.user ? undefined : new AppError(401, "Authentication required"));
};

export function requireRole(...roles: Role[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new AppError(401, "Authentication required"));
      return;
    }
    next(roles.includes(req.user.role) ? undefined : new AppError(403, "Forbidden"));
  };
}

/** CSRF defence: a state-changing request with a session cookie must come from an allowed Origin. */
export const requireSameOrigin: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method) || !hasSessionCookie(req.headers.cookie)) {
    next();
    return;
  }
  const origin = req.headers.origin;
  next(
    origin !== undefined && allowedOrigins.has(origin)
      ? undefined
      : new AppError(403, "Origin not allowed")
  );
};
