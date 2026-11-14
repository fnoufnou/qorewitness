/**
 * custody-drill.ts - "substitute the input": attacks that never touch a key.
 *
 * Builds a short chained recording for a test camera, attacks it at the points
 * where footage can be swapped, anchors every window on QoreChain for real, and
 * scores each attack with the same verifier a third party uses.
 *
 *   DETECTED   the verifier fails
 *   FLAGGED    the verifier passes but shows a warning on the record
 *   MISSED     the verifier passes without any warning
 *
 * Needs ffmpeg and ffprobe. Testnet only. Writes docs-ready results to <workdir>/results.md.
 * Env: QORE_MNEMONIC (test owner, not the live camera), QORE_REGISTRY (v4), QW_DEVICE_KEY,
 *      QW_DRILL_DIR (work dir), QW_DEVICE (default custody-test).
 * Usage: pnpm tsx --env-file=<env> scripts/custody-drill.ts
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { AnchorClient, qorechainTestnet, REGISTRY_ABI } from "../src/agent/anchor-client.js";
import { loadDeviceKey } from "../src/agent/device-key.js";
import { sha256File } from "../src/agent/hash-file.js";
import { buildReceipt, type Receipt } from "../src/agent/receipt.js";
import { probeSegment } from "../src/agent/source.js";
import { linkWindow, type Segment } from "../src/agent/window.js";
import { deviceIdOf } from "../src/core/message.js";
import { verifyReceipt, type ReceiptV3 } from "../src/core/verify.js";

const env = (k: string, d?: string) => {
  const v = process.env[k]?.trim() || d;
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
const dir = env("QW_DRILL_DIR", "/tmp/qw-custody");
const label = env("QW_DEVICE", "custody-test");
const registry = env("QORE_REGISTRY") as Address;
const client = await AnchorClient.create(env("QORE_MNEMONIC"), registry);
const key = loadDeviceKey(env("QW_DEVICE_KEY"));
const deviceId = deviceIdOf(label);
const pub = createPublicClient({ chain: qorechainTestnet, transport: http() }) as PublicClient;
const SEG = 10; // seconds per segment
const WIN = 60; // seconds per window
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, "receipts"), { recursive: true });

// ---------------------------------------------------------------- footage sources
type Source = "camera" | "other-camera" | "re-encoded";
/** "camera": fixed encoder settings, like one real camera. The others differ like real substitutes do. */
function makeClip(path: string, source: Source, seed: number): void {
  const pattern = `testsrc2=size=${source === "other-camera" ? "640x360" : "1280x720"}:rate=15`;
  const tint = `,hue=h=${seed * 37 % 360}`; // other content, same settings
  const enc = source === "camera"
    ? ["-c:v", "libx264", "-profile:v", "main", "-preset", "veryfast", "-g", "30", "-pix_fmt", "yuv420p"]
    : source === "other-camera"
      ? ["-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuv420p"]
      : ["-c:v", "libx264", "-profile:v", "high", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p"];
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", pattern + tint, "-t", String(SEG), ...enc, path]);
}
const name = (t: number) => `seg_${new Date(t * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.mp4`;

// ---------------------------------------------------------------- chain state
let prevLink: Uint8Array = new Uint8Array(32);
const head = await pub.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "nextWindowStart", args: [client.address, deviceId] });
let t0 = Math.max(Number(head), Math.floor(Date.now() / 1000) - 3600);
t0 -= t0 % WIN;

/** Records one window (WIN / SEG clips), applies `before` to the files before hashing, anchors it. */
async function window(tag: string, before?: (files: string[], start: number) => string[]) {
  const start = t0;
  t0 += WIN;
  const wdir = join(dir, tag);
  mkdirSync(wdir, { recursive: true });
  let files: string[] = [];
  for (let i = 0; i < WIN / SEG; i++) {
    const f = join(wdir, name(start + i * SEG));
    makeClip(f, "camera", start + i);
    files.push(f);
  }
  if (before) files = before(files, start);
  const segments: Segment[] = [];
  for (const f of files) {
    const completedAt = Math.floor(statSync(f).mtimeMs / 1000);
    segments.push({ path: f, sha256: await sha256File(f), size: statSync(f).size, completedAt, ...(await probeSegment(f, completedAt)) });
  }
  const w = { windowStart: BigInt(start), windowSeconds: WIN, segments };
  prevLink = linkWindow(w, prevLink);
  const res = await client.anchorWindow(deviceId, key, w);
  const receipt = buildReceipt({
    chain: { evmChainId: 9800, registry, txHash: res.txHash, anchorId: res.anchorId, blockNumber: res.blockNumber.toString() },
    owner: client.address, deviceId, deviceLabel: label, devicePubkey: key.publicKeyHex, root: res.root, signature: res.signature,
    prevRoot: res.prevRoot, refBlock: res.refBlock.toString(), refBlockHash: res.refBlockHash,
  }, w);
  const rpath = join(dir, "receipts", `${tag}.json`);
  writeFileSync(rpath, JSON.stringify(receipt, null, 2));
  return { files, receipt, rpath, tx: res.txHash, gas: res.gasUsed };
}

// ---------------------------------------------------------------- scoring
type Outcome = "DETECTED" | "FLAGGED" | "MISSED";
const results: { id: string; attack: string; when: string; outcome: Outcome; evidence: string; expected: Outcome }[] = [];

async function score(id: string, attack: string, when: string, expected: Outcome, receipt: Receipt | ReceiptV3, clip: string) {
  const r = await verifyReceipt(pub, receipt as ReceiptV3, await sha256File(clip));
  const fails = r.steps.filter((s) => s.state === "fail").map((s) => s.text);
  const warns = (receipt as ReceiptV3).segments.flatMap((s) =>
    [s.gapBeforeMs ? `gap ${(s.gapBeforeMs / 1000).toFixed(0)} s before segment ${s.index + 1}` : "",
      s.overlapMs ? `overlap ${(s.overlapMs / 1000).toFixed(0)} s at segment ${s.index + 1}` : "",
      s.sourceChanged ? `stream changed at segment ${s.index + 1}` : ""].filter(Boolean));
  const outcome: Outcome = fails.length ? "DETECTED" : warns.length ? "FLAGGED" : "MISSED";
  const evidence = fails[0] ?? warns.join(", ") ?? "";
  results.push({ id, attack, when, outcome, evidence: evidence || "all checks pass", expected });
  console.log(`${outcome.padEnd(8)} ${id} ${attack}: ${evidence || "all checks pass"}`);
}

// ---------------------------------------------------------------- the drill
console.log(`custody drill: owner ${client.address}, device ${label}, registry ${registry}`);

const base = await window("w0-baseline");
await score("B0", "No attack (baseline)", "-", "MISSED", base.receipt, base.files[2]);

// Before hashing: the attacker controls the recording folder or the stream.
const w1 = await window("w1-swap-same-settings", (files, start) => {
  makeClip(files[2], "camera", start + 999); // other content, same encoder settings
  return files;
});
await score("S1", "Swap a clip before hashing, same camera settings", "before anchoring", "MISSED", w1.receipt, w1.files[2]);

const w2 = await window("w2-swap-other-source", (files) => {
  makeClip(files[2], "other-camera", 7);
  return files;
});
await score("S2", "Swap a clip before hashing, footage from another camera", "before anchoring", "FLAGGED", w2.receipt, w2.files[2]);

const w3 = await window("w3-reencode", (files) => {
  const tmp = files[2] + ".orig.mp4";
  copyFileSync(files[2], tmp);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", tmp, "-c:v", "libx264", "-profile:v", "high", "-crf", "18", "-pix_fmt", "yuv420p", files[2]]);
  rmSync(tmp);
  return files;
});
await score("S3", "Re-encode a clip before hashing (to hide an edit)", "before anchoring", "FLAGGED", w3.receipt, w3.files[2]);

const w4 = await window("w4-delete-before", (files) => {
  rmSync(files[2]);
  return files.filter((_, i) => i !== 2);
});
await score("S4", "Delete a clip before hashing", "before anchoring", "FLAGGED", w4.receipt, w4.files[2]);

const w5 = await window("w5-insert", (files, start) => {
  const extra = join(dir, "w5-insert", name(start + 15)); // claims a time inside clip 2
  makeClip(extra, "camera", 4242);
  return [...files.slice(0, 2), extra, ...files.slice(2)];
});
await score("S5", "Insert a fabricated clip with an overlapping time", "before anchoring", "FLAGGED", w5.receipt, w5.files[2]);

// After anchoring: the attacker changes evidence later.
const w6 = await window("w6-after");
const edited = w6.files[3] + ".edited.mp4";
copyFileSync(w6.files[3], edited);
const buf = readFileSync(edited);
buf[Math.floor(buf.length / 2)] ^= 1;
writeFileSync(edited, buf);
await score("A1", "Change one byte of an anchored clip", "after anchoring", "DETECTED", w6.receipt, edited);

const dropped = structuredClone(w6.receipt) as ReceiptV3;
dropped.segments = dropped.segments.filter((s) => s.index !== 2);
await score("A2", "Remove a clip from the receipt (hide a moment)", "after anchoring", "DETECTED", dropped, w6.files[3]);

const swappedOrder = structuredClone(w6.receipt) as ReceiptV3;
[swappedOrder.segments[1], swappedOrder.segments[2]] = [swappedOrder.segments[2], swappedOrder.segments[1]];
await score("A3", "Re-order clips in the receipt", "after anchoring", "DETECTED", swappedOrder, w6.files[1]);

await score("A4", "Present a clip with another window's receipt", "after anchoring", "DETECTED", w1.receipt, w6.files[0]);

// A5: re-record a window that is already anchored (rewrite history on chain).
let a5 = "";
try {
  t0 = Number((w6.receipt as ReceiptV3).windowStart);
  await window("w7-rerecord");
  a5 = "accepted";
} catch (e) {
  a5 = /WindowOverlap|BrokenChain/.exec((e as Error).message)?.[0] ?? (e as Error).message.split("\n")[0];
}
results.push({ id: "A5", attack: "Anchor a new version of an anchored window", when: "after anchoring", outcome: a5 === "accepted" ? "MISSED" : "DETECTED", evidence: a5 === "accepted" ? "accepted" : `contract refused: ${a5}`, expected: "DETECTED" });
console.log(`${results[results.length - 1].outcome.padEnd(8)} A5 re-record: ${a5}`);

// ---------------------------------------------------------------- report
const md = [
  `| # | Attack | When | Result | Evidence |`, `|---|---|---|---|---|`,
  ...results.map((r) => `| ${r.id} | ${r.attack} | ${r.when} | ${r.outcome}${r.outcome === r.expected ? "" : ` (expected ${r.expected})`} | ${r.evidence.replace(/\|/g, "/")} |`),
].join("\n");
writeFileSync(join(dir, "results.md"), md + "\n");
writeFileSync(join(dir, "results.json"), JSON.stringify({ registry, device: label, owner: client.address, results }, null, 2));
console.log(`\n${md}\n\nreceipts in ${join(dir, "receipts")}`);


