import { Router, type RequestHandler } from "express";
import { requireAuth, requireSameOrigin } from "../auth/middleware.js";
import {
  getCaseByProject,
  getMyCases,
  getTally,
  postAcceptCase,
  postVote,
} from "../controllers/takeoverController.js";
import { validate } from "../middlewares/validate.js";
import { acceptBodySchema, byProjectParamsSchema, caseIdParamsSchema, voteBodySchema } from "../takeover/takeoverSchemas.js";

/**
 * Takeover reads (public tally and status), the candidate's own cases and the two signed writes
 * (candidate acceptance, vote). ONE limiter instance guards both writes. /mine and /by-project are
 * registered before the /:id routes.
 */
export function createTakeoverRoutes(writeLimiter: RequestHandler): Router {
  const router = Router();
  router.get("/mine", requireAuth, getMyCases);
  router.get("/by-project/:chainId/:address", validate({ params: byProjectParamsSchema }), getCaseByProject);
  router.get("/:id/tally", validate({ params: caseIdParamsSchema }), getTally);
  router.post(
    "/:id/accept",
    writeLimiter,
    requireSameOrigin,
    requireAuth,
    validate({ params: caseIdParamsSchema, body: acceptBodySchema }),
    postAcceptCase
  );
  router.post(
    "/:id/vote",
    writeLimiter,
    requireSameOrigin,
    requireAuth,
    validate({ params: caseIdParamsSchema, body: voteBodySchema }),
    postVote
  );
  return router;
}
