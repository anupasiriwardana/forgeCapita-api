import type { Request, Response, NextFunction } from "express";
import {
  upsertProfile,
  getProjectById,
  listProjects,
} from "../services/projectService.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import type {
  ListProjectsQuery,
  ProfileBody,
  ProjectIdParams,
} from "../schemas/projectSchemas.js";
import type { ApiResponse } from "../types/index.js";

function validatedOf(res: Response): ValidatedRequest {
  return res.locals["validated"] as ValidatedRequest;
}

// ─── POST /api/projects/profile ──────────────────────────────────────────────

export async function createOrUpdateProfile(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const saved = await upsertProfile(validatedOf(res).body as ProfileBody);

    res.status(201).json({
      success: true,
      message: "Profile saved",
      data: saved,
    } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

// ─── GET /api/projects/:projectId ────────────────────────────────────────────

export async function getProject(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { projectId } = validatedOf(res).params as ProjectIdParams;
    const project = await getProjectById(projectId);

    if (!project) {
      res.status(404).json({
        success: false,
        error: "Project not found.",
      } satisfies ApiResponse);
      return;
    }

    res.status(200).json({
      success: true,
      data: project,
    } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

// ─── GET /api/projects ───────────────────────────────────────────────────────

export async function getProjects(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const query = validatedOf(res).query as ListProjectsQuery;
    const data = await listProjects(query);
    res.status(200).json({ success: true, data } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}
