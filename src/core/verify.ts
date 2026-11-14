/**
 * Receipt verification, shared by the CLI (scripts/verify-receipt.ts) and the
 * browser verifier. Needs only the file hash, the receipt and a public RPC.
 * Runs in Node and in browsers. Receipt v3 (spec/2): segment chain, window chain
 * and a time bound on both sides. Older v2 receipts go to verify-v2.ts.
 */
import { mldsa } from "@qorechain/pqc";
import { keccak256, parseAbi, toBytes, toHex, type Address, type Hex, type PublicClient } from "viem";
import { segmentLink } from "./link.js";
import { verifyProof } from "./merkle.js";
import { signingMessage, ZERO32 } from "./message.js";
import { verifyReceiptV2, type ReceiptV2 } from "./verify-v2.js";

export interface ReceiptV3 {
  format: string;
  chain: { evmChainId: number; registry: Address; txHash?: Hex; anchorId?: Hex; blockNumber?: string };
  owner: Address;
  deviceId: Hex;
  deviceLabel: string;
  devicePubkey: Hex;
  windowStart: string;
  windowSeconds: number;
  root: Hex;
  signature: Hex;
  prevRoot: Hex;
  refBlock: string;
  refBlockHash: Hex;
  segments: {
    file: string; sha256: Hex; size: number; index: number; proof: Hex[];
    prevLink: Hex; link: Hex; startMs: string; durationMs: number; sourceFp: Hex; source: string;
    gapBeforeMs?: number; sourceChanged?: boolean;
  }[];
  generator?: { name: string; version: string; commit: string; spec: string };
}
export type { ReceiptV2 };

export const VERIFY_ABI = parseAbi([
  "struct Anchor { bytes32 root; bytes32 sigHash; bytes32 deviceKeyHash; bytes32 prevRoot; address owner; uint32 deviceKeyVersion; uint64 windowStart; uint32 windowSeconds; uint32 leafCount; uint64 anchoredAt; uint64 blockNumber; uint64 refBlock; uint64 gapBefore; }",
  "struct Verification { bool found; bool included; bytes32 anchorId; Anchor anchor; uint8 deviceStatus; uint64 deviceRevokedAt; bytes32 chainHead; }",
  "function verifyAnchor(address owner, bytes32 deviceId, uint64 windowStart, bytes32 segmentLink, uint256 index, bytes32[] proof) view returns (Verification)",
]);

export type StepState = "pass" | "fail" | "info" | "warn";
export interface Step { state: StepState; text: string }

export interface VerifyResult {
  ok: boolean;
  steps: Step[];
  anchoredAt?: Date; // existed no later than
  signedAfter?: Date; // signed no earlier than (spec/2)
  windowStart?: Date;
  windowEnd?: Date;
}

const iso = (s: bigint | number) => new Date(Number(s) * 1000).toISOString();

export async function verifyReceipt(pub: PublicClient, r: ReceiptV3 | ReceiptV2, fileHash: Uint8Array): Promise<VerifyResult> {
  if (r.format === "qorewitness-receipt/v2") return verifyReceiptV2(pub, r as ReceiptV2, fileHash);
  return verifyReceiptV3(pub, r as ReceiptV3, fileHash);
}

async function verifyReceiptV3(pub: PublicClient, r: ReceiptV3, fileHash: Uint8Array): Promise<VerifyResult> {
  const steps: Step[] = [];
  let ok = true;
  const add = (state: StepState, text: string) => {
    steps.push({ state, text });
    if (state === "fail") ok = false;
    return state !== "fail";
  };
  const done = (): VerifyResult => ({ ok, steps });

  if (r.format !== "qorewitness-receipt/v3") {
    add("fail", `Receipt format "${r.format}" is not supported. This verifier reads qorewitness-receipt/v2 and v3.`);
    return done();
  }
  const chainId = await pub.getChainId();
  if (r.chain.evmChainId !== chainId) {
    add("fail", `The receipt is for chain ${r.chain.evmChainId}. The RPC serves chain ${chainId}.`);
    return done();
  }

  // 1. The file and its place in the segment chain.
  const h = toHex(fileHash);
  const seg = r.segments.find((s) => s.sha256 === h);
  if (!seg) {
    add("fail", `The file fingerprint (SHA-256 ${h.slice(0, 14)}…) is not in this receipt. The file was changed, or it belongs to another receipt.`);
    return done();
  }
  add("pass", `File fingerprint found in the receipt (segment ${seg.index + 1} of ${r.segments.length}).`);

  const link = toHex(segmentLink(toBytes(seg.prevLink), {
    fileHash, startMs: BigInt(seg.startMs), durationMs: seg.durationMs, sourceFp: toBytes(seg.sourceFp),
  }));
  if (link === seg.link) add("pass", "The segment's chain link matches its file, start time, length, stream and previous segment.");
  else add("fail", "The segment's chain link does not match. Its time, stream or position was changed.");

  const chainOk = r.segments.every((s, i) => i === 0 || s.prevLink === r.segments[i - 1].link);
  if (chainOk) add("pass", `The ${r.segments.length} segments of this window form one unbroken chain.`);
  else add("fail", "The segment chain inside this window is broken: a segment was removed, added or moved.");

  if (verifyProof(toBytes(r.root), toBytes(link), seg.index, r.segments.length, seg.proof.map((p) => toBytes(p)))) {
    add("pass", "Merkle path from the segment to the window root is valid.");
  } else add("fail", "The Merkle path does not lead to the root in the receipt.");

  // 2. The record on chain.
  const v = await pub.readContract({
    address: r.chain.registry, abi: VERIFY_ABI, functionName: "verifyAnchor",
    args: [r.owner, r.deviceId, BigInt(r.windowStart), link, BigInt(seg.index), seg.proof],
  });
  if (!v.found) {
    add("fail", "QoreChain has no anchor for this owner, camera and window.");
    return done();
  }
  const a = v.anchor;
  if (a.root === r.root) add("pass", `The root is stored on QoreChain in block ${a.blockNumber}.`);
  else add("fail", "The root on chain differs from the root in the receipt.");
  if (v.included) add("pass", "The contract itself confirms the segment is part of the anchored window (verifyAnchor).");
  else add("fail", "The contract does not confirm the segment (verifyAnchor).");

  if (a.prevRoot === r.prevRoot) {
    add("pass", a.prevRoot === ZERO32
      ? "This is the first window of this camera: its chain starts here."
      : "The window links to the previous window of this camera on chain.");
  } else add("fail", "The window's link to the previous window differs from the chain.");
  if (a.gapBefore > 0n) add("warn", `No anchor covers the ${a.gapBefore} seconds before this window (from ${iso(a.windowStart - a.gapBefore)}).`);

  // 3. The signature and the time bounds.
  if (keccak256(r.devicePubkey) === a.deviceKeyHash) {
    add("pass", `The camera key in the receipt is the key that was registered on chain (version ${a.deviceKeyVersion}).`);
  } else add("fail", "The camera key in the receipt is not the key registered on chain for this anchor.");

  const ref = await pub.getBlock({ blockNumber: a.refBlock });
  if (ref.hash !== r.refBlockHash) add("fail", `The reference block hash in the receipt differs from block ${a.refBlock} on chain.`);
  const msg = signingMessage(BigInt(chainId), r.chain.registry, {
    owner: r.owner, deviceId: r.deviceId, windowStart: a.windowStart, windowSeconds: a.windowSeconds,
    leafCount: a.leafCount, root: a.root, prevRoot: a.prevRoot, refBlock: a.refBlock, refBlockHash: ref.hash!,
  });
  if (mldsa.verify(toBytes(r.devicePubkey), msg, toBytes(r.signature))) {
    add("pass", "The ML-DSA-87 (post-quantum) signature over the root is valid (checked locally).");
  } else add("fail", "The ML-DSA-87 signature is not valid.");
  // The signature hash is in the full record. A single getAnchor call is not needed: verifyAnchor returns it.
  if (a.sigHash === keccak256(r.signature)) add("pass", "The signature is the same one the contract checked on chain.");
  else add("fail", "The signature differs from the one recorded on chain.");
  add("pass", `Signed after block ${a.refBlock} (${iso(ref.timestamp)}) and anchored in block ${a.blockNumber} (${iso(a.anchoredAt)}).`);

  // 4. What the stream shows.
  if (seg.gapBeforeMs) add("warn", `${(seg.gapBeforeMs / 1000).toFixed(1)} s of recording are missing before this segment.`);
  if (seg.sourceChanged) add("warn", "The stream description changed at this segment (codec, size, frame rate or encoder settings).");
  if (v.deviceStatus === 2) {
    add("warn", `The owner revoked this camera at ${iso(v.deviceRevokedAt)}. The anchor was made before that, while the camera was active. Check why it was revoked.`);
  }
  if (r.generator) {
    add("info", `Made by ${r.generator.name} ${r.generator.version} (commit ${r.generator.commit.slice(0, 12)}), rules ${r.generator.spec}. Replay steps: docs/SPEC.md.`);
  }
  const start = Number(seg.startMs);
  add("info", `Camera "${r.deviceLabel}" says this segment starts at ${new Date(start).toISOString()} and lasts ${(seg.durationMs / 1000).toFixed(1)} s. Stream: ${seg.source || "unknown"}.`);

  return {
    ok, steps,
    anchoredAt: new Date(Number(a.anchoredAt) * 1000),
    signedAfter: new Date(Number(ref.timestamp) * 1000),
    windowStart: new Date(Number(a.windowStart) * 1000),
    windowEnd: new Date((Number(a.windowStart) + a.windowSeconds) * 1000),
  };
}
