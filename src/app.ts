import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";

import { config } from "./config/env.js";
import { CorsOriginError } from "./errors.js";
import { logger } from "./logger.js";
import { errorHandler, notFoundHandler } from "./middlewares/errorHandler.js";
import { createLimiter } from "./middlewares/rateLimit.js";
import { requestId } from "./middlewares/requestId.js";
import healthRoutes from "./routes/healthRoutes.js";
import { createProjectRoutes } from "./routes/projectRoutes.js";

const allowedOrigins: ReadonlySet<string> = new Set(config.CORS_ORIGINS);

/** Liveness path with or without a trailing slash (Express strict routing is off). */
const LIVENESS_PATH = /^\/health\/?$/;

function requestPath(url: string | undefined): string {
  return (url ?? "").split("?")[0] ?? "";
}

/**
 * Builds the Express application without binding a port, so tests and the boot
 * file can share it.
 */
export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  // Number of trusted proxy hops (e.g. 1 behind Render); never `true`.
  app.set("trust proxy", config.TRUST_PROXY);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (_req, res) => (res as Response).locals["requestId"] as string,
      autoLogging: { ignore: (req) => LIVENESS_PATH.test(requestPath(req.url)) },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          path: requestPath(req.url),
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    })
  );

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      // HSTS only where TLS is terminated for real (production).
      strictTransportSecurity: config.NODE_ENV === "production",
    })
  );

  // Exact-match allow-list. Credentials stay disabled until cookie/session auth
  // exists (API-13); requests without an Origin (curl, server-to-server) pass.
  app.use(
    cors({
      origin: (origin, callback) => {
        if (origin === undefined) return callback(null, false);
        if (allowedOrigins.has(origin)) return callback(null, true);
        return callback(new CorsOriginError());
      },
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
      exposedHeaders: ["X-Request-Id", "RateLimit-Policy", "RateLimit"],
      maxAge: 600,
    })
  );

  app.use(
    createLimiter({
      windowMs: config.RATE_LIMIT_WINDOW_MS,
      max: config.RATE_LIMIT_MAX,
      skip: (req: Request) => LIVENESS_PATH.test(req.path),
    })
  );

  app.use(express.json({ limit: config.BODY_LIMIT, strict: true }));

  app.use("/health", healthRoutes);
  app.use(
    "/api/projects",
    createProjectRoutes(
      createLimiter({
        windowMs: config.RATE_LIMIT_WINDOW_MS,
        max: config.PROFILE_RATE_LIMIT_MAX,
      })
    )
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
