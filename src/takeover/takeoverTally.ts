export type TakeoverResult = "passed" | "failed" | "no_quorum";

export interface TallyInput {
  yes: bigint;
  no: bigint;
  /** Snapshot TOTAL staked (includes the weight of excluded voters; this is the quorum denominator). */
  total: bigint;
  quorumPercent: number;
}

/** Minimum voted weight for quorum: ceil(total * percent / 100). */
export function quorumWeightRequired(total: bigint, quorumPercent: number): bigint {
  const scaled = total * BigInt(quorumPercent);
  return (scaled + 99n) / 100n;
}

/** Quorum holds when voted * 100 >= total * percent and somebody voted. */
export function isQuorumReached(voted: bigint, total: bigint, quorumPercent: number): boolean {
  return voted > 0n && voted * 100n >= total * BigInt(quorumPercent);
}

/** no_quorum overrides; otherwise passed only when yes strictly exceeds no (a tie fails). */
export function decideResult(input: TallyInput): TakeoverResult {
  if (!isQuorumReached(input.yes + input.no, input.total, input.quorumPercent)) return "no_quorum";
  return input.yes > input.no ? "passed" : "failed";
}

/** Cooldown after a failed or no_quorum close: null (no such case) or an elapsed window means none. */
export function isInCooldown(lastFailedClosedAt: Date | null, nowMs: number, cooldownDays: number): boolean {
  if (lastFailedClosedAt === null) return false;
  return lastFailedClosedAt.getTime() + cooldownDays * 86_400_000 > nowMs;
}
