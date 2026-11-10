import { config } from "../config/env.js";
import { AppError } from "../errors.js";
import type { AuthUser, Role } from "../types/index.js";
import { insertRoleChange } from "./auditRepository.js";

export type AssignableRole = Exclude<Role, "admin">;

/**
 * Sets a user's role on behalf of an admin. 'admin' is never assignable, admins
 * (including ADMIN_WALLETS) can never be changed, and an admin cannot change themselves.
 * Messages are generic so they reveal nothing about other accounts.
 */
export async function changeUserRole(
  actor: AuthUser,
  targetAddress: string,
  newRole: AssignableRole,
  ip: string | null
): Promise<Omit<AuthUser, "profileComplete">> {
  if (targetAddress === actor.address) throw new AppError(403, "Forbidden");
  if (config.ADMIN_WALLETS.includes(targetAddress)) throw new AppError(403, "Forbidden");

  const result = await insertRoleChange({
    actorUserId: actor.id,
    targetAddress,
    newRole,
    ip,
  });
  if (!result) throw new AppError(404, "Not found");
  if (result.previousRole === "admin") throw new AppError(403, "Forbidden");

  return {
    id: result.userId,
    address: result.address,
    role: result.changed ? newRole : result.previousRole,
  };
}
