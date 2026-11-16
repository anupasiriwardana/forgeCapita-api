import { getAddress } from "ethers";
import { config } from "../config/env.js";
import { AppError } from "../errors.js";
import { ISSUED_AT_TOLERANCE_MS } from "../founders/agreement.js";

export type VoteChoice = "YES" | "NO";

export interface VoteMessageInput {
  caseId: string;
  projectId: string;
  choice: VoteChoice;
  wallet: string;
  issuedAt: string;
}

export interface AcceptanceMessageInput {
  caseId: string;
  projectId: string;
  wallet: string;
  issuedAt: string;
}

/**
 * Exact EIP-191 texts, built server-side. Replay protection needs no nonce table: the case id and
 * the wallet are in the message, `issuedAt` must be within the tolerance window of now, and a stored
 * vote is only replaced by a strictly newer `issuedAt`.
 */
export function buildVoteMessage(input: VoteMessageInput): string {
  return [
    "ForgeCapita Takeover Vote",
    `Domain: ${config.AUTH_DOMAIN}`,
    `Case: ${input.caseId}`,
    `Project: ${input.projectId}`,
    `Choice: ${input.choice}`,
    `Wallet: ${getAddress(input.wallet)}`,
    `Issued At: ${input.issuedAt}`,
  ].join("\n");
}

export function buildAcceptanceMessage(input: AcceptanceMessageInput): string {
  return [
    "ForgeCapita Takeover Candidate Acceptance",
    `Domain: ${config.AUTH_DOMAIN}`,
    `Case: ${input.caseId}`,
    `Project: ${input.projectId}`,
    `Wallet: ${getAddress(input.wallet)}`,
    `Issued At: ${input.issuedAt}`,
  ].join("\n");
}

/** The acceptance text with an `{issuedAt}` placeholder so the frontend can build the same text. */
export function acceptanceMessageTemplate(caseId: string, projectId: string, wallet: string): string {
  return buildAcceptanceMessage({ caseId, projectId, wallet, issuedAt: "{issuedAt}" });
}

/** Parses a client `issuedAt` and requires it within +/- 10 minutes of now (400 otherwise). */
export function parseIssuedAt(issuedAt: string, now: Date): Date {
  const parsed = new Date(issuedAt);
  if (Number.isNaN(parsed.getTime()) || Math.abs(now.getTime() - parsed.getTime()) > ISSUED_AT_TOLERANCE_MS) {
    throw new AppError(400, "issuedAt is outside the allowed time window");
  }
  return parsed;
}

/** A stored vote is replaced only by a strictly newer signed message. */
export function isNewerVote(stored: Date | null, incoming: Date): boolean {
  return stored === null || incoming.getTime() > stored.getTime();
}
