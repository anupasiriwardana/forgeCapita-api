import { Router, type RequestHandler } from "express";
import { requireAuth, requireSameOrigin } from "../auth/middleware.js";
import { getMyComplaints, postComplaint } from "../controllers/complaintController.js";
import { validate } from "../middlewares/validate.js";
import { createComplaintBodySchema } from "../schemas/complaintSchemas.js";

/** Investor complaint routes; ONE limiter instance guards the write route. */
export function createComplaintRoutes(writeLimiter: RequestHandler): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get("/mine", requireAuth, getMyComplaints);
  router.post("/", writeLimiter, requireSameOrigin, requireAuth, validate({ body: createComplaintBodySchema }), postComplaint);

  return router;
}
