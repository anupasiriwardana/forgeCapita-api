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

const CHAIN_ID_PARAM = z.enum(["421614", "97"]).transform(Number).optional();

export const auditLogQuerySchema = z
  .object({
    limit: intParam(1, 100, 20),
    offset: intParam(0, 10000, 0),
    action: z
      .string()
      .max(64)
      .regex(/^[a-z_]+(\.[a-z_]+)?$/, "Invalid action")
      .optional(),
    target: z
      .string()
      .regex(/^0x[0-9a-f]{40}$/, "Must be a lowercase address")
      .optional(),
    actor: z.string().uuid().optional(),
  })
  .strict();

export const launchDraftsQuerySchema = z
  .object({
    limit: intParam(1, 100, 20),
    offset: intParam(0, 10000, 0),
    status: z.enum(["pending", "attached", "applied", "cancelled", "expired", "conflict"]).optional(),
    userId: z.string().uuid().optional(),
    chainId: CHAIN_ID_PARAM,
  })
  .strict();

export const relayRequestsQuerySchema = z
  .object({
    limit: intParam(1, 100, 20),
    offset: intParam(0, 10000, 0),
    kind: z.enum(["claim", "stake", "vote", "execute"]).optional(),
    status: z.enum(["QUEUED", "SENDING", "SENT", "CONFIRMED", "FAILED", "EXPIRED"]).optional(),
    chainId: CHAIN_ID_PARAM,
    system: z
      .literal("true")
      .optional()
      .transform((value) => value === "true"),
    projectId: z
      .string()
      .regex(/^[0-9]+:0x[0-9a-f]{40}$/, "Invalid project id")
      .optional(),
  })
  .strict();

export const inflowsQuerySchema = z
  .object({
    limit: intParam(1, 100, 20),
    offset: intParam(0, 10000, 0),
    chainId: CHAIN_ID_PARAM,
    projectId: z
      .string()
      .regex(/^[0-9]+:0x[0-9a-f]{40}$/, "Invalid project id")
      .optional(),
    kind: z.enum(["native", "internal", "erc20"]).optional(),
  })
  .strict();

export const complianceQuerySchema = z
  .object({
    limit: intParam(1, 100, 20),
    offset: intParam(0, 10000, 0),
    chainId: CHAIN_ID_PARAM,
    state: z.enum(["OK", "WARNED", "ESCALATED", "RESOLVED", "SHUTDOWN"]).optional(),
  })
  .strict();

export type ComplianceQuery = z.output<typeof complianceQuerySchema>;
export type InflowsQuery = z.output<typeof inflowsQuerySchema>;
export type AuditLogQuery = z.output<typeof auditLogQuerySchema>;
export type LaunchDraftsQuery = z.output<typeof launchDraftsQuerySchema>;
export type RelayRequestsQuery = z.output<typeof relayRequestsQuerySchema>;
export type RoleParams =z.output<typeof roleParamsSchema>;
export type RoleBody = z.output<typeof roleBodySchema>;
export type ListUsersQuery = z.output<typeof listUsersQuerySchema>;
