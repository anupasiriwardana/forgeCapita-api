import { JsonRpcProvider, Network, type Provider } from "ethers";
import { config } from "../config/env.js";

/** Chains whose minimum goal is computed (same allow-list as the rest of the API). */
export const GAS_CHAIN_IDS: readonly number[] = [421614, 97];

const providers = new Map<number, Pick<Provider, "getFeeData">>();

function rpcUrlOf(chainId: number): string | undefined {
  return chainId === 421614 ? config.RPC_URL_421614 : chainId === 97 ? config.RPC_URL_97 : undefined;
}

/** True when an RPC endpoint is configured for the chain. */
export function hasGasRpc(chainId: number): boolean {
  return rpcUrlOf(chainId) !== undefined;
}

/** Read-only provider (independent of the relayer registry); null without an RPC URL. */
function providerFor(chainId: number): Pick<Provider, "getFeeData"> | null {
  const cached = providers.get(chainId);
  if (cached) return cached;
  const url = rpcUrlOf(chainId);
  if (url === undefined) return null;
  const provider = new JsonRpcProvider(url, Network.from(chainId), { staticNetwork: true });
  providers.set(chainId, provider);
  return provider;
}

/** Current gas price in wei (gasPrice, falling back to maxFeePerGas); null when unavailable or not positive. */
export async function readGasPrice(chainId: number): Promise<bigint | null> {
  const provider = providerFor(chainId);
  if (provider === null) return null;
  const fee = await provider.getFeeData();
  const price = fee.gasPrice ?? fee.maxFeePerGas;
  return price !== null && price > 0n ? price : null;
}
