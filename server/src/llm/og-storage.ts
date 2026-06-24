/**
 * 0G Storage — the canonical, decentralized, Merkle-verifiable home for Reins'
 * shared context. Every time the pipeline produces a fresh project rollup we
 * upload the snapshot here and keep its root hash. The dashboard and MCP
 * retrieval can then serve context addressed by hash: any teammate's agent pulls
 * the exact same, tamper-evident "team brain" — not whatever happens to be in one
 * server's SQLite.
 *
 * API verified against @0gfoundation/0g-storage-ts-sdk@1.2.x:
 *   new Indexer(indexerRpc)
 *   new MemData(bytes)
 *   memData.merkleTree() -> [tree, err];  tree.rootHash()
 *   indexer.upload(file, blockchainRpc, signer) -> [tx, err]
 *   indexer.downloadToBlob(rootHash) -> [Blob, err]
 */
import { createRequire } from "node:module";
import type { Indexer as IndexerT } from "@0gfoundation/0g-storage-ts-sdk";
import { env } from "../env.js";
import { ogWallet } from "./og.js";

// Same story as og-compute: load the CommonJS build lazily (broken ESM bundle).
const require = createRequire(import.meta.url);
function storageSdk() {
  return require("@0gfoundation/0g-storage-ts-sdk") as typeof import("@0gfoundation/0g-storage-ts-sdk");
}

let _indexer: IndexerT | null = null;
function indexer(): IndexerT {
  if (!_indexer) _indexer = new (storageSdk().Indexer)(env.og.storageIndexer);
  return _indexer;
}

export const storageStats = {
  uploads: 0,
  lastRootHash: "" as string,
  lastTx: "" as string,
  lastError: "" as string,
};

export type StoredSnapshot = { rootHash: string; txHash: string };

/** Upload a JSON-serializable snapshot. Returns its Merkle root hash + tx hash. */
export async function putSnapshot(obj: unknown): Promise<StoredSnapshot> {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const data = new (storageSdk().MemData)(bytes);

  const [tree, treeErr] = await data.merkleTree();
  if (treeErr) throw new Error(`0G Storage merkle: ${treeErr}`);
  const rootHash = tree?.rootHash() ?? "";

  const [tx, upErr] = await indexer().upload(data, env.og.storageRpc, ogWallet());
  if (upErr) {
    storageStats.lastError = String(upErr);
    throw new Error(`0G Storage upload: ${upErr}`);
  }

  const txHash = typeof tx === "string" ? tx : (tx as any)?.txHash ?? (tx as any)?.hash ?? "";
  storageStats.uploads++;
  storageStats.lastRootHash = rootHash;
  storageStats.lastTx = txHash;
  return { rootHash, txHash };
}

// Snapshots are content-addressed (immutable per root hash), so caching the
// parsed object is always safe and keeps repeated MCP reads fast.
const snapCache = new Map<string, unknown>();

/** Fetch a previously stored snapshot by root hash and parse it back to JSON. */
export async function getSnapshot<T = unknown>(rootHash: string): Promise<T> {
  const hit = snapCache.get(rootHash);
  if (hit !== undefined) return hit as T;

  const [blob, err] = await indexer().downloadToBlob(rootHash);
  if (err) throw new Error(`0G Storage download: ${err}`);
  const parsed = JSON.parse(await blob.text()) as T;

  if (snapCache.size > 64) snapCache.delete(snapCache.keys().next().value as string);
  snapCache.set(rootHash, parsed);
  return parsed;
}

/** Link to the snapshot on the public 0G storage explorer. */
export function storageExplorerUrl(rootHash: string): string {
  return `${env.og.storageExplorer}/tx/${rootHash}`;
}
