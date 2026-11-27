import { getAddress, ZeroAddress } from "ethers";
import { AUTO_APPROVAL_NOTE } from "../applications/applicationRepository.js";
import { signatureMatches } from "../auth/siwe.js";
import { config } from "../config/env.js";
import { AppError } from "../errors.js";
import type { AuthUser } from "../types/index.js";
import { AGREEMENT_VERSION, ISSUED_AT_TOLERANCE_MS, buildAgreementMessage, loadAgreement } from "./agreement.js";
import {
  approveShadowWallet,
  findApprovedWallet,
  insertAcceptance,
  insertAutoApprovedShadowWallet,
  insertShadowWallet,
  readLaunchChecks,
  rejectShadowWallet,
} from "./founderRepository.js";
import type { AcceptanceRecord, LaunchChecks, ShadowWalletRecord, WalletReviewOutcome } from "./founderRepository.js";

const PG_UNIQUE_VIOLATION = "23505";

const APPROVED_ADDRESS_INDEX = "founder_wallets_approved_address_idx";
const OPEN_REQUEST_EXISTS = "An open shadow wallet request already exists";
const ADDRESS_ALREADY_APPROVED = "Address is already approved for another founder";
const ADDRESS_ALREADY_YOURS = "This address is already one of your approved shadow wallets";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === PG_UNIQUE_VIOLATION;
}

function violatedConstraint(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("constraint" in err)) return undefined;
  return typeof err.constraint === "string" ? err.constraint : undefined;
}

/**
 * Pending-request clash vs. an address already approved, told apart by index name. An approved
 * address is then looked up so a founder re-submitting their own wallet gets an accurate message;
 * another founder's ownership is never revealed beyond the existing generic text.
 */
async function shadowWalletConflict(err: unknown, user: AuthUser, address: string): Promise<AppError> {
  if (violatedConstraint(err) !== APPROVED_ADDRESS_INDEX) return new AppError(409, OPEN_REQUEST_EXISTS);
  const approved = await findApprovedWallet({ address });
  return approved?.userId === user.id
    ? new AppError(409, ADDRESS_ALREADY_YOURS)
    : new AppError(409, ADDRESS_ALREADY_APPROVED);
}

/** FOUNDER_APPROVAL=AUTO: approved at once; a founder with a pending request still gets 409. */
async function insertAutoApproved(user: AuthUser, address: string, ip: string | null): Promise<ShadowWalletRecord> {
  const wallet = await insertAutoApprovedShadowWallet(user.id, user.address.toLowerCase(), address, AUTO_APPROVAL_NOTE, ip);
  if (!wallet) throw new AppError(409, OPEN_REQUEST_EXISTS);
  return wallet;
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

/**
 * Declares a shadow wallet for staff review (approved at once when FOUNDER_APPROVAL=AUTO); one
 * pending request at a time, any number approved.
 */
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
  if (address === user.address.toLowerCase()) {
    throw new AppError(400, "Use a dedicated wallet, not your login wallet");
  }
  try {
    if (config.FOUNDER_APPROVAL === "AUTO") return await insertAutoApproved(user, address, ip);
    return await insertShadowWallet(user.id, user.address.toLowerCase(), address, ip);
  } catch (err) {
    if (isUniqueViolation(err)) throw await shadowWalletConflict(err, user, address);
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
    if (isUniqueViolation(err)) throw new AppError(409, ADDRESS_ALREADY_APPROVED);
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
  const eligible =
    checks.applicationApproved && checks.agreementAccepted && checks.shadowWalletAvailable && checks.repoProvisioned;
  return { eligible, checks };
}
