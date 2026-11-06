import { Router, type RequestHandler } from "express";
import { requireAuth, requireRole, requireSameOrigin } from "../auth/middleware.js";
import {
  getApplication,
  getApplications,
  getMyApplication,
  postApplication,
  postApprove,
  postReject,
} from "../controllers/applicationController.js";
import { validate } from "../middlewares/validate.js";
import {
  applicationIdParamsSchema,
  approveBodySchema,
  createApplicationBodySchema,
  listApplicationsQuerySchema,
  rejectBodySchema,
} from "../schemas/applicationSchemas.js";

function noStore(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  };
}

/** Applicant routes; ONE limiter instance guards the submit route. */
export function createApplicationRoutes(writeLimiter: RequestHandler): Router {
  const router = Router();
  router.use(noStore());

  router.post(
    "/",
    writeLimiter,
    requireSameOrigin,
    requireAuth,
    requireRole("investor", "founder"),
    validate({ body: createApplicationBodySchema }),
    postApplication
  );
  router.get("/mine", requireAuth, getMyApplication);

  return router;
}

/** Staff/admin review routes; ONE limiter instance guards approve and reject. */
export function createAdminApplicationRoutes(reviewLimiter: RequestHandler): Router {
  const router = Router();
  router.use(noStore());

  router.get(
    "/",
    requireAuth,
    requireRole("admin", "staff"),
    validate({ query: listApplicationsQuerySchema }),
    getApplications
  );
  router.get(
    "/:id",
    requireAuth,
    requireRole("admin", "staff"),
    validate({ params: applicationIdParamsSchema }),
    getApplication
  );
  router.post(
    "/:id/approve",
    reviewLimiter,
    requireSameOrigin,
    requireAuth,
    requireRole("admin", "staff"),
    validate({ params: applicationIdParamsSchema, body: approveBodySchema }),
    postApprove
  );
  router.post(
    "/:id/reject",
    reviewLimiter,
    requireSameOrigin,
    requireAuth,
    requireRole("admin", "staff"),
    validate({ params: applicationIdParamsSchema, body: rejectBodySchema }),
    postReject
  );

  return router;
}
