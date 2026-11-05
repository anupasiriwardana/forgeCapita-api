import { z } from "zod";

/** Chains the API serves (Arbitrum Sepolia, BSC Testnet). */
export const ALLOWED_CHAIN_IDS: readonly number[] = [421614, 97];

export const PROJECT_STATES = [
  "FUNDING",
  "ACTIVE",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "SHUTDOWN",
] as const;

export const PROJECT_SORTS = ["created_at", "total_raised", "funding_goal"] as const;

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const CATEGORY_REGEX = /^[a-z0-9][a-z0-9-]{0,31}$/;
const COMPOSITE_ID_REGEX = /^([0-9]{1,10}):(0x[a-fA-F0-9]{40})$/;

/** Composite project id `<chainId>:<escrow>`: chain must be allowed; output has the escrow lowercased. */
const projectIdSchema = z
  .string()
  .trim()
  .regex(COMPOSITE_ID_REGEX, "Invalid project id")
  .refine((value) => ALLOWED_CHAIN_IDS.includes(Number(value.split(":")[0])), "Unsupported chain")
  .transform((value) => {
    const [chain = "", escrow = ""] = value.split(":");
    return `${Number(chain)}:${escrow.toLowerCase()}`;
  });

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

const categorySchema = z.string().regex(CATEGORY_REGEX, "Invalid category");

export const projectIdParamsSchema = z.object({ projectId: projectIdSchema }).strict();

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

export const listProjectsQuerySchema = z
  .object({
    limit: intParam(1, 100, 20),
    offset: intParam(0, 10000, 0),
    chainId: z
      .string()
      .refine((value) => ALLOWED_CHAIN_IDS.map(String).includes(value), "Unsupported chain")
      .transform(Number)
      .optional(),
    state: z.enum(PROJECT_STATES).optional(),
    developer: z
      .string()
      .regex(ADDRESS_REGEX, "Invalid address")
      .transform((value) => value.toLowerCase())
      .optional(),
    q: z.string().trim().min(1).max(64).optional(),
    category: categorySchema.optional(),
    hasProfile: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    sort: z
      .enum(PROJECT_SORTS)
      .optional()
      .transform((value) => value ?? "created_at"),
    order: z
      .enum(["asc", "desc"])
      .optional()
      .transform((value) => value ?? "desc"),
  })
  .strict();

export const profileBodySchema = z
  .object({
    projectId: projectIdSchema,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(5000),
    founderBio: z.string().max(5000).optional(),
    logoUrl: httpUrlSchema.optional(),
    pitchDeckUrl: httpUrlSchema.optional(),
    websiteUrl: httpUrlSchema.optional(),
    category: categorySchema.optional(),
    shadowWallet: z.string().regex(ADDRESS_REGEX, "Invalid wallet address").optional(),
  })
  .strict();

export type ProfileBody = z.output<typeof profileBodySchema>;
export type ProjectIdParams = z.output<typeof projectIdParamsSchema>;
export type ListProjectsQuery = z.output<typeof listProjectsQuerySchema>;
