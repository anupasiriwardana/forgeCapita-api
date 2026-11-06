import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const AGREEMENT_VERSION = "0.1";

/** Window within which a client-supplied `issuedAt` is accepted, in either direction. */
export const ISSUED_AT_TOLERANCE_MS = 10 * 60 * 1000;

const AGREEMENT_FILE = resolve(process.cwd(), "legal", `revenue-share-agreement-v${AGREEMENT_VERSION}.md`);

interface LoadedAgreement {
  text: string;
  textHash: string;
}

let cached: LoadedAgreement | undefined;

/** Reads the agreement text once; a missing file fails loudly instead of serving an empty agreement. */
export function loadAgreement(): LoadedAgreement {
  if (cached) return cached;
  let text: string;
  try {
    text = readFileSync(AGREEMENT_FILE, "utf8");
  } catch {
    throw new Error(`Agreement text not found at ${AGREEMENT_FILE}; the legal/ folder must ship with the API`);
  }
  cached = { text, textHash: createHash("sha256").update(text, "utf8").digest("hex") };
  return cached;
}

export interface AgreementMessageInput {
  name: string;
  wallet: string;
  issuedAt: string;
}

/**
 * The exact text the founder signs. Replay protection needs no nonce table: the wallet is
 * in the message (a signature cannot be reused for another user), `issuedAt` must be within
 * ISSUED_AT_TOLERANCE_MS of now, and agreement_acceptances is UNIQUE (user_id,
 * agreement_version), so a second submission of the same signature hits that constraint.
 */
export function buildAgreementMessage(input: AgreementMessageInput): string {
  return [
    "ForgeCapita Revenue Share Agreement",
    `Version: ${AGREEMENT_VERSION}`,
    `Agreement SHA-256: ${loadAgreement().textHash}`,
    `Name: ${input.name}`,
    `Wallet: ${input.wallet}`,
    `Issued At: ${input.issuedAt}`,
  ].join("\n");
}

/** The message with placeholders so the frontend can build the same text. */
export function agreementMessageTemplate(): string {
  return buildAgreementMessage({ name: "{name}", wallet: "{wallet}", issuedAt: "{issuedAt}" });
}
