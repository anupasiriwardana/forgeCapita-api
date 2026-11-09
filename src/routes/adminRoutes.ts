import { Router, type RequestHandler } from "express";
import { requireAuth, requireRole, requireSameOrigin } from "../auth/middleware.js";
import {
  getAuditLog,
  getInflows,
  getLaunchDrafts,
  getRelayRequests,
  getUsers,
  patchUserRole,
} from "../controllers/adminController.js";
import { validate } from "../middlewares/validate.js";
import {
  auditLogQuerySchema,
  inflowsQuerySchema,
  launchDraftsQuerySchema,
  listUsersQuerySchema,
  relayRequestsQuerySchema,
  roleBodySchema,
  roleParamsSchema,
} from "../schemas/adminSchemas.js";

/** Builds the admin router; ONE limiter instance guards the role-change write route. */
export function createAdminRoutes(writeLimiter: RequestHandler): Router {
  const router = Router();

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get(
    "/users",
    requireAuth,
    requireRole("admin", "staff"),
    validate({ query: listUsersQuerySchema }),
    getUsers
  );
  router.get(
    "/audit-log",
    requireAuth,
    requireRole("admin", "staff"),
    validate({ query: auditLogQuerySchema }),
    getAuditLog
  );
  router.get(
    "/launch-drafts",
    requireAuth,
    requireRole("admin", "staff"),
    validate({ query: launchDraftsQuerySchema }),
    getLaunchDrafts
  );
  router.get(
    "/relay-requests",
    requireAuth,
    requireRole("admin", "staff"),
    validate({ query: relayRequestsQuerySchema }),
    getRelayRequests
  );
  router.get(
    "/inflows",
    requireAuth,
    requireRole("admin", "staff"),
    validate({ query: inflowsQuerySchema }),
    getInflows
  );
  router.patch(
    "/users/:address/role",
    writeLimiter,
    requireSameOrigin,
    requireAuth,
    requireRole("admin"),
    validate({ params: roleParamsSchema, body: roleBodySchema }),
    patchUserRole
  );

  return router;
}
