import { Router, type RequestHandler } from "express";
import { requireAuth, requireRole, requireSameOrigin } from "../auth/middleware.js";
import { getMyDrafts, postAttach, postCancel, postDraft } from "../controllers/draftController.js";
import { validate } from "../middlewares/validate.js";
import { attachDraftBodySchema, createDraftBodySchema, draftIdParamsSchema } from "../schemas/draftSchemas.js";

function noStore(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  };
}

/** Launch draft routes; ONE limiter instance guards every write route. */
export function createDraftRoutes(writeLimiter: RequestHandler): Router {
  const router = Router();
  router.use(noStore());

  router.get("/mine", requireAuth, getMyDrafts);
  router.post(
    "/",
    writeLimiter,
    requireSameOrigin,
    requireAuth,
    requireRole("founder", "staff", "admin"),
    validate({ body: createDraftBodySchema }),
    postDraft
  );
  router.post(
    "/:id/attach",
    writeLimiter,
    requireSameOrigin,
    requireAuth,
    requireRole("founder", "staff", "admin"),
    validate({ params: draftIdParamsSchema, body: attachDraftBodySchema }),
    postAttach
  );
  router.post(
    "/:id/cancel",
    writeLimiter,
    requireSameOrigin,
    requireAuth,
    requireRole("founder", "staff", "admin"),
    validate({ params: draftIdParamsSchema }),
    postCancel
  );

  return router;
}
