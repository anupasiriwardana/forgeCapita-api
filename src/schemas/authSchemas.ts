import { z } from "zod";

const addressSchema = z
  .string()
  .trim()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid address");

export const nonceBodySchema = z.object({ address: addressSchema }).strict();

export const verifyBodySchema = z
  .object({
    address: addressSchema,
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, "Invalid signature"),
  })
  .strict();

export type NonceBody = z.output<typeof nonceBodySchema>;
export type VerifyBody = z.output<typeof verifyBodySchema>;
