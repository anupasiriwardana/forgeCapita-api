import { Router } from "express";
import {
  createOrUpdateProfile,
  getProject,
  getProjects,
} from "../controllers/projectController.js";

const router = Router();

/**
 * POST /api/projects/profile
 * Must be declared BEFORE the /:projectId wildcard to avoid route shadowing.
 */
router.post("/profile", createOrUpdateProfile);

/**
 * GET /api/projects
 */
router.get("/", getProjects);

/**
 * GET /api/projects/:projectId
 */
router.get("/:projectId", getProject);

export default router;
