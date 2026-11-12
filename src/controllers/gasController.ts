import type { NextFunction, Request, Response } from "express";
import { config } from "../config/env.js";
import { getMinimumGoal, serializeMinimumGoal } from "../gas/minimumGoal.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import type { GasChainParams } from "../schemas/gasSchemas.js";
import type { ApiResponse } from "../types/index.js";

export async function getMinimumGoalHandler(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { chainId } = (res.locals["validated"] as ValidatedRequest).params as GasChainParams;
    const goal = await getMinimumGoal(chainId);
    res.status(200).json({
      success: true,
      data: serializeMinimumGoal(goal, config.MINIMUM_GOAL_MODE),
    } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}
