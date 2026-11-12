import { Router, type RequestHandler } from "express";
import { getMinimumGoalHandler } from "../controllers/gasController.js";
import { validate } from "../middlewares/validate.js";
import { gasChainParamsSchema } from "../schemas/gasSchemas.js";

/** Public, read-only gas routes (GET only). */
export function createGasRoutes(readLimiter: RequestHandler): Router {
  const router = Router();
  router.get(
    "/:chainId/minimum-goal",
    readLimiter,
    (_req, res, next) => {
      res.setHeader("Cache-Control", "public, max-age=30");
      next();
    },
    validate({ params: gasChainParamsSchema }),
    getMinimumGoalHandler
  );
  return router;
}
