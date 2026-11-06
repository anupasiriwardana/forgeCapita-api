import { z } from "zod";

const ASSIGNABLE_ROLES = ["founder", "staff", "investor"] as const;
const LISTABLE_ROLES = ["founder", "staff", "investor", "admin"] as const;

export const roleParamsSchema = z
  .object({
    address: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid address")
      .transform((value) => value.toLowerCase()),
  })
  .strict();

export const roleBodySchema = z.object({ role: z.enum(ASSIGNABLE_ROLES) }).strict();

/** Query values arrive as strings; repeated keys arrive as arrays and fail the string check. */
function intParam(min: number, max: number, fallback: number): z.ZodType<number> {
  return z
    .string()
    .regex(/^[0-9]{1,6}$/, "Must be an integer")
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .optional()
    .transform((value) => value ?? fallback);
}

export const listUsersQuerySchema = z
  .object({
    limit: intParam(1, 100, 20),
    offset: intParam(0, 10000, 0),
    role: z.enum(LISTABLE_ROLES).optional(),
    q: z
      .string()
      .regex(/^0x[0-9a-f]{0,40}$/, "Must be a lowercase hex address prefix")
      .optional(),
  })
  .strict();

export type RoleParams = z.output<typeof roleParamsSchema>;
export type RoleBody = z.output<typeof roleBodySchema>;
export type ListUsersQuery = z.output<typeof listUsersQuerySchema>;
