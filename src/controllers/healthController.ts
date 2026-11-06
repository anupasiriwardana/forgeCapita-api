import { resolve } from "node:path";
import type { Request, Response } from "express";
import { verifyMigrationsApplied } from "../db/migrationRunner.js";
import { pool } from "../db/pool.js";
import { toLoggableError } from "../middlewares/errorHandler.js";
import { logger } from "../logger.js";
import type { ApiResponse } from "../types/index.js";

/**
 * GET /health
 * Pure liveness: the process is up. Never touches the database.
 */
export function liveness(_req: Request, res: Response): void {
  res.status(200).json({
    success: true,
    data: { status: "ok", uptime: process.uptime() },
  } satisfies ApiResponse);
}

/**
 * GET /health/db
 * Verifies that the DB pool can serve a query. The pool error is logged, never returned.
 */
export async function databaseHealth(req: Request, res: Response): Promise<void> {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({
      success: true,
      data: { status: "ok", database: "connected" },
    } satisfies ApiResponse);
  } catch (err) {
    (req.log ?? logger).error({ err: toLoggableError(err) }, "database health check failed");
    res.status(503).json({
      success: false,
      error: "Database unavailable",
    } satisfies ApiResponse);
  }
}

/**
 * GET /ready
 * Readiness: the DB is reachable and every migration is applied. The cause is logged, never returned.
 */
export async function readiness(req: Request, res: Response): Promise<void> {
  try {
    await verifyMigrationsApplied(pool, resolve(process.cwd(), "migrations"));
    res.status(200).json({ success: true, data: { status: "ready" } } satisfies ApiResponse);
  } catch (err) {
    (req.log ?? logger).error({ err: toLoggableError(err) }, "readiness check failed");
    res.status(503).json({ success: false, error: "Not ready" } satisfies ApiResponse);
  }
}
