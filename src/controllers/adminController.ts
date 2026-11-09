import type { NextFunction, Request, Response } from "express";
import { listCasesForAdmin } from "../audit/complianceRepository.js";
import { listCursorsForProject, listInflowsForAdmin } from "../audit/inflowRepository.js";
import { changeUserRole } from "../auth/adminService.js";
import { listAuditPage } from "../auth/auditRepository.js";
import { listUsers } from "../auth/authRepository.js";
import { listDraftsForAdmin } from "../drafts/draftRepository.js";
import { AppError } from "../errors.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import { listRelayRequestsForAdmin } from "../relay/relayRepository.js";
import type {
  AuditLogQuery,
  ComplianceQuery,
  InflowsQuery,
  LaunchDraftsQuery,
  ListUsersQuery,
  RelayRequestsQuery,
  RoleBody,
  RoleParams,
} from "../schemas/adminSchemas.js";
import type { ApiResponse } from "../types/index.js";

function validatedOf<T>(res: Response, key: keyof ValidatedRequest): T {
  return (res.locals["validated"] as ValidatedRequest)[key] as T;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/** Decimal string of a wei amount with 18 decimals and no trailing zeros ("1.5", "0.000001"). */
export function formatWei(wei: bigint): string {
  const unit = 10n ** 18n;
  const fraction = (wei % unit).toString().padStart(18, "0").replace(/0+$/, "");
  const whole = (wei / unit).toString();
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

export async function getAuditLog(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { limit, offset, action, target, actor } = validatedOf<AuditLogQuery>(res, "query");
    const { items, total } = await listAuditPage({ action, target, actor, limit, offset });
    res.status(200).json({
      success: true,
      data: {
        items: items.map((e) => ({
          id: e.id,
          actorUserId: e.actorUserId,
          action: e.action,
          target: e.target,
          before: e.beforeValue,
          after: e.afterValue,
          ip: e.ip,
          createdAt: e.createdAt.toISOString(),
        })),
        total,
        limit,
        offset,
      },
    } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function getLaunchDrafts(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { limit, offset, status, userId, chainId } = validatedOf<LaunchDraftsQuery>(res, "query");
    const { items, total } = await listDraftsForAdmin({ status, userId, chainId, limit, offset });
    res.status(200).json({
      success: true,
      data: {
        items: items.map((d) => ({
          id: d.id,
          userId: d.userId,
          walletAddress: d.walletAddress,
          status: d.status,
          chainId: d.chainId,
          founderWalletId: d.founderWalletId,
          escrowAddress: d.escrowAddress,
          projectId: d.projectId,
          name: d.name,
          createdAt: d.createdAt.toISOString(),
          appliedAt: iso(d.appliedAt),
        })),
        total,
        limit,
        offset,
      },
    } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function getRelayRequests(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { limit, offset, kind, status, chainId, system, projectId } = validatedOf<RelayRequestsQuery>(
      res,
      "query"
    );
    const { items, total } = await listRelayRequestsForAdmin({
      kind,
      status,
      chainId,
      system,
      projectId,
      limit,
      offset,
    });
    res.status(200).json({
      success: true,
      data: {
        items: items.map((r) => ({
          id: r.id,
          kind: r.kind,
          chainId: r.chainId,
          projectId: r.projectId,
          userId: r.userId,
          account: r.account,
          status: r.status,
          errorCode: r.errorCode,
          errorMessage: r.errorMessage,
          txHash: r.txHash,
          gasUsed: r.gasUsed,
          effectiveGasPrice: r.effectiveGasPrice,
          createdAt: r.createdAt.toISOString(),
          sentAt: iso(r.sentAt),
          confirmedAt: iso(r.confirmedAt),
          expiresAt: r.expiresAt.toISOString(),
        })),
        total,
        limit,
        offset,
      },
    } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function getInflows(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { limit, offset, chainId, projectId, kind } = validatedOf<InflowsQuery>(res, "query");
    const { items, total } = await listInflowsForAdmin({ chainId, projectId, kind, limit, offset });
    const cursors = projectId === undefined ? undefined : await listCursorsForProject(projectId);
    res.status(200).json({
      success: true,
      data: {
        items: items.map((r) => ({
          ...r,
          amountFormatted: r.kind === "erc20" ? null : formatWei(BigInt(r.amount)),
          firstSeenAt: r.firstSeenAt.toISOString(),
        })),
        total,
        limit,
        offset,
        ...(cursors !== undefined && {
          cursors: cursors.map((c) => ({
            kind: c.kind,
            lastBlock: c.lastBlock,
            lastPolledAt: iso(c.lastPolledAt),
            lastError: c.lastError,
          })),
        }),
      },
    } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function getCompliance(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { limit, offset, state, chainId } = validatedOf<ComplianceQuery>(res, "query");
    const { items, total } = await listCasesForAdmin({ state, chainId, limit, offset });
    res.status(200).json({
      success: true,
      data: {
        items: items.map((c) => ({
          id: c.id,
          projectId: c.projectId,
          chainId: c.chainId,
          state: c.state,
          openedAt: c.openedAt.toISOString(),
          stateChangedAt: c.stateChangedAt.toISOString(),
          escalatedAt: iso(c.escalatedAt),
          resolvedAt: iso(c.resolvedAt),
          resolutionNote: c.resolutionNote,
          lastCheckedAt: iso(c.lastCheckedAt),
          observedNative: c.inflowWei,
          routedNative: c.routedWei,
          shortfallBps: c.shortfallBps,
          windowStart: iso(c.windowStart),
          windowEnd: iso(c.windowEnd),
        })),
        total,
        limit,
        offset,
      },
    } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function patchUserRole(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const { address } = validatedOf<RoleParams>(res, "params");
    const { role } = validatedOf<RoleBody>(res, "body");
    const user = await changeUserRole(req.user, address, role, req.ip ?? null);
    res.status(200).json({ success: true, data: { user } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function getUsers(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { limit, offset, role, q } = validatedOf<ListUsersQuery>(res, "query");
    const { items, total } = await listUsers({ role, addressPrefix: q, limit, offset });
    res.status(200).json({
      success: true,
      data: {
        items: items.map((u) => ({
          id: u.id,
          address: u.address,
          role: u.role,
          createdAt: u.createdAt.toISOString(),
          lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
        })),
        total,
        limit,
        offset,
      },
    } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}
