import { createHash, randomBytes } from "node:crypto";
import { config } from "../config/env.js";
import type { AuthUser } from "../types/index.js";
import {
  deleteSession,
  findSession,
  touchSession,
  type SessionRecord,
} from "./authRepository.js";

export const SESSION_COOKIE = "fc_session";
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_TOUCH_MS = 5 * 60 * 1000;
export const MAX_SESSIONS_PER_USER = 5;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function cookieAttributes(maxAgeSeconds: number): string {
  const sameSite = config.SESSION_COOKIE_SAMESITE;
  const secure = config.NODE_ENV === "production" || sameSite === "none";
  return [
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite === "none" ? "None" : "Lax"}`,
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function buildSessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; ${cookieAttributes(SESSION_MAX_AGE_MS / 1000)}`;
}

export function buildClearCookie(): string {
  return `${SESSION_COOKIE}=; ${cookieAttributes(0)}`;
}

/** Extracts a well-formed session token from a Cookie header, or null. */
export function readSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    return TOKEN_PATTERN.test(value) ? value : null;
  }
  return null;
}

/** True when the Cookie header carries the session cookie name (even if malformed). */
export function hasSessionCookie(cookieHeader: string | undefined): boolean {
  return (cookieHeader ?? "")
    .split(";")
    .some((part) => part.trim().startsWith(`${SESSION_COOKIE}=`));
}

function isLive(record: SessionRecord, now: number): boolean {
  return (
    record.expiresAt.getTime() > now && now - record.lastSeenAt.getTime() < SESSION_IDLE_MS
  );
}

/** Looks up a session by raw token; deletes expired/idle ones and touches stale ones. */
export async function resolveSession(token: string): Promise<AuthUser | null> {
  const idHash = hashSessionToken(token);
  const record = await findSession(idHash);
  if (!record) return null;

  const now = Date.now();
  if (!isLive(record, now)) {
    await deleteSession(idHash);
    return null;
  }
  if (now - record.lastSeenAt.getTime() > SESSION_TOUCH_MS) {
    await touchSession(idHash);
  }
  return record.user;
}
