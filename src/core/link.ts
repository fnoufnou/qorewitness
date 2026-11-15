/**
 * Segment chain (qorewitness-spec/2). Every segment commits to the one before it,
 * across windows. The Merkle tree of a window is built over these links, so a
 * deleted, replaced or re-ordered segment breaks the chain.
 *
 *   link = SHA-256(0x02 || prevLink || fileHash || startMs (uint64 BE) || durationMs (uint32 BE) || sourceFp)
 *
 * spec/3 adds a second, independent file hash (SHA3-256, FIPS 202). A forger must
 * then break SHA-256 and SHA3-256 at the same time:
 *
 *   link = SHA-256(0x03 || prevLink || fileHash || fileSha3 || startMs || durationMs || sourceFp)
 *
 * A segment without fileSha3 uses the spec/2 form. Both forms can sit in one chain.
 * prevLink is 32 zero bytes for the first segment of a device. sourceFp is the
 * SHA-256 of the stream description (codec, size, frame rate, encoder settings),
 * or 32 zero bytes when the file is not a video stream.
 * Runs in Node and in browsers.
 */
import { sha256 } from "@noble/hashes/sha2.js";

export interface SegmentMeta {
  fileHash: Uint8Array; // 32 bytes, SHA-256
  fileSha3?: Uint8Array; // 32 bytes, SHA3-256 (spec/3)
  startMs: bigint; // unix milliseconds of the first frame (recorder clock)
  durationMs: number;
  sourceFp: Uint8Array; // 32 bytes
}

export const ZERO_LINK = new Uint8Array(32);
const TAG_V2 = Uint8Array.of(0x02);
const TAG_V3 = Uint8Array.of(0x03);

function be(value: bigint, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let v = value;
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error("value too large");
  return out;
}

export function segmentLink(prevLink: Uint8Array, m: SegmentMeta): Uint8Array {
  if (prevLink.length !== 32 || m.fileHash.length !== 32 || m.sourceFp.length !== 32) throw new Error("hashes must be 32 bytes");
  if (m.fileSha3 && m.fileSha3.length !== 32) throw new Error("hashes must be 32 bytes");
  if (m.startMs < 0n || !Number.isInteger(m.durationMs) || m.durationMs < 0) throw new Error("bad time values");
  const head = m.fileSha3 ? [TAG_V3, prevLink, m.fileHash, m.fileSha3] : [TAG_V2, prevLink, m.fileHash];
  const parts = [...head, be(m.startMs, 8), be(BigInt(m.durationMs), 4), m.sourceFp];
  const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  return sha256(buf);
}

/** Canonical stream description: the input of sourceFp. */
export function sourceDescription(s: Record<string, string | number | undefined>): string {
  return Object.keys(s).sort().filter((k) => s[k] !== undefined && s[k] !== "").map((k) => `${k}=${s[k]}`).join(";");
}

export function sourceFingerprint(description: string): Uint8Array {
  return description ? sha256(new TextEncoder().encode(description)) : new Uint8Array(32);
}
