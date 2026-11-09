/** Pure reconciliation rules (no I/O): amounts are bigint wei, ratios are integer basis points. */

export type ComplianceState = "OK" | "WARNED" | "ESCALATED" | "RESOLVED" | "SHUTDOWN";
export type OpenState = "OK" | "WARNED" | "ESCALATED";

export const WINDOW_DAYS = 30;
export const ESCALATION_DAYS = 14;
const BPS = 10_000n;
const DAY_MS = 86_400_000;

export interface Shortfall {
  /** Floor of (observed - routed) * 10000 / observed; 0 when nothing is missing. */
  shortfallBps: number;
  /** True only when routed < observed and the shortfall is strictly above the tolerance. */
  flagged: boolean;
}

export function computeShortfall(observed: bigint, routed: bigint, toleranceBps: number): Shortfall {
  if (observed <= 0n || routed >= observed) return { shortfallBps: 0, flagged: false };
  const missing = observed - routed;
  // Compare exactly (cross-multiplied) so a fractional 400.5 bps is not rounded down into tolerance.
  return {
    shortfallBps: Number((missing * BPS) / observed),
    flagged: missing * BPS > BigInt(toleranceBps) * observed,
  };
}

export interface OpenCase {
  state: OpenState;
  openedAt: Date;
}

/** Next state of a project's open case (null = none) after a check; RESOLVED needs an open case. */
export function nextState(current: OpenCase | null, flagged: boolean, now: Date): OpenState | "RESOLVED" {
  if (current === null || current.state === "OK") return flagged ? "WARNED" : "OK";
  if (!flagged) return "RESOLVED";
  if (current.state === "ESCALATED") return "ESCALATED";
  return now.getTime() - current.openedAt.getTime() >= ESCALATION_DAYS * DAY_MS ? "ESCALATED" : "WARNED";
}
