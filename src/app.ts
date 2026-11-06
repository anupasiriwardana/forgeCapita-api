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
import { readiness } from "./controllers/healthController.js";
import { openApiDocument } from "./openapi.js";
import healthRoutes from "./routes/healthRoutes.js";
import { loadSession } from "./auth/middleware.js";
import { createAdminRoutes } from "./routes/adminRoutes.js";
import { createAdminApplicationRoutes, createApplicationRoutes } from "./routes/applicationRoutes.js";
import { createAdminShadowWalletRoutes, createAgreementRoutes, createFounderRoutes } from "./routes/founderRoutes.js";
import { createAuthRoutes } from "./routes/authRoutes.js";
import { createDraftRoutes } from "./routes/draftRoutes.js";
import { createProjectRoutes } from "./routes/projectRoutes.js";

const allowedOrigins: ReadonlySet<string> = new Set(config.CORS_ORIGINS);

/** Liveness and readiness probes, with or without a trailing slash (exempt from limiting and request logs). */
const LIVENESS_PATH = /^\/(health|ready)\/?$/;

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

  // Exact-match allow-list. Credentials are enabled for the session cookie, which is safe
  // only because origins are never wildcarded; requests without an Origin (curl,
  // server-to-server) pass. State-changing cookie requests are also checked by requireSameOrigin.
  app.use(
    cors({
      origin: (origin, callback) => {
        if (origin === undefined) return callback(null, false);
        if (allowedOrigins.has(origin)) return callback(null, true);
        return callback(new CorsOriginError());
      },
      credentials: true,
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

  app.use(loadSession);

  app.use("/health", healthRoutes);
  app.get("/ready", readiness);

  if (config.NODE_ENV !== "production") {
    app.get("/api/v1/openapi.json", (_req: Request, res: Response) => {
      res.json(openApiDocument);
    });
  }

  // ONE limiter instance for /auth/nonce and /auth/verify.
  const authLimiter = createLimiter({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.AUTH_RATE_LIMIT_MAX,
  });
  app.use("/api/v1/auth", createAuthRoutes(authLimiter));

  // ONE limiter instance for the admin write route.
  const adminLimiter = createLimiter({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.PROFILE_RATE_LIMIT_MAX,
  });
  // Application routes mount before /admin so the longer path wins; each write route group has ONE limiter.
  const applicationLimiter = createLimiter({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.PROFILE_RATE_LIMIT_MAX,
  });
  const reviewLimiter = createLimiter({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.PROFILE_RATE_LIMIT_MAX,
  });
  app.use("/api/v1/applications", createApplicationRoutes(applicationLimiter));
  app.use("/api/v1/admin/applications", createAdminApplicationRoutes(reviewLimiter));
  const founderLimiter = createLimiter({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.PROFILE_RATE_LIMIT_MAX,
  });
  const draftLimiter = createLimiter({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.PROFILE_RATE_LIMIT_MAX,
  });
  app.use("/api/v1/launch-drafts", createDraftRoutes(draftLimiter));
  app.use("/api/v1/agreement", createAgreementRoutes());
  app.use("/api/v1/founders", createFounderRoutes(founderLimiter));
  app.use("/api/v1/admin/shadow-wallets", createAdminShadowWalletRoutes(reviewLimiter));
  app.use("/api/v1/admin", createAdminRoutes(adminLimiter));

  // /api/projects is a deprecated alias of /api/v1/projects. Both mounts share ONE profile limiter
  // instance, so the write limit cannot be doubled by alternating between the two paths.
  const profileLimiter = createLimiter({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.PROFILE_RATE_LIMIT_MAX,
  });
  for (const base of ["/api/v1/projects", "/api/projects"]) {
    app.use(base, createProjectRoutes(profileLimiter));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
