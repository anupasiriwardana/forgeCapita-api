import { Wallet, type JsonRpcProvider, type TransactionRequest } from "ethers";
import { config } from "../config/env.js";

export interface SendRequest {
  to: string;
  data: string;
  gasLimit: bigint;
  nonce: number;
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | { gasPrice: bigint };
}

/** What the worker may do with the relayer key; the key itself never leaves this module. */
export interface ChainSender {
  readonly address: string;
  getNonce(): Promise<number>;
  /** Signs, broadcasts and returns the transaction hash. */
  send(request: SendRequest): Promise<string>;
}

/** Builds a sender bound to one chain's provider, or null when no key is configured. This is the ONLY place RELAYER_PRIVATE_KEY is read. */
export function createChainSender(provider: JsonRpcProvider, chainId: number): ChainSender | null {
  const key = config.RELAYER_PRIVATE_KEY;
  if (key === undefined) return null;
  const wallet = new Wallet(key, provider);
  return {
    address: wallet.address,
    getNonce: () => wallet.getNonce("pending"),
    send: async (request) => {
      const tx: TransactionRequest = {
        to: request.to,
        data: request.data,
        value: 0n,
        chainId,
        nonce: request.nonce,
        gasLimit: request.gasLimit,
        ...("gasPrice" in request.fees
          ? { type: 0, gasPrice: request.fees.gasPrice }
          : { type: 2, ...request.fees }),
      };
      const response = await wallet.sendTransaction(tx);
      return response.hash;
    },
  };
}
