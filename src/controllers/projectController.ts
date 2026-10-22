import type { Request, Response, NextFunction } from "express";
import {
  upsertProfile,
  getProjectById,
  getAllProjects,
} from "../services/projectService.js";
import type { CreateProfileBody, ApiResponse } from "../types/index.js";

// ─── POST /api/projects/profile ──────────────────────────────────────────────

export async function createOrUpdateProfile(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const body = req.body as CreateProfileBody;
    const { projectId, name, description } = body;

    // Basic required-field guard
    if (!projectId || !name || !description) {
      res.status(400).json({
        success: false,
        error: "projectId, name, and description are required.",
      } satisfies ApiResponse);
      return;
    }

    const saved = await upsertProfile(body);

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
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { projectId } = req.params as { projectId: string };
    const project = await getProjectById(projectId);

    if (!project) {
      res.status(404).json({
        success: false,
        error: `Project with id '${projectId}' not found.`,
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
    const projects = await getAllProjects();
    res.status(200).json({
      success: true,
      data: projects,
    } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}
