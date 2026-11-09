/**
 * Evidence receipt: one JSON file per anchored window, kept next to the
 * recordings. With the receipt, the segment file and a public RPC, anyone can
 * verify the claim without trusting the camera owner.
 */
import { merkleProof, type Hash } from "../core/merkle.js";
import { hex } from "../core/message.js";
import type { Window } from "./window.js";
import type { Address, Hex } from "viem";

export interface Receipt {
  format: "qorewitness-receipt/v1";
  chain: { evmChainId: number; registry: Address; txHash?: Hex; anchorId?: Hex; blockNumber?: string };
  signer: Address;
  deviceId: Hex;
  deviceLabel: string;
  windowStart: string;
  windowSeconds: number;
  root: Hex;
  signature: Hex; // ML-DSA-87, 4627 bytes
  segments: { file: string; sha256: Hex; size: number; index: number; proof: Hex[] }[];
  opentimestamps?: { calendar: string; ots: string /* base64 */ }[];
}

export function buildReceipt(
  base: Omit<Receipt, "format" | "segments" | "windowStart" | "windowSeconds">,
  w: Window,
): Receipt {
  const hashes: Hash[] = w.segments.map((s) => s.sha256);
  return {
    format: "qorewitness-receipt/v1",
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
