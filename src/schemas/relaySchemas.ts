import { z } from "zod";
import { ALLOWED_CHAIN_IDS } from "./projectSchemas.js";

const MAX_UINT256 = 2n ** 256n - 1n;

/** Composite project id `<chainId>:<escrow>`; the escrow is lowercased. */
const projectIdSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{1,10}:0x[a-fA-F0-9]{40}$/, "Invalid project id")
  .refine((value) => ALLOWED_CHAIN_IDS.includes(Number(value.split(":")[0])), "Unsupported chain")
  .transform((value) => {
    const [chain = "", escrow = ""] = value.split(":");
    return `${Number(chain)}:${escrow.toLowerCase()}`;
  });

/** 65-byte ECDSA signature (r, s, v). */
const signatureSchema = z.string().regex(/^0x[a-fA-F0-9]{130}$/, "Invalid signature");

const deadlineSchema = z.number().int().positive().max(9_999_999_999);

/** Positive decimal integer string (wei); parsed to bigint, never through Number. */
const amountSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,77}$/, "Invalid amount")
  .transform((value) => BigInt(value))
  .refine((value) => value <= MAX_UINT256, "Invalid amount");

export const claimBodySchema = z.object({ projectId: projectIdSchema }).strict();

export const voteBodySchema = z
  .object({
    projectId: projectIdSchema,
    support: z.boolean(),
    deadline: deadlineSchema,
    signature: signatureSchema,
  })
  .strict();

export const stakeBodySchema = z
  .object({
    projectId: projectIdSchema,
    amount: amountSchema,
    deadline: deadlineSchema,
    signature: signatureSchema,
  })
  .strict();

export const relayIdParamsSchema = z.object({ id: z.string().uuid() }).strict();

export const relayListQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
  .strict();

export type ClaimBody = z.output<typeof claimBodySchema>;
export type VoteBody = z.output<typeof voteBodySchema>;
export type StakeBody = z.output<typeof stakeBodySchema>;
export type RelayIdParams = z.output<typeof relayIdParamsSchema>;
export type RelayListQuery = z.output<typeof relayListQuerySchema>;
