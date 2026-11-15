import { randomBytes } from "node:crypto";

const MAX_SLUG_LENGTH = 40;

/** Lowercase ASCII slug of a project name: letters and digits joined by single hyphens. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
}

/** fc-<slug>-<6 hex>. The slug must be non-empty (enforced by the request schema). */
export function buildRepoName(projectName: string, suffix: string = randomBytes(3).toString("hex")): string {
  return `fc-${slugify(projectName)}-${suffix}`;
}
