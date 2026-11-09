import { Router, type RequestHandler } from "express";
import { requireAuth, requireSameOrigin } from "../auth/middleware.js";
import {
  getRequest,
  getStatus,
  listRequestsHandler,
  postClaim,
  postStake,
  postVote,
} from "../controllers/relayController.js";
import { validate } from "../middlewares/validate.js";
import {
  claimBodySchema,
  relayIdParamsSchema,
  relayListQuerySchema,
  stakeBodySchema,
  voteBodySchema,
} from "../schemas/relaySchemas.js";

function noStore(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  };
}

/** Gasless relay routes; ONE limiter instance guards every write route. */
export function createRelayRoutes(writeLimiter: RequestHandler): Router {
  const router = Router();
  router.use(noStore());

  router.get("/status", getStatus);
  router.get("/", requireAuth, validate({ query: relayListQuerySchema }), listRequestsHandler);
  router.get("/:id", requireAuth, validate({ params: relayIdParamsSchema }), getRequest);
  router.post("/claim", writeLimiter, requireSameOrigin, requireAuth, validate({ body: claimBodySchema }), postClaim);
  router.post("/vote", writeLimiter, requireSameOrigin, requireAuth, validate({ body: voteBodySchema }), postVote);
  router.post("/stake", writeLimiter, requireSameOrigin, requireAuth, validate({ body: stakeBodySchema }), postStake);

  return router;
}
