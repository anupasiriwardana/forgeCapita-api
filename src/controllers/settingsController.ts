import type { Request, Response } from "express";
import { config } from "../config/env.js";
import type { ApiResponse } from "../types/index.js";

export type FounderApprovalSetting = "auto" | "manual";

/** Public, non-secret feature settings the frontend adapts to. */
export function getSettings(_req: Request, res: Response): void {
  const founderApproval: FounderApprovalSetting = config.FOUNDER_APPROVAL === "AUTO" ? "auto" : "manual";
  res.status(200).json({ success: true, data: { founderApproval } } satisfies ApiResponse);
}
