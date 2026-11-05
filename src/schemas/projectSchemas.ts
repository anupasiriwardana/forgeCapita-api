import { z } from "zod";

const projectIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9:_-]{1,128}$/, "Invalid project id");

const httpUrlSchema = z
  .string()
  .max(2048)
  .refine(
    (value) => {
      try {
        const { protocol } = new URL(value);
        return protocol === "http:" || protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "Must be a valid http(s) URL" }
  );

export const projectIdParamsSchema = z.object({ projectId: projectIdSchema }).strict();

/** Listing takes no parameters; unknown query keys are ignored (stripped). */
export const listProjectsQuerySchema = z.object({});

export const profileBodySchema = z
  .object({
    projectId: projectIdSchema,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(5000),
    founderBio: z.string().max(5000).optional(),
    logoUrl: httpUrlSchema.optional(),
    pitchDeckUrl: httpUrlSchema.optional(),
    websiteUrl: httpUrlSchema.optional(),
    shadowWallet: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid wallet address")
      .optional(),
  })
  .strict();

export type ProfileBody = z.output<typeof profileBodySchema>;
export type ProjectIdParams = z.output<typeof projectIdParamsSchema>;
