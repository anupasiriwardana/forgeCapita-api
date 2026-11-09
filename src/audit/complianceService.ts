import { config } from "../config/env.js";
import { WINDOW_DAYS, type ComplianceState } from "./complianceLogic.js";
import { readTransparency } from "./complianceRepository.js";

export const UNAUDITED_NOTE = "Revenue audit unavailable on this chain: a paid explorer API plan is required";

export interface Transparency {
  projectId: string;
  chainId: number;
  auditStatus: "audited" | "unaudited";
  note: string | null;
  complianceState: ComplianceState | "not_checked" | null;
  shadowWallet: string | null;
  lastCheckedAt: string | null;
  windowDays: number;
  observedNative: string | null;
  routedNative: string | null;
  shortfallBps: number | null;
  toleranceBps: number;
  /** The indexer exposes no frozen flag per project, so this is always null. */
  frozen: null;
}

/**
 * Public view of a project's revenue audit. Only wallet, numbers and state are exposed: never
 * resolution notes, user ids or founder identity. Returns null for an unknown project.
 * `projectId` is the validated, lowercased `<chainId>:<escrow>`.
 */
export async function getTransparency(
  projectId: string,
  auditChains: readonly number[] = config.REVENUE_AUDIT_CHAINS,
  toleranceBps: number = config.REVENUE_TOLERANCE_BPS
): Promise<Transparency | null> {
  const row = await readTransparency(projectId);
  if (!row.known) return null;
  const chainId = Number(projectId.split(":")[0]);
  const base = { projectId, chainId, shadowWallet: row.wallet, windowDays: WINDOW_DAYS, toleranceBps, frozen: null };

  if (!auditChains.includes(chainId)) {
    return {
      ...base,
      auditStatus: "unaudited",
      note: UNAUDITED_NOTE,
      complianceState: null,
      lastCheckedAt: null,
      observedNative: null,
      routedNative: null,
      shortfallBps: null,
    };
  }
  return {
    ...base,
    auditStatus: "audited",
    note: null,
    complianceState: row.state ?? "not_checked",
    lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    observedNative: row.observed,
    routedNative: row.routed,
    shortfallBps: row.shortfallBps,
  };
}
