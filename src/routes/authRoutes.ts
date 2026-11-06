import { Router, type RequestHandler } from "express";
import { requireAuth, requireSameOrigin } from "../auth/middleware.js";
import { getMe, postLogout, postNonce, postVerify } from "../controllers/authController.js";
import { validate } from "../middlewares/validate.js";
import { nonceBodySchema, verifyBodySchema } from "../schemas/authSchemas.js";

/** Builds the auth router; ONE limiter instance is shared by /nonce and /verify. */
export function createAuthRoutes(authLimiter: RequestHandler): Router {
  const router = Router();

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.post("/nonce", authLimiter, validate({ body: nonceBodySchema }), postNonce);
  router.post("/verify", authLimiter, validate({ body: verifyBodySchema }), postVerify);
  router.get("/me", requireAuth, getMe);
  router.post("/logout", requireSameOrigin, postLogout);

  return router;
}
