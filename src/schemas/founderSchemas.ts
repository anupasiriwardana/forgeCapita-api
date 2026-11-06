import { z } from "zod";

const STATUSES = ["pending", "approved", "rejected"] as const;

export const acceptAgreementBodySchema = z
  .object({
    typedName: z.string().trim().min(2).max(120),
    issuedAt: z.string().max(40).datetime(),
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, "Invalid signature"),
  })
  .strict();

export const shadowWalletBodySchema = z
  .object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Invalid address") })
  .strict();

export const shadowWalletIdParamsSchema = z
  .object({
    id: z
      .string()
      .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, "Invalid id")
      .transform((value) => value.toLowerCase()),
  })
  .strict();

export const approveShadowWalletBodySchema = z.preprocess(
  (value) => value ?? {},
  z.object({ note: z.string().trim().min(1).max(500).optional() }).strict()
);

export const rejectShadowWalletBodySchema = z
  .object({ note: z.string().trim().min(1).max(500) })
  .strict();

function intParam(min: number, max: number, fallback: number): z.ZodType<number> {
  return z
    .string()
    .regex(/^[0-9]{1,6}$/, "Must be an integer")
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .optional()
    .transform((value) => value ?? fallback);
}

export const listShadowWalletsQuerySchema = z
  .object({
    status: z.enum(STATUSES).optional(),
    limit: intParam(1, 100, 20),
    offset: intParam(0, 10000, 0),
  })
  .strict();

export type AcceptAgreementBody = z.output<typeof acceptAgreementBodySchema>;
export type ShadowWalletBody = z.output<typeof shadowWalletBodySchema>;
export type ShadowWalletIdParams = z.output<typeof shadowWalletIdParamsSchema>;
export type ApproveShadowWalletBody = { note?: string | undefined };
export type RejectShadowWalletBody = z.output<typeof rejectShadowWalletBodySchema>;
export type ListShadowWalletsQuery = z.output<typeof listShadowWalletsQuerySchema>;
