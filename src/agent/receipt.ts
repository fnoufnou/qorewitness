/**
 * Evidence receipt: one JSON file per anchored window, kept next to the
 * recordings. With the receipt, the segment file and a public RPC, anyone can
 * verify the claim without trusting the camera owner.
 */
import { merkleProof, type Hash } from "../core/merkle.js";
import { hex } from "../core/message.js";
import type { Window } from "./window.js";
import { generator, type Generator } from "./version.js";
import type { Address, Hex } from "viem";

export const RECEIPT_FORMAT = "qorewitness-receipt/v2";

export interface Receipt {
  format: typeof RECEIPT_FORMAT;
  chain: { evmChainId: number; registry: Address; txHash?: Hex; anchorId?: Hex; blockNumber?: string };
  owner: Address; // account that owns the device and sent the anchor
  deviceId: Hex;
  deviceLabel: string;
  devicePubkey: Hex; // ML-DSA-87 device key (2,592 bytes). keccak256 of it is stored on chain.
  windowStart: string;
  windowSeconds: number;
  root: Hex;
  signature: Hex; // ML-DSA-87 by the device key, 4,627 bytes
  segments: { file: string; sha256: Hex; size: number; index: number; proof: Hex[] }[];
  /** Tool, release, commit and spec that made this receipt (added 14 Nov 2026). */
  generator?: Generator;
  /** Settings that shape the computation. Fixed by the spec version, recorded for replay. */
  settings?: { fileHash: "sha256"; merkle: "rfc6962-sha256-promote-odd"; signature: "ml-dsa-87-empty-context" };
  opentimestamps?: { calendar: string; ots: string /* base64 */ }[];
}

export function buildReceipt(
  base: Omit<Receipt, "format" | "segments" | "windowStart" | "windowSeconds">,
  w: Window,
): Receipt {
  const hashes: Hash[] = w.segments.map((s) => s.sha256);
  return {
    format: RECEIPT_FORMAT,
    generator: generator(),
    settings: { fileHash: "sha256", merkle: "rfc6962-sha256-promote-odd", signature: "ml-dsa-87-empty-context" },
    ...base,
    windowStart: w.windowStart.toString(),
    windowSeconds: w.windowSeconds,
    segments: w.segments.map((s, index) => ({
      file: s.path.split(/[\\/]/).pop()!,
      sha256: hex(s.sha256),
      size: s.size,
      index,
      proof: merkleProof(hashes, index).map(hex),
    })),
  };
}
