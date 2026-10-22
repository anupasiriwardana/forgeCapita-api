import type { Request, Response, NextFunction } from "express";
import { pool } from "../db/pool.js";
import type { ApiResponse } from "../types/index.js";

/**
 * GET /health
 * Verifies that the server is up and the DB pool can accept connections.
 */
export async function healthCheck(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Quick round-trip query to verify the pool is alive
    await pool.query("SELECT 1");
    const body: ApiResponse = {
      success: true,
      data: { status: "API is running", database: "Connected" },
    };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}
