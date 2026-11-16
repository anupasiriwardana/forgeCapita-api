import type { NextFunction, Request, Response } from "express";
import { AppError } from "../errors.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import { getAddress } from "ethers";
import type {
  AcceptBody,
  ByProjectParams,
  CaseDetailQuery,
  CaseIdParams,
  ListCasesQuery,
  PrepareCaseBody,
  VoteBody,
} from "../takeover/takeoverSchemas.js";
import {
  findCase,
  findPublicCase,
  listCases,
  listCasesForCandidate,
  listHolders,
  listVotes,
  type TakeoverCase,
} from "../takeover/takeoverRepository.js";
import { acceptanceMessageTemplate } from "../takeover/takeoverMessages.js";
import {
  acceptCandidate,
  cancelCase,
  castVote,
  closeCase,
  loadTally,
  openCase,
  prepareCase,
  readMyVoteView,
  readPublicTally,
  refreshIfDue,
  type TallyView,
} from "../takeover/takeoverService.js";
import type { ApiResponse } from "../types/index.js";

function validatedOf<T>(res: Response, key: keyof ValidatedRequest): T {
  return (res.locals["validated"] as ValidatedRequest)[key] as T;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** Staff view. Amounts and block numbers are decimal strings. */
function toStaffDto(c: TakeoverCase): Record<string, unknown> {
  return {
    id: c.id,
    chainId: c.chainId,
    projectId: c.projectId,
    candidateWallet: c.candidateWallet,
    candidateUserId: c.candidateUserId,
    reason: c.reason,
    evidenceLinks: c.evidenceLinks,
    status: c.status,
    createdBy: c.createdBy,
    openedBy: c.openedBy,
    createdAt: c.createdAt.toISOString(),
    openedAt: iso(c.openedAt),
    cancelledAt: iso(c.cancelledAt),
    snapshotBlock: c.snapshotBlock,
    snapshotBlockTimestamp: iso(c.snapshotBlockTimestamp),
    snapshotTakenAt: iso(c.snapshotTakenAt),
    snapshotLagSeconds: c.snapshotLagSeconds,
    snapshotTotalStaked: c.snapshotTotalStaked,
    snapshotHolderCount: c.snapshotHolderCount,
    candidateAcceptedAt: iso(c.candidateAcceptedAt),
    developerAtOpen: c.developerAtOpen,
    endsAt: iso(c.endsAt),
    closedAt: iso(c.closedAt),
    result: c.result,
    quorumPercent: c.quorumPercent,
    yesWeight: c.yesWeight,
    noWeight: c.noWeight,
    votedWeight: c.votedWeight,
    voterCount: c.voterCount,
  };
}

/** Public view: minimal on purpose (no holders, no reason, no evidence, no staff ids, no per-address votes). */
function toPublicDto(c: TakeoverCase, tally: TallyView): Record<string, unknown> {
  return {
    id: c.id,
    snapshotBlock: c.snapshotBlock,
    holderCount: c.snapshotHolderCount,
    openedAt: iso(c.openedAt),
    ...tally,
  };
}

export async function postPrepareCase(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const body = validatedOf<PrepareCaseBody>(res, "body");
    const created = await prepareCase(req.user.id, body, req.ip ?? null);
    res.status(201).json({ success: true, data: { case: toStaffDto(created) } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function postOpenCase(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const { id } = validatedOf<CaseIdParams>(res, "params");
    const { takeoverCase, alreadyOpen } = await openCase(id, req.user.id, req.ip ?? null);
    res.status(200).json({ success: true, data: { case: toStaffDto(takeoverCase), alreadyOpen } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function postCancelCase(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const { id } = validatedOf<CaseIdParams>(res, "params");
    const cancelled = await cancelCase(id, req.user.id, req.ip ?? null);
    res.status(200).json({ success: true, data: { case: toStaffDto(cancelled) } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function getCases(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { status, chainId, limit, offset } = validatedOf<ListCasesQuery>(res, "query");
    const { items, total } = await listCases(status, chainId, limit, offset);
    const fresh = await Promise.all(items.map(refreshIfDue));
    res.status(200).json({
      success: true,
      data: { items: fresh.map(toStaffDto), total, limit, offset },
    } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function getCaseDetail(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = validatedOf<CaseIdParams>(res, "params");
    const { limit, offset } = validatedOf<CaseDetailQuery>(res, "query");
    const found = await findCase(id);
    if (!found) throw new AppError(404, "Not found");
    const fresh = await refreshIfDue(found);
    const holders = await listHolders(id, limit, offset);
    res.status(200).json({
      success: true,
      data: { case: toStaffDto(fresh), holders: { items: holders, limit, offset } },
    } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function getCaseByProject(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { chainId, address } = validatedOf<ByProjectParams>(res, "params");
    const found = await findPublicCase(`${chainId}:${address}`);
    if (!found) throw new AppError(404, "Not found");
    const fresh = await refreshIfDue(found);
    res.status(200).json({ success: true, data: { case: toPublicDto(fresh, await loadTally(fresh)) } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function postAcceptCase(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const { id } = validatedOf<CaseIdParams>(res, "params");
    const body = validatedOf<AcceptBody>(res, "body");
    const { alreadyAccepted } = await acceptCandidate(req.user, id, body, req.ip ?? null);
    res.status(200).json({ success: true, data: { accepted: true, alreadyAccepted } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

/** The caller's own candidate cases: no reason, evidence or holders; the template lets the client build the signed text. */
export async function getMyCases(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const { address } = req.user;
    const items = (await listCasesForCandidate(req.user.id)).map((c) => ({
      id: c.id,
      projectId: c.projectId,
      status: c.status,
      acceptedAt: iso(c.candidateAcceptedAt),
      acceptMessage:
        c.status === "prepared" && c.candidateAcceptedAt === null
          ? acceptanceMessageTemplate(c.id, c.projectId, getAddress(address))
          : null,
    }));
    res.status(200).json({ success: true, data: { items } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function postVote(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const { id } = validatedOf<CaseIdParams>(res, "params");
    const body = validatedOf<VoteBody>(res, "body");
    const { vote, tally } = await castVote(req.user, id, body, req.ip ?? null);
    res.status(200).json({
      success: true,
      data: {
        vote: { choice: vote.choice, weight: vote.weight, issuedAt: vote.issuedAt.toISOString(), updatedAt: vote.updatedAt.toISOString() },
        tally,
      },
    } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function getTally(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = validatedOf<CaseIdParams>(res, "params");
    res.status(200).json({ success: true, data: { tally: await readPublicTally(id) } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

/** The caller's own voting state (eligibility, weight, own choice, message template); never signatures or other voters. */
export async function getMyVote(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const { id } = validatedOf<CaseIdParams>(res, "params");
    const myVote = await readMyVoteView(req.user, id);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ success: true, data: { myVote } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

/** Staff/admin only: per-address votes, never the signed message or signature. */
export async function getCaseVotes(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = validatedOf<CaseIdParams>(res, "params");
    const { limit, offset } = validatedOf<CaseDetailQuery>(res, "query");
    const found = await findCase(id);
    if (!found) throw new AppError(404, "Not found");
    await refreshIfDue(found);
    const { items, total } = await listVotes(id, limit, offset);
    res.status(200).json({
      success: true,
      data: {
        items: items.map((v) => ({
          voter: v.voter,
          choice: v.choice,
          weight: v.weight,
          issuedAt: v.issuedAt.toISOString(),
          updatedAt: v.updatedAt.toISOString(),
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

export async function postCloseCase(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const { id } = validatedOf<CaseIdParams>(res, "params");
    const closed = await closeCase(id, req.user.id, req.ip ?? null);
    res.status(200).json({ success: true, data: { case: toStaffDto(closed) } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}
