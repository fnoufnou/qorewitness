/**
 * recovery-drill.ts - checks crash-safe receipts on testnet (T33).
 *
 * Anchors one small window for a test camera and throws the result away, as if the
 * agent stopped after the tx was mined and before the receipt was written. Then it
 * does what the agent does after a restart: the second anchor fails with
 * WindowOverlap, recoverAnchor rebuilds the result from the chain, and the rebuilt
 * receipt must pass the verifier.
 *
 * Needs ffmpeg and ffprobe. Testnet only. Use a test owner, not the live camera.
 * Env: QORE_MNEMONIC, QORE_REGISTRY (v4), QW_DEVICE_KEY, QW_DEVICE (default custody-test),
 *      QW_DRILL_DIR (default /tmp/qw-recovery).
 * Usage: pnpm tsx --env-file=<env> scripts/recovery-drill.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";
import { AnchorClient, type AnchorResult } from "../src/agent/anchor-client.js";
import { loadDeviceKey } from "../src/agent/device-key.js";
import { hashFile } from "../src/agent/hash-file.js";
import { buildReceipt } from "../src/agent/receipt.js";
import { probeSegment } from "../src/agent/source.js";
import { linkWindow, type Segment, type Window } from "../src/agent/window.js";
import { deviceIdOf } from "../src/core/message.js";
import { verifyReceipt, type ReceiptV3 } from "../src/core/verify.js";

const env = (k: string, d?: string) => {
  const v = process.env[k]?.trim() || d;
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
const dir = env("QW_DRILL_DIR", "/tmp/qw-recovery");
const label = env("QW_DEVICE", "custody-test");
const registry = env("QORE_REGISTRY") as Address;
const client = await AnchorClient.create(env("QORE_MNEMONIC"), registry);
const key = loadDeviceKey(env("QW_DEVICE_KEY"));
const deviceId = deviceIdOf(label);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const WIN = 60;
const start = Math.floor(Date.now() / 1000) - WIN;
const segments: Segment[] = [];
for (let i = 0; i < 2; i++) {
  const t = new Date((start + i * 10) * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const f = join(dir, `seg_${t}.mp4`);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=10,hue=h=${i * 90}`, "-t", "5", "-c:v", "libx264", "-pix_fmt", "yuv420p", f]);
  const completedAt = Math.floor(statSync(f).mtimeMs / 1000);
  const h = await hashFile(f);
  segments.push({ path: f, sha256: h.sha256, sha3: h.sha3, size: statSync(f).size, completedAt, ...(await probeSegment(f, completedAt)) });
}
const w: Window = { windowStart: BigInt(start), windowSeconds: WIN, segments };
linkWindow(w, new Uint8Array(32));

console.log(`owner ${client.address}, device ${label}, window ${start}`);
const sent = await client.anchorWindow(deviceId, key, w);
console.log(`1. anchored in block ${sent.blockNumber}, tx ${sent.txHash}. Receipt not written (simulated crash).`);

let overlap = "";
try {
  await client.anchorWindow(deviceId, key, w);
} catch (e) {
  overlap = /WindowOverlap/.exec((e as Error).message)?.[0] ?? (e as Error).message.split("\n")[0];
}
console.log(`2. after restart, anchoring again gives: ${overlap || "no error (unexpected)"}`);

const rec = await client.recoverAnchor(deviceId, w);
if (rec.status !== "found") throw new Error(`recovery failed: ${JSON.stringify(rec)}`);
const fields: (keyof AnchorResult)[] = ["txHash", "blockNumber", "anchorId", "root", "signature", "prevRoot", "refBlock", "refBlockHash", "gasUsed"];
const diff = fields.filter((k) => rec.result[k] !== sent[k]);
console.log(`3. recovered from chain: ${diff.length ? `DIFFERENT in ${diff.join(", ")}` : "every field equals the lost result"}`);

const receipt = buildReceipt({
  chain: { evmChainId: 9800, registry, txHash: rec.result.txHash, anchorId: rec.result.anchorId, blockNumber: rec.result.blockNumber.toString() },
  owner: client.address, deviceId, deviceLabel: label, devicePubkey: key.publicKeyHex, root: rec.result.root, signature: rec.result.signature,
  prevRoot: rec.result.prevRoot, refBlock: rec.result.refBlock.toString(), refBlockHash: rec.result.refBlockHash,
}, w);
const h = await hashFile(segments[1].path);
const v = await verifyReceipt(client.pub as never, receipt as unknown as ReceiptV3, h.sha256, h.sha3);
console.log(`4. rebuilt receipt: ${v.ok ? "verified" : `NOT verified: ${v.steps.filter((s) => s.state === "fail").map((s) => s.text).join(" / ")}`}`);

const other = await client.recoverAnchor(deviceId, { ...w, segments: [w.segments[0]] });
console.log(`5. same window start with other segments: ${other.status}`);
if (diff.length || !v.ok || overlap !== "WindowOverlap" || other.status !== "other") process.exitCode = 1;
