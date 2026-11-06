import { Router, type RequestHandler } from "express";
import { requireAuth, requireRole, requireSameOrigin } from "../auth/middleware.js";
import { getUsers, patchUserRole } from "../controllers/adminController.js";
import { validate } from "../middlewares/validate.js";
import {
  listUsersQuerySchema,
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
