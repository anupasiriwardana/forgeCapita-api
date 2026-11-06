import { getAddress } from "ethers";
import { config } from "../config/env.js";
import { AppError } from "../errors.js";
import type { AuthUser } from "../types/index.js";
import {
  consumeNonce,
  deleteExpiredNonces,
  insertSession,
  pruneSessions,
  upsertNonce,
  upsertUser,
} from "./authRepository.js";
import {
  MAX_SESSIONS_PER_USER,
  SESSION_MAX_AGE_MS,
  createSessionToken,
  hashSessionToken,
} from "./session.js";
import { NONCE_TTL_MS, buildSiweMessage, generateNonce, signatureMatches } from "./siwe.js";

export interface NonceDto {
  nonce: string;
  message: string;
  expiresAt: string;
}

export interface LoginResult {
  user: AuthUser;
  token: string;
}

export interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

function signInFailed(): AppError {
  return new AppError(401, "Sign-in failed");
}

export async function issueNonce(address: string): Promise<NonceDto> {
  const normalized = getAddress(address).toLowerCase();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + NONCE_TTL_MS);
  const nonce = generateNonce();
  const message = buildSiweMessage({ address: normalized, nonce, issuedAt, expirationTime: expiresAt });

  await deleteExpiredNonces();
  await upsertNonce(normalized, nonce, message, expiresAt);
  return { nonce, message, expiresAt: expiresAt.toISOString() };
}

/** Verifies the signed nonce message and opens a session; every failure is the same 401. */
export async function login(
  address: string,
  signature: string,
  meta: ClientMeta
): Promise<LoginResult> {
  const normalized = address.toLowerCase();
  const stored = await consumeNonce(normalized);
  if (!stored || stored.expiresAt.getTime() <= Date.now()) throw signInFailed();
  if (!signatureMatches(stored.message, signature, normalized)) throw signInFailed();

  const user = await upsertUser(normalized, config.ADMIN_WALLETS.includes(normalized));
  const token = createSessionToken();
  await insertSession(
    hashSessionToken(token),
    user.id,
    new Date(Date.now() + SESSION_MAX_AGE_MS),
    meta.ip,
    meta.userAgent?.slice(0, 200) ?? null
  );
  await pruneSessions(user.id, MAX_SESSIONS_PER_USER);
  return { user, token };
}
