import { config } from "../config/env.js";
import { AppError } from "../errors.js";
import type { AuthUser } from "../types/index.js";
import {
  approveApplication,
  insertApplication,
  insertAutoApprovedApplication,
  rejectApplication,
} from "./applicationRepository.js";
import type { NewApplication } from "./applicationRepository.js";
import type { ReviewOutcome, SubmitOutcome } from "./applicationTypes.js";

const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === PG_UNIQUE_VIOLATION;
}

/**
 * Creates the caller's application; a wallet may have only one open application. Pending for
 * staff review, or approved at once (role promoted, sessions kept) when FOUNDER_APPROVAL=AUTO.
 */
export async function submitApplication(
  user: AuthUser,
  fields: Omit<NewApplication, "userId" | "walletAddress">,
  ip: string | null
): Promise<SubmitOutcome> {
  const input: NewApplication = { ...fields, userId: user.id, walletAddress: user.address };
  try {
    if (config.FOUNDER_APPROVAL === "AUTO") return await insertAutoApprovedApplication(input, ip);
    return { application: await insertApplication(input), roleChanged: false };
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, "An open application already exists");
    throw err;
  }
}

function assertTransitioned(outcome: ReviewOutcome | null, reviewer: AuthUser): ReviewOutcome {
  if (!outcome) throw new AppError(404, "Not found");
  if (outcome.userId === reviewer.id) throw new AppError(403, "Forbidden");
  if (!outcome.transitioned) throw new AppError(409, "Application is not pending");
  return outcome;
}

/** Approves with the KYC stamp; grants the founder role to a current investor only. */
export async function approve(
  reviewer: AuthUser,
  id: string,
  note: string | undefined,
  ip: string | null
): Promise<ReviewOutcome> {
  return assertTransitioned(await approveApplication(id, reviewer.id, note ?? null, ip), reviewer);
}

export async function reject(
  reviewer: AuthUser,
  id: string,
  note: string,
  ip: string | null
): Promise<ReviewOutcome> {
  return assertTransitioned(await rejectApplication(id, reviewer.id, note, ip), reviewer);
}
