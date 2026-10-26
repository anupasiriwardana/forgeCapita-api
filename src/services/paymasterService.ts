// services/paymasterService.ts
import { ethers } from "ethers";

export async function generateGasDebtSignature(
    escrowAddress: string,
    milestoneIndex: number,
    chainId: number,
    gasDebt: string
): Promise<string> {
    if (!process.env.TREASURY_PRIVATE_KEY) {
        throw new Error("Treasury private key not configured");
    }

    const wallet = new ethers.Wallet(process.env.TREASURY_PRIVATE_KEY);

    // Replicates keccak256(abi.encodePacked(...)) from your Solidity contract
    const messageHash = ethers.solidityPackedKeccak256(
        ["address", "uint256", "uint256", "uint256"],
        [escrowAddress, milestoneIndex, chainId, gasDebt]
    );

    // Ethers v6 requires getBytes to sign the raw message hash properly
    return await wallet.signMessage(ethers.getBytes(messageHash));
}