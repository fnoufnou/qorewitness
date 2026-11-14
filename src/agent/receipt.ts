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

export const RECEIPT_FORMAT = "qorewitness-receipt/v3";

/** Read once at start: the commit of the code that runs, not of a later checkout. */
const GENERATOR = generator();

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
  prevRoot: Hex; // root of the previous window of this device (zero for the first)
  refBlock: string; // signed after this block
  refBlockHash: Hex;
  segments: {
    file: string; sha256: Hex; size: number; index: number; proof: Hex[];
    // Segment chain (spec/2)
    prevLink: Hex; link: Hex; startMs: string; durationMs: number; sourceFp: Hex; source: string;
    gapBeforeMs?: number; // time between the end of the previous segment and this one, if more than 2 s
    sourceChanged?: boolean; // stream description differs from the previous segment
  }[];
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
  const links: Hash[] = w.segments.map((s) => {
    if (!s.link || !s.prevLink) throw new Error("segments are not linked (spec/2)");
    return s.link;
  });
  return {
    format: RECEIPT_FORMAT,
    generator: GENERATOR,
    settings: { fileHash: "sha256", merkle: "rfc6962-sha256-promote-odd", signature: "ml-dsa-87-empty-context" },
    ...base,
    windowStart: w.windowStart.toString(),
    windowSeconds: w.windowSeconds,
    segments: w.segments.map((s, index) => {
      const prev = w.segments[index - 1];
      const startMs = s.startMs ?? s.completedAt * 1000;
      const prevEnd = prev ? (prev.startMs ?? prev.completedAt * 1000) + (prev.durationMs ?? 0) : undefined;
      const gap = prevEnd !== undefined ? startMs - prevEnd : 0;
      return {
        file: s.path.split(/[\\/]/).pop()!,
        sha256: hex(s.sha256),
        size: s.size,
        index,
        proof: merkleProof(links, index).map(hex),
        prevLink: hex(s.prevLink!),
        link: hex(s.link!),
        startMs: startMs.toString(),
        durationMs: s.durationMs ?? 0,
        sourceFp: hex(s.sourceFp ?? new Uint8Array(32)),
        source: s.source ?? "",
        ...(gap > 2000 ? { gapBeforeMs: gap } : {}),
        ...(prev && (prev.source ?? "") !== (s.source ?? "") ? { sourceChanged: true } : {}),
      };
    }),
  };
}
