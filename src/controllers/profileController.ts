import type { NextFunction, Request, Response } from "express";
import { AppError } from "../errors.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import { findProfile, saveProfile } from "../profiles/profileRepository.js";
import type { ProfileBody } from "../schemas/profileSchemas.js";
import type { ApiResponse } from "../types/index.js";

export async function getMyProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const profile = await findProfile(req.user.id);
    res.status(200).json({ success: true, data: { profile, profileComplete: profile !== null } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function putMyProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const body = (res.locals["validated"] as ValidatedRequest).body as ProfileBody;
    const profile = await saveProfile(req.user.id, body, req.ip ?? null);
    res.status(200).json({ success: true, data: { profile, profileComplete: true } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}
