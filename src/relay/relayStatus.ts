import { RELAY_CHAIN_IDS, getRelayChain } from "./chains.js";

export type BalanceBucket = "ok" | "low" | "empty" | "unknown";

export interface ChainStatus {
  chainId: number;
  enabled: boolean;
  relayerAddress?: string;
  balance?: BalanceBucket;
}

export interface RelayStatus {
  enabled: boolean;
  chains: ChainStatus[];
}

const CACHE_TTL_MS = 30_000;

const cache = new Map<number, { at: number; status: ChainStatus }>();

/** Test hook: forgets cached chain statuses. */
export function resetRelayStatusCache(): void {
  cache.clear();
}

async function bucketFor(chainId: number): Promise<ChainStatus> {
  const chain = getRelayChain(chainId);
  if (chain === undefined) return { chainId, enabled: false };
  let balance: BalanceBucket;
  try {
    const wei = await chain.provider.getBalance(chain.sender.address);
    balance = wei === 0n ? "empty" : wei < chain.minBalanceWei ? "low" : "ok";
  } catch {
    balance = "unknown";
  }
  return { chainId, enabled: true, relayerAddress: chain.sender.address, balance };
}

async function chainStatus(chainId: number): Promise<ChainStatus> {
  const hit = cache.get(chainId);
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.status;
  const status = await bucketFor(chainId);
  cache.set(chainId, { at: Date.now(), status });
  return status;
}

/** Public, coarse relayer health: never an exact balance; each chain is probed at most every 30 s. */
export async function getRelayStatus(): Promise<RelayStatus> {
  const chains = await Promise.all(RELAY_CHAIN_IDS.map(chainStatus));
  return { enabled: chains.some((c) => c.enabled), chains };
}
