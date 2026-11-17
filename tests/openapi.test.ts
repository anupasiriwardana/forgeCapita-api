/** Structural checks of the hand-written OpenAPI document (no app, no database). */

import { describe, it, expect } from "@jest/globals";
import { openApiDocument } from "../src/openapi.js";

const doc = JSON.parse(JSON.stringify(openApiDocument)) as Record<string, unknown>;
const paths = doc["paths"] as Record<string, Record<string, Record<string, unknown>>>;
const METHODS = ["get", "post", "put", "patch", "delete"];

function operations(): Array<{ key: string; path: string; op: Record<string, unknown> }> {
  return Object.entries(paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => METHODS.includes(method))
      .map(([method, op]) => ({ key: `${method.toUpperCase()} ${path}`, path, op }))
  );
}

function collectRefs(node: unknown, out: string[]): string[] {
  if (Array.isArray(node)) node.forEach((child) => collectRefs(child, out));
  else if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") out.push(value);
      else collectRefs(value, out);
    }
  }
  return out;
}

function resolve(pointer: string): unknown {
  let node: unknown = doc;
  for (const part of pointer.slice(2).split("/")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

const EXPECTED = [
  "GET /api/v1/projects/{projectId}/transparency",
  "POST /api/v1/auth/nonce",
  "POST /api/v1/auth/verify",
  "GET /api/v1/auth/me",
  "POST /api/v1/auth/logout",
  "GET /api/v1/profile/me",
  "PUT /api/v1/profile/me",
  "GET /api/v1/admin/users/{address}/profile",
  "POST /api/v1/applications",
  "GET /api/v1/applications/mine",
  "GET /api/v1/admin/applications",
  "GET /api/v1/admin/applications/{id}",
  "POST /api/v1/admin/applications/{id}/approve",
  "POST /api/v1/admin/applications/{id}/reject",
  "GET /api/v1/agreement",
  "GET /api/v1/founders/me",
  "GET /api/v1/founders/me/launch-eligibility",
  "POST /api/v1/founders/me/agreement",
  "POST /api/v1/founders/me/shadow-wallet",
  "POST /api/v1/founders/me/repo",
  "GET /api/v1/founders/me/repo",
  "GET /api/v1/founders/me/repos",
  "GET /api/v1/admin/shadow-wallets",
  "POST /api/v1/admin/shadow-wallets/{id}/approve",
  "POST /api/v1/admin/shadow-wallets/{id}/reject",
  "GET /api/v1/admin/repos",
  "POST /api/v1/admin/repos/{id}/revoke",
  "GET /api/v1/launch-drafts/mine",
  "POST /api/v1/launch-drafts",
  "POST /api/v1/launch-drafts/{id}/attach",
  "POST /api/v1/launch-drafts/{id}/cancel",
  "GET /api/v1/gas/{chainId}/minimum-goal",
  "GET /api/v1/takeover-cases/mine",
  "GET /api/v1/takeover-cases/by-project/{chainId}/{address}",
  "GET /api/v1/takeover-cases/{id}/tally",
  "GET /api/v1/takeover-cases/{id}/my-vote",
  "POST /api/v1/takeover-cases/{id}/accept",
  "POST /api/v1/takeover-cases/{id}/vote",
  "GET /api/v1/admin/takeover-cases",
  "GET /api/v1/admin/takeover-cases/{id}",
  "GET /api/v1/admin/takeover-cases/{id}/votes",
  "POST /api/v1/admin/takeover-cases",
  "POST /api/v1/admin/takeover-cases/{id}/open",
  "POST /api/v1/admin/takeover-cases/{id}/cancel",
  "POST /api/v1/admin/takeover-cases/{id}/close",
  "POST /api/v1/admin/takeover-cases/{id}/handover",
  "GET /api/v1/complaints/mine",
  "POST /api/v1/complaints",
  "GET /api/v1/admin/complaints",
  "PATCH /api/v1/admin/complaints/{id}",
  "GET /api/v1/admin/users",
  "PATCH /api/v1/admin/users/{address}/role",
  "GET /api/v1/admin/audit-log",
  "GET /api/v1/admin/launch-drafts",
  "GET /api/v1/admin/relay-requests",
  "GET /api/v1/admin/inflows",
  "GET /api/v1/admin/compliance",
  "POST /api/v1/admin/compliance/{projectId}/resolve",
  "POST /api/v1/admin/compliance/{projectId}/shutdown",
  "GET /api/v1/relay/status",
  "GET /api/v1/relay",
  "GET /api/v1/relay/{id}",
  "POST /api/v1/relay/claim",
  "POST /api/v1/relay/vote",
  "POST /api/v1/relay/stake",
];

describe("openapi document", () => {
  it("is JSON-serialisable and an OpenAPI 3.x document", () => {
    expect(String(doc["openapi"])).toMatch(/^3\./);
  });

  it("resolves every $ref inside the document", () => {
    const refs = collectRefs(doc, []);
    expect(refs.length).toBeGreaterThan(0);
    for (const pointer of refs) {
      expect(pointer.startsWith("#/")).toBe(true);
      expect(resolve(pointer)).toBeDefined();
    }
  });

  it("starts every path with a slash", () => {
    for (const path of Object.keys(paths)) expect(path.startsWith("/")).toBe(true);
  });

  it("declares exactly the path parameters used in each path", () => {
    for (const { key, path, op } of operations()) {
      const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).sort();
      const declared = ((op["parameters"] as Array<Record<string, unknown>> | undefined) ?? [])
        .filter((p) => p["in"] === "path")
        .map((p) => p["name"])
        .sort();
      expect({ key, declared }).toEqual({ key, declared: placeholders });
    }
  });

  it("gives every operation a 2xx response", () => {
    for (const { key, op } of operations()) {
      const codes = Object.keys(op["responses"] as Record<string, unknown>);
      expect({ key, ok: codes.some((c) => /^2\d\d$/.test(c)) }).toEqual({ key, ok: true });
    }
  });

  it("documents every expected operation", () => {
    const present = new Set(operations().map((o) => o.key));
    const missing = EXPECTED.filter((key) => !present.has(key));
    expect(missing).toEqual([]);
  });
});
