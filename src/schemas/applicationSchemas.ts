import { z } from "zod";

const STATUSES = ["pending", "approved", "rejected"] as const;

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function httpsUrlWithMax(max: number): z.ZodType<string> {
  return z
    .string()
    .trim()
    .max(max)
    .refine((value) => {
      const url = parseUrl(value);
      return url !== null && url.protocol === "https:" && url.username === "" && url.password === "";
    }, "Must be an https URL");
}

/** KYC documents link: https only, no credentials, no whitespace (a CHECK mirrors this in the database). */
const kycDocsUrl = httpsUrlWithMax(500).refine(
  (value) => /^https:\/\/[^\s/?#@]+([/?#]\S*)?$/.test(value),
  "Must be an https URL"
);

/** Generic https link without whitespace (portfolio and other links). */
const looseHttpsUrl = httpsUrlWithMax(300).refine(
  (value) => /^https:\/\/[^\s/?#@]+([/?#]\S*)?$/.test(value),
  "Must be an https URL"
);

const LINKEDIN_HOST = /^(www\.|[a-z]{2}\.)?linkedin\.com$/;

const linkedinUrl = looseHttpsUrl.refine((value) => {
  const url = parseUrl(value);
  if (url === null || !LINKEDIN_HOST.test(url.hostname)) return false;
  return /^\/in\/[^/]+\/?$/.test(url.pathname);
}, "Must be a LinkedIn profile URL (linkedin.com/in/...)");

const githubUrl = looseHttpsUrl.refine((value) => {
  const url = parseUrl(value);
  if (url === null || (url.hostname !== "github.com" && url.hostname !== "www.github.com")) return false;
  return /^\/[A-Za-z0-9-]+\/?$/.test(url.pathname);
}, "Must be a GitHub profile URL (github.com/username)");

export const createApplicationBodySchema = z
  .object({
    resumeUrl: kycDocsUrl,
    about: z.string().trim().min(50).max(1500),
    linkedinUrl: linkedinUrl.optional(),
    githubUrl: githubUrl.optional(),
    portfolioUrl: looseHttpsUrl.optional(),
    otherLinks: z.array(looseHttpsUrl).max(3).optional(),
    kycDocsUrl,
    kycNote: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (!body.linkedinUrl && !body.githubUrl && !body.portfolioUrl) {
      ctx.addIssue({
        code: "custom",
        path: ["linkedinUrl"],
        message: "Add at least one of LinkedIn, GitHub or portfolio",
      });
    }
  });

export const applicationIdParamsSchema = z
  .object({
    id: z
      .string()
      .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, "Invalid id")
      .transform((value) => value.toLowerCase()),
  })
  .strict();

export const approveBodySchema = z
  .object({
    kycVerified: z.literal(true),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const rejectBodySchema = z
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

export const listApplicationsQuerySchema = z
  .object({
    status: z.enum(STATUSES).optional(),
    limit: intParam(1, 100, 20),
    offset: intParam(0, 10000, 0),
  })
  .strict();

export type CreateApplicationBody = z.output<typeof createApplicationBodySchema>;
export type ApplicationIdParams = z.output<typeof applicationIdParamsSchema>;
export type ApproveBody = z.output<typeof approveBodySchema>;
export type RejectBody = z.output<typeof rejectBodySchema>;
export type ListApplicationsQuery = z.output<typeof listApplicationsQuerySchema>;
