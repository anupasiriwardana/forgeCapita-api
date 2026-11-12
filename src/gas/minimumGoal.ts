import { formatEther } from "ethers";
import { config } from "../config/env.js";
import { AppError } from "../errors.js";
import { averageGasPrice, latestGasPrice } from "./gasRepository.js";

const BPS = 10_000n;
/** The deploy cost must be at most 5% of the goal, so the goal is cost / 0.05 = cost * 20. */
const GOAL_MULTIPLIER = 20n;
const CACHE_TTL_MS = 60_000;

export interface GoalParams {
  gasUnits: bigint;
  gasPriceWei: bigint;
  l1FeeWei: bigint;
  n: bigint;
  m: bigint;
  marginBps: bigint;
  floorWei: bigint;
  ceilingWei: bigint | null;
}

/** minGoal = max(cost * (1 + margin) * 20, floor), clamped to the ceiling when one is set. All bigint. */
export function computeMinimumGoal(p: GoalParams): bigint {
  const txCount = p.n * (2n + p.m) + p.m;
  const cost = p.gasUnits * p.gasPriceWei + txCount * p.l1FeeWei;
  const computed = (cost * (BPS + p.marginBps) * GOAL_MULTIPLIER) / BPS;
  const atLeastFloor = computed > p.floorWei ? computed : p.floorWei;
  return p.ceilingWei !== null && atLeastFloor > p.ceilingWei ? p.ceilingWei : atLeastFloor;
}

export interface MinimumGoal {
  minGoalWei: bigint;
  floorWei: bigint;
  ceilingWei: bigint | null;
  gasPriceUsedWei: bigint;
  l1FeeUsedWei: bigint;
  gasUnits: bigint;
  n: number;
  m: number;
  marginBps: number;
  windowHours: number;
  computedAt: Date;
  stale: boolean;
}

function chainSettings(chainId: number): { floorWei: bigint; ceilingWei: bigint | null; l1FeeWei: bigint } {
  if (chainId === 421614) {
    const ceiling = config.MIN_GOAL_CEILING_WEI_421614;
    return {
      floorWei: BigInt(config.MIN_GOAL_FLOOR_WEI_421614),
      ceilingWei: ceiling === undefined ? null : BigInt(ceiling),
      l1FeeWei: BigInt(config.MIN_GOAL_L1_FEE_WEI_421614),
    };
  }
  const ceiling = config.MIN_GOAL_CEILING_WEI_97;
  return {
    floorWei: BigInt(config.MIN_GOAL_FLOOR_WEI_97),
    ceilingWei: ceiling === undefined ? null : BigInt(ceiling),
    l1FeeWei: 0n,
  };
}

const cache = new Map<number, { at: number; value: MinimumGoal }>();

/** Clears the 60 s cache (tests). */
export function resetMinimumGoalCache(): void {
  cache.clear();
}

async function compute(chainId: number): Promise<MinimumGoal> {
  const { floorWei, ceilingWei, l1FeeWei } = chainSettings(chainId);
  const average = await averageGasPrice(chainId, config.GAS_WINDOW_HOURS);
  const gasPrice = average ?? (await latestGasPrice(chainId));
  const base = {
    floorWei,
    ceilingWei,
    l1FeeUsedWei: l1FeeWei,
    gasUnits: BigInt(config.MIN_GOAL_GAS_UNITS),
    n: config.MIN_GOAL_N,
    m: config.MIN_GOAL_M,
    marginBps: config.MIN_GOAL_MARGIN_BPS,
    windowHours: config.GAS_WINDOW_HOURS,
    computedAt: new Date(),
  };
  if (gasPrice === null) {
    // No samples and no usable RPC: fall back to the floor (still clamped) and flag it.
    const minGoalWei = ceilingWei !== null && floorWei > ceilingWei ? ceilingWei : floorWei;
    return { ...base, minGoalWei, gasPriceUsedWei: 0n, stale: true };
  }
  const minGoalWei = computeMinimumGoal({
    gasUnits: base.gasUnits,
    gasPriceWei: gasPrice,
    l1FeeWei,
    n: BigInt(base.n),
    m: BigInt(base.m),
    marginBps: BigInt(base.marginBps),
    floorWei,
    ceilingWei,
  });
  return { ...base, minGoalWei, gasPriceUsedWei: gasPrice, stale: average === null };
}

/** Current minimum funding goal for an allow-listed chain (cached for about 60 s). */
export async function getMinimumGoal(chainId: number): Promise<MinimumGoal> {
  const hit = cache.get(chainId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await compute(chainId);
  cache.set(chainId, { at: Date.now(), value });
  return value;
}

/** JSON body of the public endpoint. All amounts are decimal strings; test mode sends minGoalWei null. */
export function serializeMinimumGoal(goal: MinimumGoal, mode: "test" | "live"): Record<string, unknown> {
  return {
    mode,
    minGoalWei: mode === "live" ? goal.minGoalWei.toString() : null,
    floor: goal.floorWei.toString(),
    ...(goal.ceilingWei !== null && { ceiling: goal.ceilingWei.toString() }),
    gasPriceUsed: goal.gasPriceUsedWei.toString(),
    l1FeeUsed: goal.l1FeeUsedWei.toString(),
    gasUnits: goal.gasUnits.toString(),
    N: String(goal.n),
    M: String(goal.m),
    margin: String(goal.marginBps),
    windowHours: String(goal.windowHours),
    computedAt: goal.computedAt.toISOString(),
    stale: goal.stale,
  };
}

function formatAmount(wei: bigint, chainId: number): string {
  return `${formatEther(wei).replace(/\.0$/, "")} ${chainId === 97 ? "BNB" : "ETH"}`;
}

/**
 * Rejects a declared funding goal below the live minimum. A no-op in test mode.
 * Known limitation: the founder's on-chain deploy could use a different goal than the one declared
 * here; that is not detected yet.
 */
export async function assertGoalMeetsMinimum(chainId: number, fundingGoalWei: bigint | undefined): Promise<void> {
  if (config.MINIMUM_GOAL_MODE !== "live") return;
  const { minGoalWei } = await getMinimumGoal(chainId);
  if (fundingGoalWei === undefined || fundingGoalWei < minGoalWei) {
    throw new AppError(
      422,
      `Funding goal is below the current minimum of ${formatAmount(minGoalWei, chainId)} (live gas-based minimum).`
    );
  }
}
