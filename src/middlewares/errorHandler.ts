import type { Request, Response, NextFunction } from "express";

interface HttpError extends Error {
  status?: number;
  statusCode?: number;
}

/**
 * Global error-handling middleware.
 * Must be registered LAST in the Express middleware chain (4-arg signature).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: HttpError,
  _req: Request,
  res: Response,
  // next is required for Express to recognise this as an error handler
  _next: NextFunction
): void {
  const statusCode = err.status ?? err.statusCode ?? 500;
  const message =
    statusCode === 500
      ? "Internal server error"
      : err.message ?? "An unexpected error occurred";

  console.error(`[ERROR] ${statusCode} — ${err.message ?? "Unknown error"}`);

  res.status(statusCode).json({
    success: false,
    error: message,
  });
}

/**
 * 404 handler — catches routes that don't match any defined route.
 */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.originalUrl}`,
  });
}
