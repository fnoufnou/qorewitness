/**
 * Receipt verification, shared by the CLI (scripts/verify-receipt.ts) and the
 * browser verifier. Needs only the file hash, the receipt and a public RPC.
 * Runs in Node and in browsers.
 */
import { mldsa } from "@qorechain/pqc";
import { keccak256, parseAbi, toBytes, toHex, type Address, type Hex, type PublicClient } from "viem";
import { verifyProof } from "./merkle.js";
import { signingMessage } from "./message.js";

export interface ReceiptV2 {
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
  segments: { file: string; sha256: Hex; size: number; index: number; proof: Hex[] }[];
}

export const VERIFY_ABI = parseAbi([
  "struct Anchor { bytes32 root; bytes32 sigHash; bytes32 deviceKeyHash; address owner; uint32 deviceKeyVersion; uint64 windowStart; uint32 windowSeconds; uint32 leafCount; uint64 anchoredAt; uint64 blockNumber; }",
  "struct Verification { bool found; bool included; bytes32 anchorId; bytes32 root; uint64 windowStart; uint32 windowSeconds; uint32 leafCount; uint64 anchoredAt; uint64 blockNumber; bytes32 deviceKeyHash; uint32 deviceKeyVersion; uint8 deviceStatus; uint64 deviceRevokedAt; }",
  "function getAnchor(bytes32 anchorId) view returns (Anchor)",
  "function verifyAnchor(address owner, bytes32 deviceId, uint64 windowStart, bytes32 segmentHash, uint256 index, bytes32[] proof) view returns (Verification)",
]);

export type StepState = "pass" | "fail" | "info" | "warn";
export interface Step { state: StepState; text: string }

export interface VerifyResult {
  ok: boolean;
  steps: Step[];
  anchoredAt?: Date;
  windowStart?: Date;
  windowEnd?: Date;
}

const iso = (s: bigint | number) => new Date(Number(s) * 1000).toISOString();

export async function verifyReceipt(pub: PublicClient, r: ReceiptV2, fileHash: Uint8Array): Promise<VerifyResult> {
  const steps: Step[] = [];
  let ok = true;
  const add = (state: StepState, text: string) => {
    steps.push({ state, text });
    if (state === "fail") ok = false;
    return state !== "fail";
  };
  const done = (): VerifyResult => ({ ok, steps });

  if (r.format !== "qorewitness-receipt/v2") {
    add("fail", `Receipt format "${r.format}" is not supported. This verifier reads qorewitness-receipt/v2.`);
    return done();
  }
  const chainId = await pub.getChainId();
  if (r.chain.evmChainId !== chainId) {
    add("fail", `The receipt is for chain ${r.chain.evmChainId}. The RPC serves chain ${chainId}.`);
    return done();
  }

  const h = toHex(fileHash);
  const seg = r.segments.find((s) => s.sha256 === h);
  if (!seg) {
    add("fail", `The file fingerprint (SHA-256 ${h.slice(0, 14)}…) is not in this receipt. The file was changed, or it belongs to another receipt.`);
    return done();
  }
  add("pass", `File fingerprint found in the receipt (segment ${seg.index + 1} of ${r.segments.length}).`);

  if (verifyProof(toBytes(r.root), fileHash, seg.index, r.segments.length, seg.proof.map((p) => toBytes(p)))) {
    add("pass", "Merkle path from the file to the window root is valid.");
  } else add("fail", "The Merkle path does not lead to the root in the receipt.");

  const v = await pub.readContract({
    address: r.chain.registry, abi: VERIFY_ABI, functionName: "verifyAnchor",
    args: [r.owner, r.deviceId, BigInt(r.windowStart), h, BigInt(seg.index), seg.proof],
  });
  if (!v.found) {
    add("fail", "QoreChain has no anchor for this owner, camera and window.");
    return done();
  }
  if (v.root === r.root) add("pass", `The root is stored on QoreChain in block ${v.blockNumber}.`);
  else add("fail", "The root on chain differs from the root in the receipt.");
  if (v.included) add("pass", "The contract itself confirms the file is part of the anchored window (verifyAnchor).");
  else add("fail", "The contract does not confirm the file (verifyAnchor).");

  if (keccak256(r.devicePubkey) === v.deviceKeyHash) {
    add("pass", `The camera key in the receipt is the key that was registered on chain (version ${v.deviceKeyVersion}).`);
  } else add("fail", "The camera key in the receipt is not the key registered on chain for this anchor.");

  const msg = signingMessage(BigInt(chainId), r.chain.registry, {
    owner: r.owner, deviceId: r.deviceId, windowStart: v.windowStart,
    windowSeconds: v.windowSeconds, leafCount: v.leafCount, root: v.root,
  });
  if (mldsa.verify(toBytes(r.devicePubkey), msg, toBytes(r.signature))) {
    add("pass", "The ML-DSA-87 (post-quantum) signature over the root is valid (checked locally).");
  } else add("fail", "The ML-DSA-87 signature is not valid.");

  const a = await pub.readContract({ address: r.chain.registry, abi: VERIFY_ABI, functionName: "getAnchor", args: [v.anchorId] });
  if (a.sigHash === keccak256(r.signature)) add("pass", "The signature is the same one the contract checked on chain.");
  else add("fail", "The signature differs from the one recorded on chain.");

  if (v.deviceStatus === 2) {
    add("warn", `The owner revoked this camera at ${iso(v.deviceRevokedAt)}. The anchor was made before that, while the camera was active. Check why it was revoked.`);
  }
  add("info", `Camera "${r.deviceLabel}" claims recording between ${iso(v.windowStart)} and ${iso(v.windowStart + BigInt(v.windowSeconds))}.`);

  return {
    ok, steps,
    anchoredAt: new Date(Number(v.anchoredAt) * 1000),
    windowStart: new Date(Number(v.windowStart) * 1000),
    windowEnd: new Date((Number(v.windowStart) + v.windowSeconds) * 1000),
  };
}
