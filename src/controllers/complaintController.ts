import type { NextFunction, Request, Response } from "express";
import {
  changeComplaintStatus,
  createComplaint,
  listComplaintsForAdmin,
  listOwnComplaints,
  type AdminComplaint,
  type Complaint,
} from "../complaints/complaintRepository.js";
import { AppError } from "../errors.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import type {
  ComplaintIdParams,
  ComplaintsQuery,
  ComplaintStatusBody,
  CreateComplaintBody,
} from "../schemas/complaintSchemas.js";
import type { ApiResponse } from "../types/index.js";

/** Cap of the reporter's own list. */
const MY_LIST_LIMIT = 100;

function validatedOf<T>(res: Response, key: keyof ValidatedRequest): T {
  return (res.locals["validated"] as ValidatedRequest)[key] as T;
}

/** Reporter view: includes the staff note, never the reporter address or any staff identity. */
function toComplaintDto(c: Complaint): Record<string, unknown> {
  return {
    id: c.id,
    projectId: c.projectId,
    chainId: c.chainId,
    category: c.category,
    body: c.body,
    evidenceUrl: c.evidenceUrl,
    status: c.status,
    staffNote: c.staffNote,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    resolvedAt: c.resolvedAt ? c.resolvedAt.toISOString() : null,
  };
}

function toAdminDto(c: AdminComplaint): Record<string, unknown> {
  return { ...toComplaintDto(c), reporterAddress: c.reporterAddress };
}

export async function postComplaint(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const { projectId, category, body, evidenceUrl } = validatedOf<CreateComplaintBody>(res, "body");
    const result = await createComplaint(
      { projectId, category, body, evidenceUrl: evidenceUrl ?? null },
      req.user.id,
      req.ip ?? null
    );
    if (result.outcome === "project_not_found") throw new AppError(404, "Project not found");
    if (result.outcome === "rate_limited") throw new AppError(429, "Too many complaints in the last 24 hours");
    if (result.outcome === "duplicate") {
      throw new AppError(409, "You already have an active complaint of this category for this project");
    }
    res.status(201).json({ success: true, data: { complaint: toComplaintDto(result.complaint) } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function getMyComplaints(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const items = await listOwnComplaints(req.user.id, MY_LIST_LIMIT);
    res.status(200).json({ success: true, data: { items: items.map(toComplaintDto) } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function getAdminComplaints(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { limit, offset, status, projectId } = validatedOf<ComplaintsQuery>(res, "query");
    const { items, total } = await listComplaintsForAdmin({ status, projectId, limit, offset });
    res.status(200).json({
      success: true,
      data: { items: items.map(toAdminDto), total, limit, offset },
    } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function patchAdminComplaint(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const { id } = validatedOf<ComplaintIdParams>(res, "params");
    const { status, note } = validatedOf<ComplaintStatusBody>(res, "body");
    const result = await changeComplaintStatus(id, status, note ?? null, req.user.id, req.ip ?? null);
    if (result.outcome === "not_found") throw new AppError(404, "Not found");
    if (result.outcome === "invalid_transition") throw new AppError(409, "Status change not allowed from the current status");
    res.status(200).json({ success: true, data: { complaint: toAdminDto(result.complaint) } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}
