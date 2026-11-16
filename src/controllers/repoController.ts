import type { NextFunction, Request, Response } from "express";
import { AppError } from "../errors.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import { findLatestRepo, listRepos, type RepoRecord } from "../repos/repoRepository.js";
import { provisionRepo, revokeRepoAccess } from "../repos/repoService.js";
import type { AdminReposQuery, ProvisionRepoBody, RevokeRepoParams } from "../schemas/repoSchemas.js";
import type { ApiResponse } from "../types/index.js";

function validatedOf<T>(res: Response, key: keyof ValidatedRequest): T {
  return (res.locals["validated"] as ValidatedRequest)[key] as T;
}

function toOwnerDto(r: RepoRecord): Record<string, unknown> {
  return {
    fullName: r.fullName,
    htmlUrl: r.htmlUrl,
    founderLogin: r.founderLogin,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
  };
}

function toStaffDto(r: RepoRecord): Record<string, unknown> {
  return {
    ...toOwnerDto(r),
    userId: r.userId,
    founderWallet: r.founderWallet,
    projectId: r.projectId,
    revokedAt: r.revokedAt === null ? null : r.revokedAt.toISOString(),
  };
}

export async function postRevokeRepo(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const { id } = validatedOf<RevokeRepoParams>(res, "params");
    const repo = await revokeRepoAccess(id, req.user.id, req.ip ?? null);
    res.status(200).json({ success: true, data: { repo: { id: repo.id, ...toStaffDto(repo) } } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function postOwnRepo(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const body = validatedOf<ProvisionRepoBody>(res, "body");
    const { repo, created } = await provisionRepo(req.user, body, req.ip ?? null);
    res.status(created ? 201 : 200).json({ success: true, data: { repo: toOwnerDto(repo) } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function getOwnRepo(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const repo = await findLatestRepo(req.user.id);
    if (!repo) throw new AppError(404, "Not found");
    res.status(200).json({ success: true, data: { repo: toOwnerDto(repo) } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function getAdminRepos(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId, limit, offset } = validatedOf<AdminReposQuery>(res, "query");
    const { items, total } = await listRepos(userId, limit, offset);
    res.status(200).json({
      success: true,
      data: { items: items.map(toStaffDto), total, limit, offset },
    } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}
