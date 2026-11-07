import type { NextFunction, Request, Response } from "express";
import { AppError } from "../errors.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import { RelayError } from "../relay/relayErrors.js";
import type { RelayRecord } from "../relay/relayRepository.js";
import {
  getOwnRequest,
  listRequests,
  submitClaim,
  submitStake,
  submitVote,
  type IntakeResult,
} from "../relay/relayService.js";
import type {
  ClaimBody,
  RelayIdParams,
  RelayListQuery,
  StakeBody,
  VoteBody,
} from "../schemas/relaySchemas.js";
import type { ApiResponse } from "../types/index.js";

function validatedOf<T>(res: Response, key: keyof ValidatedRequest): T {
  return (res.locals["validated"] as ValidatedRequest)[key] as T;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/** Never includes the calldata or signature: those stay in the database. */
function toDto(r: RelayRecord): Record<string, unknown> {
  return {
    id: r.id,
    kind: r.kind,
    chainId: r.chainId,
    projectId: r.projectId,
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
  };
}

function sendIntake(res: Response, result: IntakeResult): void {
  const { record, created } = result;
  res
    .status(created ? 202 : 200)
    .json({ success: true, data: { id: record.id, status: record.status } } satisfies ApiResponse);
}

/** Relay failures carry a stable `code`; everything else goes to the central handler. */
function fail(res: Response, err: unknown, next: NextFunction): void {
  if (err instanceof RelayError) {
    const requestId: unknown = res.locals["requestId"];
    res.status(err.status).json({
      success: false,
      error: err.message,
      code: err.code,
      ...(typeof requestId === "string" ? { requestId } : {}),
    });
    return;
  }
  next(err);
}

export async function postClaim(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const { projectId } = validatedOf<ClaimBody>(res, "body");
    sendIntake(res, await submitClaim(req.user, projectId));
  } catch (err) {
    fail(res, err, next);
  }
}

export async function postVote(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    sendIntake(res, await submitVote(req.user, validatedOf<VoteBody>(res, "body")));
  } catch (err) {
    fail(res, err, next);
  }
}

export async function postStake(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    sendIntake(res, await submitStake(req.user, validatedOf<StakeBody>(res, "body")));
  } catch (err) {
    fail(res, err, next);
  }
}

export async function getRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const { id } = validatedOf<RelayIdParams>(res, "params");
    const record = await getOwnRequest(id, req.user);
    res.status(200).json({ success: true, data: { request: toDto(record) } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function listRequestsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const { limit } = validatedOf<RelayListQuery>(res, "query");
    const records = await listRequests(req.user, limit);
    res.status(200).json({ success: true, data: { items: records.map(toDto) } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}
