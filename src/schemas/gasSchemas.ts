import { z } from "zod";
import { ALLOWED_CHAIN_IDS } from "./projectSchemas.js";

export const gasChainParamsSchema = z
  .object({
    chainId: z
      .string()
      .regex(/^\d{1,10}$/)
      .transform(Number)
      .refine((value) => ALLOWED_CHAIN_IDS.includes(value), "Unsupported chain"),
  })
  .strict();

export type GasChainParams = z.output<typeof gasChainParamsSchema>;
