import type { NextFunction, Request, Response } from "express";
import { AGREEMENT_VERSION, agreementMessageTemplate, loadAgreement } from "../founders/agreement.js";
import {
  findAcceptance,
  listOwnWallets,
  findShadowWalletById,
  listShadowWallets,
} from "../founders/founderRepository.js";
import type { ShadowWalletRecord } from "../founders/founderRepository.js";
import {
  acceptAgreement,
  approveWallet,
  launchEligibility,
  rejectWallet,
  requestShadowWallet,
} from "../founders/founderService.js";
import { AppError } from "../errors.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import type {
  AcceptAgreementBody,
  ApproveShadowWalletBody,
  ListShadowWalletsQuery,
  RejectShadowWalletBody,
  ShadowWalletBody,
  ShadowWalletIdParams,
} from "../schemas/founderSchemas.js";
import type { ApiResponse } from "../types/index.js";

function validatedOf<T>(res: Response, key: keyof ValidatedRequest): T {
  return (res.locals["validated"] as ValidatedRequest)[key] as T;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function toOwnerDto(w: ShadowWalletRecord): Record<string, unknown> {
  return { id: w.id, address: w.address, status: w.status, reviewNote: w.reviewNote };
}

function toStaffDto(w: ShadowWalletRecord): Record<string, unknown> {
  return {
    ...toOwnerDto(w),
    userId: w.userId,
    founderWallet: w.founderWallet,
    reviewedBy: w.reviewedBy,
    reviewedAt: iso(w.reviewedAt),
    createdAt: w.createdAt.toISOString(),
  };
}

export function getAgreement(_req: Request, res: Response, next: NextFunction): void {
  try {
    const { text, textHash } = loadAgreement();
    res.status(200).json({
      success: true,
      data: { version: AGREEMENT_VERSION, textHash, text, messageTemplate: agreementMessageTemplate() },
    } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function postAgreement(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const body = validatedOf<AcceptAgreementBody>(res, "body");
    const accepted = await acceptAgreement(req.user, body, req.ip ?? null);
    res.status(201).json({
      success: true,
      data: { version: accepted.version, textHash: accepted.textHash, acceptedAt: accepted.acceptedAt.toISOString() },
    } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function postShadowWallet(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const { address } = validatedOf<ShadowWalletBody>(res, "body");
    const wallet = await requestShadowWallet(req.user, address, req.ip ?? null);
    res.status(201).json({ success: true, data: { shadowWallet: toOwnerDto(wallet) } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function getMe(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const [acceptance, wallets] = await Promise.all([
      findAcceptance(req.user.id, AGREEMENT_VERSION),
      listOwnWallets(req.user.id),
    ]);
    res.status(200).json({
      success: true,
      data: {
        agreement: acceptance
          ? { version: acceptance.version, acceptedAt: acceptance.acceptedAt.toISOString() }
          : null,
        wallets: wallets.map((w) => ({
          id: w.id,
          address: w.address,
          status: w.status,
          reviewNote: w.reviewNote,
          projectId: w.projectId,
          reserved: w.reserved,
        })),
      },
    } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function getLaunchEligibility(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    res.status(200).json({ success: true, data: await launchEligibility(req.user) } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function getShadowWallets(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { status, limit, offset } = validatedOf<ListShadowWalletsQuery>(res, "query");
    const { items, total } = await listShadowWallets(status, limit, offset);
    res.status(200).json({
      success: true,
      data: { items: items.map(toStaffDto), total, limit, offset },
    } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

async function respondWithWallet(res: Response, id: string): Promise<void> {
  const wallet = await findShadowWalletById(id);
  if (!wallet) throw new AppError(404, "Not found");
  res.status(200).json({ success: true, data: { shadowWallet: toStaffDto(wallet) } } satisfies ApiResponse);
}

export async function postApproveWallet(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const { id } = validatedOf<ShadowWalletIdParams>(res, "params");
    const { note } = validatedOf<ApproveShadowWalletBody>(res, "body");
    await approveWallet(req.user, id, note, req.ip ?? null);
    await respondWithWallet(res, id);
  } catch (err) {
    next(err);
  }
}

export async function postRejectWallet(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const { id } = validatedOf<ShadowWalletIdParams>(res, "params");
    const { note } = validatedOf<RejectShadowWalletBody>(res, "body");
    await rejectWallet(req.user, id, note, req.ip ?? null);
    await respondWithWallet(res, id);
  } catch (err) {
    next(err);
  }
}
