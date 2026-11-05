import { ipKeyGenerator, rateLimit, type RateLimitRequestHandler } from "express-rate-limit";
import type { Request, Response } from "express";

export interface LimiterOptions {
  windowMs: number;
  max: number;
  skip?: (req: Request) => boolean;
}

/**
 * Builds a per-IP rate limiter with the uniform 429 body.
 * Uses the default in-memory store, which is fine for a single instance; swap in
 * a shared store (e.g. Redis) before running more than one replica.
 */
export function createLimiter(opts: LimiterOptions): RateLimitRequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    ...(opts.skip ? { skip: opts.skip } : {}),
    keyGenerator: (req: Request): string => ipKeyGenerator(req.ip ?? "unknown"),
    handler: (_req: Request, res: Response): void => {
      res.status(429).json({ success: false, error: "Too many requests." });
    },
  });
}
