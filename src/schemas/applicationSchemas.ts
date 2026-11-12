import { z } from "zod";

const STATUSES = ["pending", "approved", "rejected"] as const;
const REPO_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "www.github.com",
  "gitlab.com",
  "www.gitlab.com",
]);

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

const httpsUrl = httpsUrlWithMax(300);

/** KYC documents link: https only, no credentials, no whitespace (a CHECK mirrors this in the database). */
const kycDocsUrl = httpsUrlWithMax(500).refine(
  (value) => /^https:\/\/[^\s/?#@]+([/?#]\S*)?$/.test(value),
  "Must be an https URL"
);

const repoUrl = httpsUrl.refine((value) => {
  const url = parseUrl(value);
  return url !== null && REPO_HOSTS.has(url.hostname);
}, "Must be a github.com or gitlab.com URL");

export const createApplicationBodySchema = z
  .object({
    projectName: z.string().trim().min(1).max(80),
    summary: z.string().trim().min(1).max(1000),
    websiteUrl: httpsUrl,
    pitchDeckUrl: httpsUrl,
    kycDocsUrl,
    kycNote: z.string().trim().min(1).max(500).optional(),
    repoUrl: repoUrl.optional(),
    contact: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

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
