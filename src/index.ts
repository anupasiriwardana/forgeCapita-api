import { config } from "./config/env.js";
import { createApp } from "./app.js";
import { initDb, pool } from "./db/pool.js";
import { logger } from "./logger.js";

const app = createApp();

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function boot(): Promise<void> {
  try {
    // Ensure startup_profiles table exists before accepting traffic
    await initDb();
  } catch (err) {
    logger.fatal({ err }, "Failed to initialise database");
    process.exit(1);
  }

  // Tests drive the app through supertest and must not bind a port.
  if (config.NODE_ENV === "test") return;

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, "forgeCapita API listening");
  });
  // Render's load balancer keeps idle connections for 60s; stay above that to
  // avoid sporadic 502s on reused connections. headersTimeout must exceed it.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

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
      pool
        .end()
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
