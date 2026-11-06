import { getAddress, ZeroAddress } from "ethers";
import { signatureMatches } from "../auth/siwe.js";
import { AppError } from "../errors.js";
import type { AuthUser } from "../types/index.js";
import { AGREEMENT_VERSION, ISSUED_AT_TOLERANCE_MS, buildAgreementMessage, loadAgreement } from "./agreement.js";
import {
  approveShadowWallet,
  insertAcceptance,
  insertShadowWallet,
  readLaunchChecks,
  rejectShadowWallet,
} from "./founderRepository.js";
import type { AcceptanceRecord, LaunchChecks, ShadowWalletRecord, WalletReviewOutcome } from "./founderRepository.js";

const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === PG_UNIQUE_VIOLATION;
}

/** Verifies the wallet signature over the server-built message, then stores the acceptance. */
export async function acceptAgreement(
  user: AuthUser,
  fields: { typedName: string; issuedAt: string; signature: string },
  ip: string | null,
  now: Date = new Date()
): Promise<AcceptanceRecord> {
  const issuedAt = new Date(fields.issuedAt);
  if (Number.isNaN(issuedAt.getTime()) || Math.abs(now.getTime() - issuedAt.getTime()) > ISSUED_AT_TOLERANCE_MS) {
    throw new AppError(400, "issuedAt is outside the allowed time window");
  }
  const message = buildAgreementMessage({
    name: fields.typedName,
    wallet: getAddress(user.address),
    issuedAt: fields.issuedAt,
  });
  if (!signatureMatches(message, fields.signature, user.address)) {
    throw new AppError(400, "Invalid signature");
  }
  try {
    return await insertAcceptance({
      userId: user.id,
      walletAddress: user.address.toLowerCase(),
      version: AGREEMENT_VERSION,
      textHash: loadAgreement().textHash,
      typedName: fields.typedName,
      message,
      signature: fields.signature,
      issuedAt,
      ip,
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, "Agreement already accepted");
    throw err;
  }
}

/** Declares a shadow wallet for staff review; one open (pending/approved) request per founder. */
export async function requestShadowWallet(
  user: AuthUser,
  rawAddress: string,
  ip: string | null
): Promise<ShadowWalletRecord> {
  let address: string;
  try {
    address = getAddress(rawAddress.toLowerCase()).toLowerCase();
  } catch {
    throw new AppError(400, "Invalid address");
  }
  if (address === ZeroAddress) throw new AppError(400, "Invalid address");
  try {
    return await insertShadowWallet(user.id, user.address.toLowerCase(), address, ip);
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, "An open shadow wallet request already exists");
    throw err;
  }
}

function assertTransitioned(outcome: WalletReviewOutcome | null, reviewer: AuthUser): void {
  if (!outcome) throw new AppError(404, "Not found");
  if (outcome.userId === reviewer.id) throw new AppError(403, "Forbidden");
  if (!outcome.transitioned) throw new AppError(409, "Shadow wallet is not pending");
}

async function review(run: () => Promise<WalletReviewOutcome | null>, reviewer: AuthUser): Promise<void> {
  try {
    assertTransitioned(await run(), reviewer);
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, "Address is already approved for another founder");
    throw err;
  }
}

export function approveWallet(reviewer: AuthUser, id: string, note: string | undefined, ip: string | null): Promise<void> {
  return review(() => approveShadowWallet(id, reviewer.id, note ?? null, ip), reviewer);
}

export function rejectWallet(reviewer: AuthUser, id: string, note: string, ip: string | null): Promise<void> {
  return review(() => rejectShadowWallet(id, reviewer.id, note, ip), reviewer);
}

export async function launchEligibility(
  user: AuthUser
): Promise<{ eligible: boolean; checks: LaunchChecks }> {
  const checks = await readLaunchChecks(user.id, AGREEMENT_VERSION);
  return { eligible: checks.applicationApproved && checks.agreementAccepted && checks.shadowWalletApproved, checks };
}
