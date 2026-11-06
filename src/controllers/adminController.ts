import type { NextFunction, Request, Response } from "express";
import { changeUserRole } from "../auth/adminService.js";
import { listUsers } from "../auth/authRepository.js";
import { AppError } from "../errors.js";
import type { ValidatedRequest } from "../middlewares/validate.js";
import type { ListUsersQuery, RoleBody, RoleParams } from "../schemas/adminSchemas.js";
import type { ApiResponse } from "../types/index.js";

function validatedOf<T>(res: Response, key: keyof ValidatedRequest): T {
  return (res.locals["validated"] as ValidatedRequest)[key] as T;
}

export async function patchUserRole(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, "Authentication required");
    const { address } = validatedOf<RoleParams>(res, "params");
    const { role } = validatedOf<RoleBody>(res, "body");
    const user = await changeUserRole(req.user, address, role, req.ip ?? null);
    res.status(200).json({ success: true, data: { user } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function getUsers(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { limit, offset, role, q } = validatedOf<ListUsersQuery>(res, "query");
    const { items, total } = await listUsers({ role, addressPrefix: q, limit, offset });
    res.status(200).json({
      success: true,
      data: {
        items: items.map((u) => ({
          id: u.id,
          address: u.address,
          role: u.role,
          createdAt: u.createdAt.toISOString(),
          lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
        })),
        total,
        limit,
        offset,
      },
    } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
}
