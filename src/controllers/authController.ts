import type { NextFunction, Request, Response } from "express";
import { deleteSession } from "../auth/authRepository.js";
import { issueNonce, login } from "../auth/authService.js";
import {
  buildClearCookie,
  buildSessionCookie,
  hashSessionToken,
  readSessionToken,
} from "../auth/session.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import type { NonceBody, VerifyBody } from "../schemas/authSchemas.js";
import type { ApiResponse } from "../types/index.js";

function bodyOf<T>(res: Response): T {
  return (res.locals["validated"] as ValidatedRequest).body as T;
}

export async function postNonce(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { address } = bodyOf<NonceBody>(res);
    const data = await issueNonce(address);
    res.status(200).json({ success: true, data } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function postVerify(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { address, signature } = bodyOf<VerifyBody>(res);
    const { user, token } = await login(address, signature, {
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
    res.append("Set-Cookie", buildSessionCookie(token));
    res.status(200).json({ success: true, data: { user } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export function getMe(req: Request, res: Response): void {
  res.status(200).json({ success: true, data: { user: req.user } } satisfies ApiResponse);
}

export async function postLogout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = readSessionToken(req.headers.cookie);
    if (token) await deleteSession(hashSessionToken(token));
    res.append("Set-Cookie", buildClearCookie());
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}
