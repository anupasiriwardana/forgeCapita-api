import type { NextFunction, Request, Response } from "express";
import { listOwnDrafts, type DraftRecord } from "../drafts/draftRepository.js";
import { attachDraft, cancelDraft, createDraft } from "../drafts/draftService.js";
import { AppError } from "../errors.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import type { AttachDraftBody, CreateDraftBody, DraftIdParams } from "../schemas/draftSchemas.js";
import type { ApiResponse } from "../types/index.js";

function validatedOf<T>(res: Response, key: keyof ValidatedRequest): T {
  return (res.locals["validated"] as ValidatedRequest)[key] as T;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function toCreatedDto(d: DraftRecord): Record<string, unknown> {
  return {
    id: d.id,
    status: d.status,
    chainId: d.chainId,
    shadowWalletId: d.founderWalletId,
    createdAt: d.createdAt.toISOString(),
  };
}

function toDraftDto(d: DraftRecord): Record<string, unknown> {
  return {
    ...toCreatedDto(d),
    projectId: d.projectId,
    escrowAddress: d.escrowAddress,
    appliedAt: iso(d.appliedAt),
  };
}

function toListDto(d: DraftRecord): Record<string, unknown> {
  return {
    id: d.id,
    status: d.status,
    chainId: d.chainId,
    projectId: d.projectId,
    escrowAddress: d.escrowAddress,
    name: d.name,
    createdAt: d.createdAt.toISOString(),
    appliedAt: iso(d.appliedAt),
  };
}

export async function postDraft(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const draft = await createDraft(validatedOf<CreateDraftBody>(res, "body"), req.user, req.ip ?? null);
    res.status(201).json({ success: true, data: { draft: toCreatedDto(draft) } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function postAttach(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const { id } = validatedOf<DraftIdParams>(res, "params");
    const { escrowAddress } = validatedOf<AttachDraftBody>(res, "body");
    const draft = await attachDraft(id, escrowAddress, req.user);
    res.status(200).json({ success: true, data: { draft: toDraftDto(draft) } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function postCancel(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const { id } = validatedOf<DraftIdParams>(res, "params");
    const draft = await cancelDraft(id, req.user, req.ip ?? null);
    res.status(200).json({ success: true, data: { draft: toDraftDto(draft) } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function getMyDrafts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const drafts = await listOwnDrafts(req.user.id);
    res.status(200).json({ success: true, data: { items: drafts.map(toListDto) } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}
