import { z } from "zod";
import { COMPLAINT_CATEGORIES, COMPLAINT_STATUSES } from "../complaints/complaintRepository.js";
import { projectIdSchema } from "./projectSchemas.js";

const evidenceUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "Evidence URL must be an https link");

export const createComplaintBodySchema = z
  .object({
    projectId: projectIdSchema,
    category: z.enum(COMPLAINT_CATEGORIES),
    body: z.string().trim().min(20).max(2000),
    evidenceUrl: evidenceUrlSchema.optional(),
  })
  .strict();

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

export const complaintsQuerySchema = z
  .object({
    limit: intParam(1, 100, 20),
    offset: intParam(0, 10000, 0),
    status: z.enum(COMPLAINT_STATUSES).optional(),
    projectId: z
      .string()
      .regex(/^[0-9]+:0x[a-f0-9]{40}$/, "Invalid project id")
      .optional(),
  })
  .strict();

export const complaintIdParamsSchema = z.object({ id: z.string().regex(/^[0-9]{1,15}$/, "Invalid id") }).strict();

export const complaintStatusBodySchema = z
  .object({
    status: z.enum(COMPLAINT_STATUSES),
    note: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()
  .refine((value) => (value.status !== "RESOLVED" && value.status !== "DISMISSED") || value.note !== undefined, {
    message: "A note is required to resolve or dismiss a complaint",
    path: ["note"],
  });

export type CreateComplaintBody = z.output<typeof createComplaintBodySchema>;
export type ComplaintsQuery = z.output<typeof complaintsQuerySchema>;
export type ComplaintIdParams = z.output<typeof complaintIdParamsSchema>;
export type ComplaintStatusBody = z.output<typeof complaintStatusBodySchema>;
