import { z } from "zod";

const MIN_AGE_YEARS = 18;
const MIN_YEAR = 1900;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9 ()-]{7,20}$/;

function text(max: number): z.ZodString {
  return z.string().trim().min(1).max(max);
}

/** Parses a real calendar date (YYYY-MM-DD) as UTC midnight, or null. */
function parseIsoDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? date : null;
}

/** True for a real date after 1900-01-01 that is at least 18 years before `now` (so never in the future). */
export function isAdultDateOfBirth(value: string, now: Date = new Date()): boolean {
  const dob = parseIsoDate(value);
  if (!dob || dob.getTime() <= Date.UTC(MIN_YEAR, 0, 1)) return false;
  const cutoff = Date.UTC(now.getUTCFullYear() - MIN_AGE_YEARS, now.getUTCMonth(), now.getUTCDate());
  return dob.getTime() <= cutoff;
}

const dateOfBirthSchema = z
  .string()
  .trim()
  .refine((value) => isAdultDateOfBirth(value), "Must be a valid date of birth, 18 or older");

/** Personal profile body; PII, so messages never echo values and unknown keys are rejected. */
export const profileBodySchema = z
  .object({
    firstName: text(80),
    lastName: text(80),
    email: z.string().trim().toLowerCase().max(254).regex(EMAIL_PATTERN, "Invalid email"),
    phone: z.string().trim().regex(PHONE_PATTERN, "Invalid phone number"),
    addressLine1: text(120),
    addressLine2: text(120).optional(),
    city: text(80),
    region: text(80).optional(),
    postalCode: text(20),
    country: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/, "Must be an ISO 3166-1 alpha-2 code"),
    dateOfBirth: dateOfBirthSchema,
  })
  .strict();

export type ProfileBody = z.output<typeof profileBodySchema>;
