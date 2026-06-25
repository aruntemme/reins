/**
 * On-chain anchoring on 0G Chain. A snapshot already lives in 0G Storage,
 * addressed by its Merkle root hash; here we additionally commit that root hash
 * to the 0G chain as a tamper-evident, publicly auditable anchor. The cheapest
 * way to do this is a minimal self-send (to = own address, value = 0) whose
 * calldata carries "reins:<rootHash>" — the root hash is now witnessed by an
 * immutable, timestamped transaction that anyone can verify against the storage
 * snapshot.
 */
import { ethers } from "ethers";
import { env } from "../env.js";
import { ogWallet, ogProvider } from "./og.js";
import { setSnapshotAnchor } from "../db.js";

// The calldata prefix that marks a Reins anchor. Keep it stable: verifiers
// decode the data, strip this prefix, and compare the remainder to a root hash.
export const ANCHOR_PREFIX = "reins:";

/** Encode "reins:<rootHash>" to hex calldata for the anchor transaction. */
export function encodeAnchorData(rootHash: string): string {
  return ethers.hexlify(ethers.toUtf8Bytes(ANCHOR_PREFIX + rootHash));
}

/** Decode anchor calldata back to its root hash, or "" if it isn't a Reins anchor. */
export function decodeAnchorData(data: string): string {
  const text = ethers.toUtf8String(data);
  return text.startsWith(ANCHOR_PREFIX) ? text.slice(ANCHOR_PREFIX.length) : "";
}

// Audit surface for the dashboard: how many anchors we've written and the last one.
export const anchorStats = {
  anchors: 0,
  lastTx: "" as string,
  lastRootHash: "" as string,
  lastError: "" as string,
};

/** Link to an anchor transaction on the public 0G chain explorer. */
export function anchorExplorerUrl(txHash: string): string {
  return `${env.og.explorer}/tx/${txHash}`;
}

export type AnchorResult = { txHash: string; explorerUrl: string };

/**
 * Anchor a snapshot's Merkle root hash on the 0G chain. Sends a minimal
 * self-transaction whose calldata commits to the hash, records the tx against
 * the newest ledger row for that root, and returns the tx hash + explorer url.
 */
export async function anchorRootHash(rootHash: string): Promise<AnchorResult> {
  try {
    const wallet = ogWallet();
    const tx = await wallet.sendTransaction({
      to: wallet.address, // self-send: we only care about the calldata witness
      value: 0n,
      data: encodeAnchorData(rootHash),
    });

    // We have a tx hash the moment it's broadcast; that's the anchor. Best-effort
    // wait for one confirmation, but never hang the caller on a slow testnet.
    void Promise.race([
      tx.wait(1),
      new Promise((resolve) => setTimeout(resolve, 60_000)),
    ]).catch(() => {
      /* confirmation is opportunistic; the broadcast tx hash is the record */
    });

    setSnapshotAnchor(rootHash, tx.hash);
    anchorStats.anchors++;
    anchorStats.lastTx = tx.hash;
    anchorStats.lastRootHash = rootHash;
    anchorStats.lastError = "";

    return { txHash: tx.hash, explorerUrl: anchorExplorerUrl(tx.hash) };
  } catch (e) {
    anchorStats.lastError = e instanceof Error ? e.message : String(e);
    throw e;
  }
}

// Re-exported so callers/tests can confirm they're hitting a real provider.
export { ogProvider };
