import { Router } from "express";
import { databaseHealth, liveness } from "../controllers/healthController.js";

const router = Router();

/** GET /health - liveness only (exempt from the rate limiter). */
router.get("/", liveness);

/** GET /health/db - database connectivity (rate limited). */
router.get("/db", databaseHealth);

export default router;
