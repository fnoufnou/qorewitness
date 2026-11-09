/**
 * anchor-files.ts - anchors a set of files as one window and writes a receipt.
 * Usage: pnpm tsx --env-file=.env scripts/anchor-files.ts <device-label> <file...>
 * Env: QORE_MNEMONIC, QORE_REGISTRY (0x...), optional QORE_WINDOW_SECONDS (default 60).
 */
import { statSync, writeFileSync, mkdirSync } from "node:fs";
import { basename } from "node:path";
import type { Address } from "viem";
import { AnchorClient } from "../src/agent/anchor-client.js";
import { sha256File } from "../src/agent/hash-file.js";
import { buildReceipt } from "../src/agent/receipt.js";
import type { Segment } from "../src/agent/window.js";
import { deviceIdOf } from "../src/core/message.js";

const [label, ...files] = process.argv.slice(2);
const mnemonic = process.env.QORE_MNEMONIC?.trim();
const registry = process.env.QORE_REGISTRY?.trim() as Address | undefined;
if (!label || files.length === 0 || !mnemonic || !registry) {
  console.error("Usage: anchor-files.ts <device-label> <file...>  (needs QORE_MNEMONIC and QORE_REGISTRY)");
  process.exit(1);
}
const windowSeconds = Number(process.env.QORE_WINDOW_SECONDS ?? "60");

const segments: Segment[] = [];
for (const f of files) {
  const st = statSync(f);
  segments.push({ path: f, sha256: await sha256File(f), size: st.size, completedAt: Math.floor(st.mtimeMs / 1000) });
}
// One window that ends now: the files existed before this moment.
const now = Math.floor(Date.now() / 1000);
const windowStart = BigInt(now - windowSeconds);
const client = await AnchorClient.create(mnemonic, registry);
const deviceId = deviceIdOf(label);
const res = await client.anchorWindow(deviceId, { windowStart, windowSeconds, segments });

const receipt = buildReceipt(
  {
    chain: { evmChainId: 9800, registry, txHash: res.txHash, anchorId: res.anchorId, blockNumber: res.blockNumber.toString() },
    signer: client.address, deviceId, deviceLabel: label, root: res.root, signature: res.signature,
  },
  { windowStart, windowSeconds, segments },
);
mkdirSync("receipts", { recursive: true });
const out = `receipts/${label}-${windowStart}.json`;
writeFileSync(out, JSON.stringify(receipt, null, 2));
console.log({
  tx: res.txHash, anchorId: res.anchorId, block: res.blockNumber,
  blockTime: new Date(Number(res.blockTime) * 1000).toISOString(), gasUsed: res.gasUsed,
  files: files.map((f) => basename(f)), receipt: out,
});
