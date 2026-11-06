import { z } from "zod";
import { ALLOWED_CHAIN_IDS, profileFieldsShape } from "./projectSchemas.js";

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

export const createDraftBodySchema = z
  .object({
    chainId: z.number().int().refine((value) => ALLOWED_CHAIN_IDS.includes(value), "Unsupported chain"),
    ...profileFieldsShape,
    shadowWalletId: z.string().uuid().optional(),
  })
  .strict();

export const draftIdParamsSchema = z.object({ id: z.string().uuid() }).strict();

export const attachDraftBodySchema = z
  .object({ escrowAddress: z.string().regex(ADDRESS_REGEX, "Invalid address").transform((v) => v.toLowerCase()) })
  .strict();

/** Profile fields stored in the draft payload (validated by createDraftBodySchema before insert). */
export type DraftPayload = Pick<
  z.output<typeof createDraftBodySchema>,
  "name" | "description" | "founderBio" | "logoUrl" | "pitchDeckUrl" | "websiteUrl" | "category"
>;

export type CreateDraftBody = z.output<typeof createDraftBodySchema>;
export type DraftIdParams = z.output<typeof draftIdParamsSchema>;
export type AttachDraftBody = z.output<typeof attachDraftBodySchema>;
