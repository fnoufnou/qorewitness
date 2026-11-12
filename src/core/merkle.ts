/**
 * SHA-256 Merkle tree with RFC 6962 style domain separation.
 *   leaf = sha256(0x00 || segmentHash)
 *   node = sha256(0x01 || left || right)
 * An odd last node moves up one level without hashing (no duplication).
 * Must match contracts/MerkleSha256.sol byte for byte.
 * Runs in Node and in browsers (uses @noble/hashes, no Node APIs).
 */
import { sha256 } from "@noble/hashes/sha2.js";

export type Hash = Uint8Array; // always 32 bytes

const LEAF = Uint8Array.of(0x00);
const NODE = Uint8Array.of(0x01);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function assertHash(h: Uint8Array, what: string): void {
  if (!(h instanceof Uint8Array) || h.length !== 32) throw new Error(`${what} must be 32 bytes`);
}

export function leafHash(segmentHash: Hash): Hash {
  assertHash(segmentHash, "segmentHash");
  return sha256(concat(LEAF, segmentHash));
}

export function nodeHash(left: Hash, right: Hash): Hash {
  return sha256(concat(NODE, left, right));
}

/** Builds all levels. levels[0] are the leaf hashes, the last level holds the root. */
export function buildLevels(segmentHashes: Hash[]): Hash[][] {
  if (segmentHashes.length === 0) throw new Error("a window needs at least one segment");
  const levels: Hash[][] = [segmentHashes.map(leafHash)];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next: Hash[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(i + 1 < cur.length ? nodeHash(cur[i], cur[i + 1]) : cur[i]);
    }
    levels.push(next);
  }
  return levels;
}

export function merkleRoot(segmentHashes: Hash[]): Hash {
  const levels = buildLevels(segmentHashes);
  return levels[levels.length - 1][0];
}

/** Sibling hashes from leaf to root for the segment at `index`. */
export function merkleProof(segmentHashes: Hash[], index: number): Hash[] {
  const levels = buildLevels(segmentHashes);
  if (index < 0 || index >= segmentHashes.length) throw new Error("index out of range");
  const proof: Hash[] = [];
  let i = index;
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l];
    if (i % 2 === 1) proof.push(level[i - 1]);
    else if (i + 1 < level.length) proof.push(level[i + 1]);
    i = Math.floor(i / 2);
  }
  return proof;
}

/** Max proof length, same as MerkleSha256.MAX_PROOF_LENGTH (32 levels for a uint32 leaf count). */
export const MAX_PROOF_LENGTH = 32;

export function verifyProof(root: Hash, segmentHash: Hash, index: number, size: number, proof: Hash[]): boolean {
  if (index < 0 || index >= size || proof.length > MAX_PROOF_LENGTH) return false;
  let h = leafHash(segmentHash);
  let p = 0;
  let i = index;
  let n = size;
  while (n > 1) {
    if (i % 2 === 1) {
      if (p >= proof.length) return false;
      h = nodeHash(proof[p++], h);
    } else if (i + 1 < n) {
      if (p >= proof.length) return false;
      h = nodeHash(h, proof[p++]);
    }
    i = Math.floor(i / 2);
    n = Math.floor((n + 1) / 2);
  }
  return p === proof.length && equal(h, root);
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
