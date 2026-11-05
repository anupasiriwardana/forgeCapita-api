import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { ZodType } from "zod";

interface ValidationSchemas {
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
}

export interface ValidatedRequest {
  params?: unknown;
  query?: unknown;
  body?: unknown;
}

/**
 * Validates params, query and body with zod. Parsed (stripped, trimmed) values are
 * stored in res.locals.validated; req.query is never assigned (read-only in Express 5).
 * A failure is forwarded as a ZodError to the central error handler.
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const validated: ValidatedRequest = {};
    for (const key of ["params", "query", "body"] as const) {
      const schema = schemas[key];
      if (!schema) continue;
      const result = schema.safeParse(req[key]);
      if (!result.success) {
        next(result.error);
        return;
      }
      validated[key] = result.data;
    }
    res.locals["validated"] = validated;
    next();
  };
}
