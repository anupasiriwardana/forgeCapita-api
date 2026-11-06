import { randomBytes } from "node:crypto";
import { getAddress, verifyMessage } from "ethers";
import { config } from "../config/env.js";

export const NONCE_TTL_MS = 5 * 60 * 1000;
const STATEMENT = "Sign in to ForgeCapita";

export interface SiweMessageInput {
  address: string;
  nonce: string;
  issuedAt: Date;
  expirationTime: Date;
}

export function generateNonce(): string {
  return randomBytes(16).toString("hex");
}

/** EIP-4361-style message without a chain id, so one sign-in works for both chains. */
export function buildSiweMessage(input: SiweMessageInput): string {
  return [
    `${config.AUTH_DOMAIN} wants you to sign in with your Ethereum account:`,
    getAddress(input.address),
    "",
    STATEMENT,
    "",
    `URI: ${config.CORS_ORIGINS[0]}`,
    "Version: 1",
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt.toISOString()}`,
    `Expiration Time: ${input.expirationTime.toISOString()}`,
  ].join("\n");
}

/** True only when the signature over `message` recovers to `address` (case-insensitive). */
export function signatureMatches(message: string, signature: string, address: string): boolean {
  try {
    return verifyMessage(message, signature).toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  }
}
