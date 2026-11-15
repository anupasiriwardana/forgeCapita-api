import { z } from "zod";
import { GITHUB_LOGIN_PATTERN } from "../config/env.js";
import { slugify } from "../repos/repoNaming.js";
import { intParam } from "./founderSchemas.js";

export const provisionRepoBodySchema = z
  .object({
    githubUsername: z.string().regex(GITHUB_LOGIN_PATTERN, "Invalid GitHub username"),
    projectName: z
      .string()
      .trim()
      .min(3)
      .max(60)
      .refine((value) => slugify(value) !== "", "Must contain letters or digits"),
  })
  .strict();

export const adminReposQuerySchema = z
  .object({
    userId: z
      .string()
      .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, "Invalid id")
      .transform((value) => value.toLowerCase())
      .optional(),
    limit: intParam(1, 100, 20),
    offset: intParam(0, 10000, 0),
  })
  .strict();

export type ProvisionRepoBody = z.output<typeof provisionRepoBodySchema>;
export type AdminReposQuery = z.output<typeof adminReposQuerySchema>;
