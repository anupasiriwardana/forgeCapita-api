import { Router, type RequestHandler } from "express";
import { requireAuth, requireSameOrigin } from "../auth/middleware.js";
import { getMyProfile, putMyProfile } from "../controllers/profileController.js";
import { validate } from "../middlewares/validate.js";
import { profileBodySchema } from "../schemas/profileSchemas.js";

/** The signed-in user's personal profile (PII); ONE limiter instance guards the write route. */
export function createUserProfileRoutes(writeLimiter: RequestHandler): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get("/me", requireAuth, getMyProfile);
  router.put("/me", writeLimiter, requireSameOrigin, requireAuth, validate({ body: profileBodySchema }), putMyProfile);

  return router;
}
