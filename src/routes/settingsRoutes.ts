import { Router } from "express";
import { getSettings } from "../controllers/settingsController.js";

/** Public, read-only settings (GET only; no session). */
export function createSettingsRoutes(): Router {
  const router = Router();
  router.get(
    "/",
    (_req, res, next) => {
      res.setHeader("Cache-Control", "public, max-age=30");
      next();
    },
    getSettings
  );
  return router;
}
