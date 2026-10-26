// controllers/paymasterController.ts
import type { Request, Response, NextFunction } from "express";
import { generateGasDebtSignature } from "../services/paymasterService.js";
import type { PaymasterRequestBody, ApiResponse } from "../types/index.js";

export async function signMilestoneExecution(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
        const { escrowAddress, milestoneIndex, chainId, gasDebt } = req.body as PaymasterRequestBody;

        if (!escrowAddress || milestoneIndex === undefined || !chainId || !gasDebt) {
            res.status(400).json({ success: false, error: "Missing required payload parameters" } satisfies ApiResponse);
            return;
        }

        // Note: Here you would ideally calculate actual gas debt dynamically from your DB 
        // before signing, rather than blindly trusting the client's requested gasDebt.

        const signature = await generateGasDebtSignature(escrowAddress, milestoneIndex, chainId, gasDebt);

        res.status(200).json({ success: true, data: { signature, gasDebt } } satisfies ApiResponse);
    } catch (err) {
        next(err);
    }
}