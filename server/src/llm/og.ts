/**
 * Shared 0G chain plumbing: a single wallet/signer used by both 0G Compute
 * (inference billing) and 0G Storage (upload payments). The key is a throwaway
 * testnet key — never a real-funds wallet. See env.og.
 */
import { ethers } from "ethers";
import { env, ogConfigured } from "../env.js";

let _provider: ethers.JsonRpcProvider | null = null;
let _wallet: ethers.Wallet | null = null;

export function ogProvider(): ethers.JsonRpcProvider {
  if (!_provider) _provider = new ethers.JsonRpcProvider(env.og.rpcUrl);
  return _provider;
}

/** The signing wallet. Throws if no key configured — callers should gate on ogConfigured. */
export function ogWallet(): ethers.Wallet {
  if (!ogConfigured) {
    throw new Error(
      "0G wallet not configured. Set OG_PRIVATE_KEY or create server/.0g-key (a throwaway testnet key)."
    );
  }
  if (!_wallet) _wallet = new ethers.Wallet(env.og.privateKey, ogProvider());
  return _wallet;
}

export function ogAddress(): string {
  return ogWallet().address;
}

/** Native 0G balance of the wallet, as a float (for funding decisions / status). */
export async function ogBalance(): Promise<number> {
  const wei = await ogProvider().getBalance(ogAddress());
  return Number(ethers.formatEther(wei));
}
