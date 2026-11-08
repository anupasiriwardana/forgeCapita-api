import { Interface, JsonRpcProvider, Network, parseUnits, type Provider, type Result } from "ethers";
import { config } from "../config/env.js";
import { logger } from "../logger.js";
import { toLoggableError } from "../middlewares/errorHandler.js";
import { createChainSender, type ChainSender } from "./signer.js";

/** The only provider methods the relayer uses (keeps test doubles small). */
export type RelayProvider = Pick<
  Provider,
  "getBalance" | "getFeeData" | "call" | "estimateGas" | "getTransactionReceipt" | "getBlockNumber"
>;

export interface RelayChain {
  chainId: number;
  provider: RelayProvider;
  sender: ChainSender;
  maxGasPriceWei: bigint;
  minBalanceWei: bigint;
}

export const RELAY_CHAIN_IDS: readonly number[] = [421614, 97];

// Minimal fragments: only what the relayer encodes or reads.
export const escrowInterface = new Interface([
  "function claimTokensFor(address account)",
  "function voteBySig(address voter, bool support, uint256 deadline, bytes signature)",
  "function currentMilestoneIndex() view returns (uint256)",
  "function executeMilestone()",
  "function projectCancelled() view returns (bool)",
  "function completed() view returns (bool)",
  "function votingEndTime(uint256 index) view returns (uint256)",
  "function milestones(uint256 index) view returns (string description, uint256 unlockPercentage, bool isVotingOpen, bool isExecuted, uint256 yesVotes, uint256 noVotes, uint256 votingStartTime)",
]);
export const distributorInterface = new Interface([
  "function stakeWithPermit(address owner, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
]);
export const tokenInterface = new Interface([
  "function nonces(address owner) view returns (uint256)",
  "function name() view returns (string)",
  "function balanceOf(address account) view returns (uint256)",
]);
export const registryInterface = new Interface(["function isRelayer(address relayer) view returns (bool)"]);

const chains = new Map<number, RelayChain>();

export function getRelayChain(chainId: number): RelayChain | undefined {
  return chains.get(chainId);
}

export function relayChains(): RelayChain[] {
  return [...chains.values()];
}

export function registerRelayChain(chain: RelayChain): void {
  chains.set(chain.chainId, chain);
}

export function clearRelayChains(): void {
  chains.clear();
}

/** eth_call to a view function, decoded. */
export async function readView(
  provider: RelayProvider,
  iface: Interface,
  to: string,
  fn: string,
  args: unknown[] = []
): Promise<Result> {
  const raw = await provider.call({ to, data: iface.encodeFunctionData(fn, args) });
  return iface.decodeFunctionResult(fn, raw);
}

interface ChainSettings {
  rpcUrl: string | undefined;
  maxGasPriceWei: bigint;
  minBalanceWei: bigint;
}

function settingsFor(chainId: number): ChainSettings {
  if (chainId === 421614) {
    return {
      rpcUrl: config.RPC_URL_421614,
      maxGasPriceWei: parseUnits(config.RELAYER_MAX_GAS_PRICE_GWEI_421614, "gwei"),
      minBalanceWei: BigInt(config.RELAYER_MIN_BALANCE_WEI_421614),
    };
  }
  return {
    rpcUrl: config.RPC_URL_97,
    maxGasPriceWei: parseUnits(config.RELAYER_MAX_GAS_PRICE_GWEI_97, "gwei"),
    minBalanceWei: BigInt(config.RELAYER_MIN_BALANCE_WEI_97),
  };
}

async function buildChain(chainId: number): Promise<RelayChain | null> {
  const settings = settingsFor(chainId);
  if (settings.rpcUrl === undefined) return null;
  const provider = new JsonRpcProvider(settings.rpcUrl, Network.from(chainId), { staticNetwork: true });
  const sender = createChainSender(provider, chainId);
  if (sender === null) return null;
  try {
    const reported = BigInt(String(await provider.send("eth_chainId", [])));
    if (reported !== BigInt(chainId)) {
      logger.warn({ chainId }, "relay chain disabled: RPC reports a different chain id");
      return null;
    }
    const [allowed] = await readView(provider, registryInterface, config.RELAYER_REGISTRY_ADDRESS, "isRelayer", [
      sender.address,
    ]);
    if (allowed !== true) {
      logger.warn({ chainId, relayer: sender.address }, "relay chain disabled: relayer is not allow-listed");
      return null;
    }
  } catch (err) {
    logger.warn({ chainId, err: toLoggableError(err) }, "relay chain disabled: startup check failed");
    return null;
  }
  return { chainId, provider, sender, maxGasPriceWei: settings.maxGasPriceWei, minBalanceWei: settings.minBalanceWei };
}

/**
 * Builds the per-chain relayer runtime from the environment. Never throws: a disabled relayer,
 * a missing key or RPC URL, or a failed registry check leaves that chain (or all) disabled, and
 * the routes then fail closed with 503 RELAY_DISABLED.
 */
export async function initRelay(): Promise<void> {
  if (!config.RELAYER_ENABLED) {
    logger.info("relayer disabled");
    return;
  }
  for (const chainId of RELAY_CHAIN_IDS) {
    const chain = await buildChain(chainId);
    if (chain !== null) registerRelayChain(chain);
  }
  const active = relayChains();
  const first = active[0];
  if (first === undefined) {
    logger.warn("relayer enabled but no chain is usable; relay routes answer RELAY_DISABLED");
    return;
  }
  logger.info(`relayer enabled ${first.sender.address}`);
  logger.info(`relay chains: ${active.map((chain) => chain.chainId).join(",")}`);
}
