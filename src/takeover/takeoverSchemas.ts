import { z } from "zod";
import { intParam } from "../schemas/founderSchemas.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const addressSchema = z
  .string()
  .regex(ADDRESS, "Invalid address")
  .transform((value) => value.toLowerCase());

const chainIdSchema = z.number().int().min(1).max(2_147_483_647);

const evidenceLinkSchema = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "Evidence link must be an https URL");

export const prepareCaseBodySchema = z
  .object({
    chainId: chainIdSchema,
    projectAddress: addressSchema,
    candidateWallet: addressSchema,
    reason: z.string().trim().min(1).max(2000),
    evidenceLinks: z.array(evidenceLinkSchema).max(10).default([]),
  })
  .strict();

export const caseIdParamsSchema = z
  .object({ id: z.string().regex(UUID, "Invalid id").transform((value) => value.toLowerCase()) })
  .strict();

export const listCasesQuerySchema = z
  .object({
    status: z.enum(["prepared", "vote_open", "closed", "cancelled"]).optional(),
    chainId: z
      .string()
      .regex(/^[0-9]{1,10}$/, "Must be an integer")
      .transform(Number)
      .pipe(chainIdSchema)
      .optional(),
    limit: intParam(1, 100, 20),
    offset: intParam(0, 10000, 0),
  })
  .strict();

export const caseDetailQuerySchema = z
  .object({
    limit: intParam(1, 200, 50),
    offset: intParam(0, 1_000_000, 0),
  })
  .strict();

export const emptyBodySchema = z.object({}).strict();

const issuedAtSchema = z.string().max(40).datetime();
const signatureSchema = z.string().regex(/^0x[0-9a-fA-F]{130}$/, "Invalid signature");

export const acceptBodySchema = z.object({ issuedAt: issuedAtSchema, signature: signatureSchema }).strict();

export const voteBodySchema = z
  .object({ choice: z.enum(["YES", "NO"]), issuedAt: issuedAtSchema, signature: signatureSchema })
  .strict();

export const byProjectParamsSchema = z
  .object({
    chainId: z
      .string()
      .regex(/^[0-9]{1,10}$/, "Must be an integer")
      .transform(Number)
      .pipe(chainIdSchema),
    address: addressSchema,
  })
  .strict();

export type PrepareCaseBody = z.output<typeof prepareCaseBodySchema>;
export type AcceptBody = z.output<typeof acceptBodySchema>;
export type VoteBody = z.output<typeof voteBodySchema>;
export type CaseIdParams= z.output<typeof caseIdParamsSchema>;
export type ListCasesQuery = z.output<typeof listCasesQuerySchema>;
export type CaseDetailQuery = z.output<typeof caseDetailQuerySchema>;
export type ByProjectParams = z.output<typeof byProjectParamsSchema>;
