import { Router, type RequestHandler } from "express";
import {
  createOrUpdateProfile,
  getProject,
  getProjects,
} from "../controllers/projectController.js";
import { requireAuth, requireSameOrigin } from "../auth/middleware.js";
import { validate } from "../middlewares/validate.js";
import {
  listProjectsQuerySchema,
  profileBodySchema,
  projectIdParamsSchema,
} from "../schemas/projectSchemas.js";

/** Builds the project router; the stricter write limiter is injected by createApp. */
export function createProjectRoutes(profileLimiter: RequestHandler): Router {
  const router = Router();

  /**
   * POST /api/projects/profile
   * Must be declared BEFORE the /:projectId wildcard to avoid route shadowing.
   * Requires a session; the service enforces developer ownership (or staff/admin).
   */
  router.post(
    "/profile",
    profileLimiter,
    requireSameOrigin,
    requireAuth,
    validate({ body: profileBodySchema }),
    createOrUpdateProfile
  );

  /** GET /api/projects */
  router.get("/", validate({ query: listProjectsQuerySchema }), getProjects);

  /** GET /api/projects/:projectId */
  router.get("/:projectId", validate({ params: projectIdParamsSchema }), getProject);

  return router;
}
