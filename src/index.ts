import { config } from "./config/env.js";
import { createApp } from "./app.js";
import { resolve } from "node:path";
import { MigrationError, verifyMigrationsApplied } from "./db/migrationRunner.js";
import { pool } from "./db/pool.js";
import { logger } from "./logger.js";
import { initRelay } from "./relay/chains.js";
import { startRelayWorker } from "./relay/relayWorker.js";
import { startMilestoneAutoExec } from "./relay/milestoneAutoExec.js";
import { startReconcileJob } from "./drafts/reconcile.js";
import { toLoggableError } from "./middlewares/errorHandler.js";

const app = createApp();

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function boot(): Promise<void> {
  // Tests drive the app through supertest and must not bind a port.
  if (config.NODE_ENV === "test") return;

  try {
    // Read-only: the schema is changed only by `npm run migrate`.
    await verifyMigrationsApplied(pool, resolve(process.cwd(), "migrations"));
  } catch (err) {
    if (err instanceof MigrationError) {
      logger.fatal("Database migrations are not applied. Run: npm run migrate");
    } else {
      logger.fatal({ err: toLoggableError(err) }, "Failed to verify database migrations");
    }
    process.exit(1);
  }

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, "forgeCapita API listening");
  });
  // Render's load balancer keeps idle connections for 60s; stay above that to
  // avoid sporadic 502s on reused connections. headersTimeout must exceed it.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  const stopReconcile = startReconcileJob();

  // Gasless relayer: never throws; stays disabled (routes answer RELAY_DISABLED) unless the
  // env enables it and a chain passes its startup checks. Logs the relayer ADDRESS only.
  await initRelay();
  const stopRelay = startRelayWorker();
  // Only runs with MILESTONE_AUTOMATIC_EXECUTION=true and an enabled relayer chain.
  const stopAutoExec = startMilestoneAutoExec();

  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "Unhandled promise rejection");
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception");
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down");
    setTimeout(() => {
      logger.fatal("Shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    server.close((closeErr) => {
      if (closeErr) logger.error({ err: closeErr }, "Error closing HTTP server");
      Promise.all([
        stopReconcile ? stopReconcile() : undefined,
        stopRelay ? stopRelay() : undefined,
        stopAutoExec ? stopAutoExec() : undefined,
      ])
        .then(() => pool.end())
        .then(() => process.exit(0))
        .catch((err: unknown) => {
          logger.error({ err }, "Error closing database pool");
          process.exit(1);
        });
    });
    server.closeIdleConnections();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

void boot();

// Export app for supertest (tests import this without binding a port)
export default app;
