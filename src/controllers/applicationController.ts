import type { NextFunction, Request, Response } from "express";
import {
  findApplicationById,
  findLatestApplicationByUser,
  listApplications,
} from "../applications/applicationRepository.js";
import { approve, reject, submitApplication } from "../applications/applicationService.js";
import type { ApplicationRecord } from "../applications/applicationTypes.js";
import { AppError } from "../errors.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import type {
  ApplicationIdParams,
  ApproveBody,
  CreateApplicationBody,
  ListApplicationsQuery,
  RejectBody,
} from "../schemas/applicationSchemas.js";
import type { ApiResponse } from "../types/index.js";

function validatedOf<T>(res: Response, key: keyof ValidatedRequest): T {
  return (res.locals["validated"] as ValidatedRequest)[key] as T;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/** Shape for the applicant (includes their own contact; no reviewer identity). */
function toOwnerDto(a: ApplicationRecord): Record<string, unknown> {
  return {
    id: a.id,
    walletAddress: a.walletAddress,
    projectName: a.projectName,
    summary: a.summary,
    websiteUrl: a.websiteUrl,
    pitchDeckUrl: a.pitchDeckUrl,
    repoUrl: a.repoUrl,
    contact: a.contact,
    status: a.status,
    reviewNote: a.reviewNote,
    reviewedAt: iso(a.reviewedAt),
    kycVerifiedAt: iso(a.kycVerifiedAt),
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

/** Shape for staff/admin: the owner shape plus user and reviewer ids. */
function toStaffDto(a: ApplicationRecord): Record<string, unknown> {
  return { ...toOwnerDto(a), userId: a.userId, reviewedBy: a.reviewedBy, kycVerifiedBy: a.kycVerifiedBy };
}

export async function postApplication(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const body = validatedOf<CreateApplicationBody>(res, "body");
    const application = await submitApplication(req.user, {
      projectName: body.projectName,
      summary: body.summary,
      websiteUrl: body.websiteUrl,
      pitchDeckUrl: body.pitchDeckUrl,
      repoUrl: body.repoUrl,
      contact: body.contact,
    });
    res.status(201).json({ success: true, data: { application: toOwnerDto(application) } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function getMyApplication(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const application = await findLatestApplicationByUser(req.user.id);
    res.status(200).json({
      success: true,
      data: { application: application ? toOwnerDto(application) : null },
    } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function getApplications(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { status, limit, offset } = validatedOf<ListApplicationsQuery>(res, "query");
    const { items, total } = await listApplications(status, limit, offset);
    res.status(200).json({
      success: true,
      data: { items: items.map(toStaffDto), total, limit, offset },
    } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function getApplication(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = validatedOf<ApplicationIdParams>(res, "params");
    const application = await findApplicationById(id);
    if (!application) throw new AppError(404, "Not found");
    res.status(200).json({ success: true, data: { application: toStaffDto(application) } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

async function respondWithApplication(res: Response, id: string): Promise<void> {
  const application = await findApplicationById(id);
  if (!application) throw new AppError(404, "Not found");
  res.status(200).json({ success: true, data: { application: toStaffDto(application) } } satisfies ApiResponse);
}

export async function postApprove(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const { id } = validatedOf<ApplicationIdParams>(res, "params");
    const { note } = validatedOf<ApproveBody>(res, "body");
    await approve(req.user, id, note, req.ip ?? null);
    await respondWithApplication(res, id);
  } catch (err) {
    next(err);
  }
}

export async function postReject(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const { id } = validatedOf<ApplicationIdParams>(res, "params");
    const { note } = validatedOf<RejectBody>(res, "body");
    await reject(req.user, id, note, req.ip ?? null);
    await respondWithApplication(res, id);
  } catch (err) {
    next(err);
  }
}
