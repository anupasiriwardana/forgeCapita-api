import { Router, type RequestHandler } from "express";
import { requireAuth, requireRole, requireSameOrigin } from "../auth/middleware.js";
import {
  getAgreement,
  getLaunchEligibility,
  getMe,
  getShadowWallets,
  postAgreement,
  postApproveWallet,
  postRejectWallet,
  postShadowWallet,
} from "../controllers/founderController.js";
import { validate } from "../middlewares/validate.js";
import {
  acceptAgreementBodySchema,
  approveShadowWalletBodySchema,
  listShadowWalletsQuerySchema,
  rejectShadowWalletBodySchema,
  shadowWalletBodySchema,
  shadowWalletIdParamsSchema,
} from "../schemas/founderSchemas.js";

function noStore(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  };
}

/** Public agreement text. */
export function createAgreementRoutes(): Router {
  const router = Router();
  router.use(noStore());
  router.get("/", getAgreement);
  return router;
}

/** Founder routes; ONE limiter instance guards the write routes. */
export function createFounderRoutes(writeLimiter: RequestHandler): Router {
  const router = Router();
  router.use(noStore());

  router.post(
    "/me/agreement",
    writeLimiter,
    requireSameOrigin,
    requireAuth,
    requireRole("founder"),
    validate({ body: acceptAgreementBodySchema }),
    postAgreement
  );
  router.post(
    "/me/shadow-wallet",
    writeLimiter,
    requireSameOrigin,
    requireAuth,
    requireRole("founder"),
    validate({ body: shadowWalletBodySchema }),
    postShadowWallet
  );
  router.get("/me", requireAuth, requireRole("founder"), getMe);
  router.get("/me/launch-eligibility", requireAuth, getLaunchEligibility);

  return router;
}

/** Staff/admin shadow-wallet review routes; ONE limiter instance guards approve and reject. */
export function createAdminShadowWalletRoutes(reviewLimiter: RequestHandler): Router {
  const router = Router();
  router.use(noStore());

  router.get(
    "/",
    requireAuth,
    requireRole("admin", "staff"),
    validate({ query: listShadowWalletsQuerySchema }),
    getShadowWallets
  );
  router.post(
    "/:id/approve",
    reviewLimiter,
    requireSameOrigin,
    requireAuth,
    requireRole("admin", "staff"),
    validate({ params: shadowWalletIdParamsSchema, body: approveShadowWalletBodySchema }),
    postApproveWallet
  );
  router.post(
    "/:id/reject",
    reviewLimiter,
    requireSameOrigin,
    requireAuth,
    requireRole("admin", "staff"),
    validate({ params: shadowWalletIdParamsSchema, body: rejectShadowWalletBodySchema }),
    postRejectWallet
  );

  return router;
}
