/**
 * anchor-files.ts - anchors a set of files as one window and writes a receipt.
 * Usage: pnpm tsx --env-file=.env scripts/anchor-files.ts <device-label> <file...>
 * Env: QORE_MNEMONIC, QORE_REGISTRY (0x...), optional QW_DEVICE_KEY (default keys/<label>.key),
 *      optional QORE_WINDOW_SECONDS (default 60). The device must be registered (pnpm device register).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import type { Address } from "viem";
import { AnchorClient } from "../src/agent/anchor-client.js";
import { loadDeviceKey } from "../src/agent/device-key.js";
import { sha256File } from "../src/agent/hash-file.js";
import { buildReceipt } from "../src/agent/receipt.js";
import { linkWindow, type Segment } from "../src/agent/window.js";
import { probeSegment } from "../src/agent/source.js";
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
  const completedAt = Math.floor(st.mtimeMs / 1000);
  segments.push({ path: f, sha256: await sha256File(f), size: st.size, completedAt, ...(await probeSegment(f, completedAt)) });
}
// The segment chain continues from the last run for this label and registry (spec/2).
mkdirSync("receipts", { recursive: true });
const chainFile = `receipts/.chain-${label}.json`;
const saved = existsSync(chainFile) ? (JSON.parse(readFileSync(chainFile, "utf8")) as { registry: string; lastLink: string }) : undefined;
const prevLink = saved?.registry.toLowerCase() === registry.toLowerCase() ? Uint8Array.from(Buffer.from(saved.lastLink, "hex")) : new Uint8Array(32);
// One window that ends now: the files existed before this moment.
const now = Math.floor(Date.now() / 1000);
const windowStart = BigInt(now - windowSeconds);
const client = await AnchorClient.create(mnemonic, registry);
const deviceId = deviceIdOf(label);
const deviceKey = loadDeviceKey(process.env.QW_DEVICE_KEY?.trim() || `keys/${label}.key`);
const lastLink = linkWindow({ windowStart, windowSeconds, segments }, prevLink);
const res = await client.anchorWindow(deviceId, deviceKey, { windowStart, windowSeconds, segments });
writeFileSync(chainFile, JSON.stringify({ registry, lastLink: Buffer.from(lastLink).toString("hex") }));

const receipt = buildReceipt(
  {
    chain: { evmChainId: 9800, registry, txHash: res.txHash, anchorId: res.anchorId, blockNumber: res.blockNumber.toString() },
    owner: client.address, deviceId, deviceLabel: label, devicePubkey: deviceKey.publicKeyHex,
    root: res.root, signature: res.signature,
    prevRoot: res.prevRoot, refBlock: res.refBlock.toString(), refBlockHash: res.refBlockHash,
  },
  { windowStart, windowSeconds, segments },
);
const out = `receipts/${label}-${windowStart}.json`;
writeFileSync(out, JSON.stringify(receipt, null, 2));
console.log({
  tx: res.txHash, anchorId: res.anchorId, block: res.blockNumber,
  blockTime: new Date(Number(res.blockTime) * 1000).toISOString(), gasUsed: res.gasUsed,
  files: files.map((f) => basename(f)), receipt: out,
});
