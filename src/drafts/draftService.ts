import { AppError } from "../errors.js";
import { AGREEMENT_VERSION } from "../founders/agreement.js";
import { assertGoalMeetsMinimum } from "../gas/minimumGoal.js";
import { findApprovedWallet, readLaunchChecks } from "../founders/founderRepository.js";
import { logger } from "../logger.js";
import { toLoggableError } from "../middlewares/errorHandler.js";
import type { CreateDraftBody, DraftPayload } from "../schemas/draftSchemas.js";
import type { AuthUser } from "../types/index.js";
import {
  attachPendingDraft,
  cancelPendingDraft,
  findOwnDraft,
  insertDraft,
  type DraftRecord,
} from "./draftRepository.js";
import { reconcileDrafts } from "./reconcile.js";

const PG_UNIQUE_VIOLATION = "23505";
const RESERVATION_INDEX = "launch_drafts_active_wallet_uidx";
const PROJECT_INDEX = "launch_drafts_project_uidx";

function pgField(err: unknown, key: "code" | "constraint"): string | undefined {
  if (typeof err !== "object" || err === null || !(key in err)) return undefined;
  const value = (err as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  return pgField(err, "code") === PG_UNIQUE_VIOLATION && pgField(err, "constraint") === constraint;
}

function isStaff(user: AuthUser): boolean {
  return user.role === "staff" || user.role === "admin";
}

function isAttachedState(draft: DraftRecord): boolean {
  return draft.status === "attached" || draft.status === "applied";
}

async function assertFounderEligible(user: AuthUser): Promise<void> {
  const checks = await readLaunchChecks(user.id, AGREEMENT_VERSION);
  if (!checks.applicationApproved) throw new AppError(403, "Founder application is not approved");
  if (!checks.agreementAccepted) throw new AppError(403, "Founder agreement is not accepted");
  if (!checks.shadowWalletAvailable) throw new AppError(403, "No approved shadow wallet is available");
}

/** Resolves the wallet to reserve: required and owned for founders, optional for staff and admin. */
async function resolveReservedWallet(walletId: string | undefined, user: AuthUser): Promise<string | null> {
  if (walletId === undefined) {
    if (isStaff(user)) return null;
    throw new AppError(400, "shadowWalletId is required");
  }
  const wallet = await findApprovedWallet({ id: walletId });
  if (!wallet || (!isStaff(user) && wallet.userId !== user.id)) {
    throw new AppError(400, "Shadow wallet not available");
  }
  if (wallet.reserved || wallet.bound) throw new AppError(409, "Shadow wallet is already reserved or bound");
  return wallet.id;
}

function payloadOf(body: CreateDraftBody): DraftPayload {
  return {
    name: body.name,
    description: body.description,
    ...(body.founderBio !== undefined && { founderBio: body.founderBio }),
    ...(body.logoUrl !== undefined && { logoUrl: body.logoUrl }),
    ...(body.pitchDeckUrl !== undefined && { pitchDeckUrl: body.pitchDeckUrl }),
    ...(body.websiteUrl !== undefined && { websiteUrl: body.websiteUrl }),
    ...(body.category !== undefined && { category: body.category }),
    ...(body.fundingGoalWei !== undefined && { fundingGoalWei: body.fundingGoalWei.toString() }),
  };
}

/** Saves the profile and reserves the shadow wallet before the on-chain launch. */
export async function createDraft(
  body: CreateDraftBody,
  user: AuthUser,
  ip: string | null
): Promise<DraftRecord> {
  if (!isStaff(user)) await assertFounderEligible(user);
  // Before any row or shadow-wallet reservation; staff and admin follow the same rule.
  await assertGoalMeetsMinimum(body.chainId, body.fundingGoalWei);
  const founderWalletId = await resolveReservedWallet(body.shadowWalletId, user);
  try {
    return await insertDraft({
      userId: user.id,
      walletAddress: user.address.toLowerCase(),
      chainId: body.chainId,
      founderWalletId,
      payload: payloadOf(body),
      ip,
    });
  } catch (err) {
    if (isUniqueViolation(err, RESERVATION_INDEX)) {
      throw new AppError(409, "Shadow wallet is already reserved or bound");
    }
    throw err;
  }
}

async function ownDraftOrThrow(id: string, user: AuthUser): Promise<DraftRecord> {
  const draft = await findOwnDraft(id, user.id);
  if (!draft) throw new AppError(404, "Not found");
  return draft;
}

/** Best effort: an already-indexed project is applied right away; failures are left to the job. */
async function reconcileOne(draftId: string): Promise<void> {
  try {
    await reconcileDrafts({ draftId });
  } catch (err) {
    logger.warn({ err: toLoggableError(err) }, "draft reconcile after attach failed");
  }
}

/** Attaches the launched escrow address to the owner's pending draft (idempotent for the same address). */
export async function attachDraft(id: string, escrowAddress: string, user: AuthUser): Promise<DraftRecord> {
  let attached: DraftRecord | null;
  try {
    attached = await attachPendingDraft(id, user.id, escrowAddress);
  } catch (err) {
    if (isUniqueViolation(err, PROJECT_INDEX)) {
      throw new AppError(409, "Project already attached to another draft");
    }
    throw err;
  }
  if (!attached) {
    const existing = await ownDraftOrThrow(id, user);
    if (!isAttachedState(existing)) throw new AppError(409, "Draft is not pending");
    if (existing.escrowAddress !== escrowAddress) {
      throw new AppError(409, "Draft already attached to another project");
    }
  }
  await reconcileOne(id);
  return ownDraftOrThrow(id, user);
}

/** Cancels a pending draft; an attached or applied draft can no longer be cancelled. */
export async function cancelDraft(id: string, user: AuthUser, ip: string | null): Promise<DraftRecord> {
  const cancelled = await cancelPendingDraft(id, user.id, ip);
  if (cancelled) return cancelled;
  const existing = await ownDraftOrThrow(id, user);
  throw new AppError(409, isAttachedState(existing) ? "Draft already attached" : "Draft is not pending");
}
