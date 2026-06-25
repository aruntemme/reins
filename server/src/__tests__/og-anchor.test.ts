import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ethers } from "ethers";

// Isolate the DB on a fresh temp file BEFORE importing anything that opens it.
process.env.REINS_DB = join(tmpdir(), `reins-anchor-${randomUUID()}.db`);

const { encodeAnchorData, decodeAnchorData, anchorRootHash, ANCHOR_PREFIX } = await import(
  "../llm/og-chain.js"
);
const db = await import("../db.js");
const og = await import("../llm/og.js");
const { ogConfigured } = await import("../env.js");

test("calldata encodes reins:<rootHash> and round-trips via ethers", () => {
  const rootHash = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const data = encodeAnchorData(rootHash);

  // It's valid hex calldata.
  assert.match(data, /^0x[0-9a-f]+$/);
  // Decoding the raw hex yields exactly the prefixed string.
  assert.equal(ethers.toUtf8String(data), ANCHOR_PREFIX + rootHash);
  // And our decode helper recovers just the root hash.
  assert.equal(decodeAnchorData(data), rootHash);
});

test("decodeAnchorData returns '' for non-Reins calldata", () => {
  const data = ethers.hexlify(ethers.toUtf8Bytes("hello world"));
  assert.equal(decodeAnchorData(data), "");
});

// REAL testnet anchor. This sends an actual 0G chain transaction from the funded
// wallet in server/.0g-key and asserts the ledger row is updated with the real
// tx hash. No stubbing: if the send fails, the true error surfaces.
test(
  "anchorRootHash sends a real 0G testnet tx and records it on the latest snapshot",
  { timeout: 120_000 },
  async (t) => {
    if (!ogConfigured) {
      // Honest skip: no funded key present in this environment.
      t.skip("0G wallet not configured (no OG_PRIVATE_KEY / server/.0g-key)");
      return;
    }

    // Confirm we're talking to the real 0G Galileo testnet, not a fake.
    const net = await og.ogProvider().getNetwork();
    assert.equal(Number(net.chainId), 16602, "expected 0G Galileo testnet chainId 16602");
    assert.match(og.ogAddress(), /^0x[0-9a-fA-F]{40}$/);

    const project = `anchor-test-${randomUUID().slice(0, 8)}`;
    const rootHash = "0x" + randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    db.ensureProject(project, project, "ws-anchor");
    db.recordSnapshot({ workspaceId: "ws-anchor", project, rootHash });

    const { txHash, explorerUrl } = await anchorRootHash(rootHash);

    assert.match(txHash, /^0x[0-9a-fA-F]{64}$/, "anchor tx hash should be a 32-byte hash");
    assert.ok(explorerUrl.includes(txHash), "explorer url should reference the tx hash");

    // The ledger row for this root must now carry the real anchor tx.
    const latest = db.latestSnapshot(project);
    assert.equal(latest?.root_hash, rootHash);
    assert.equal(latest?.anchored_tx, txHash);
  }
);
