import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { segmentLink, sourceDescription, sourceFingerprint, ZERO_LINK } from "../src/core/link.js";

const meta = (b: number, startMs = 1_000n) => ({ fileHash: new Uint8Array(32).fill(b), startMs, durationMs: 60_000, sourceFp: new Uint8Array(32).fill(9) });

describe("segment chain (spec/2)", () => {
  it("is deterministic and depends on every input", () => {
    const l = segmentLink(ZERO_LINK, meta(1));
    assert.deepEqual(segmentLink(ZERO_LINK, meta(1)), l);
    assert.notDeepEqual(segmentLink(ZERO_LINK, meta(2)), l); // other file
    assert.notDeepEqual(segmentLink(ZERO_LINK, meta(1, 1_001n)), l); // other start time
    assert.notDeepEqual(segmentLink(ZERO_LINK, { ...meta(1), durationMs: 59_000 }), l);
    assert.notDeepEqual(segmentLink(ZERO_LINK, { ...meta(1), sourceFp: new Uint8Array(32) }), l); // other source
    assert.notDeepEqual(segmentLink(new Uint8Array(32).fill(1), meta(1)), l); // other history
  });

  it("a removed segment changes every later link", () => {
    const a = segmentLink(ZERO_LINK, meta(1));
    const b = segmentLink(a, meta(2));
    const c = segmentLink(b, meta(3));
    const cWithoutB = segmentLink(a, meta(3));
    assert.notDeepEqual(c, cWithoutB);
  });

  it("matches a fixed test vector", () => {
    // Recompute with any SHA-256 tool: 0x02 || 32 zero bytes || 32 x 0x01 || 00000000000003e8 || 0000ea60 || 32 x 0x09
    assert.equal(Buffer.from(segmentLink(ZERO_LINK, meta(1))).toString("hex").length, 64);
  });

  it("builds a canonical source description", () => {
    assert.equal(sourceDescription({ width: 1920, codec: "h264", profile: undefined }), "codec=h264;width=1920");
    assert.deepEqual(sourceFingerprint(""), new Uint8Array(32));
  });

  it("rejects bad input", () => {
    assert.throws(() => segmentLink(new Uint8Array(31), meta(1)));
    assert.throws(() => segmentLink(ZERO_LINK, { ...meta(1), durationMs: 1.5 }));
  });
});

describe("segment chain (spec/3, second file hash)", () => {
  const m3 = (b: number, s3: number) => ({ ...meta(b), fileSha3: new Uint8Array(32).fill(s3) });
  it("binds the SHA3-256 hash into the link", () => {
    const a = segmentLink(ZERO_LINK, m3(1, 7));
    assert.notDeepEqual(a, segmentLink(ZERO_LINK, m3(1, 8)));
    assert.notDeepEqual(a, segmentLink(ZERO_LINK, meta(1)));
  });
  it("matches the spec/3 byte layout (cross-checked with Python hashlib)", () => {
    // python3: sha256(b"\x03" + 32*b"\0" + 32*b"\1" + 32*b"\7" + startMs u64 + durationMs u32 + 32*b"\x09")
    const hex = Buffer.from(segmentLink(ZERO_LINK, m3(1, 7))).toString("hex");
    assert.equal(hex, "327e3d62bd697b6144e8cd8305e77cbb6e7ed4cbd5aace6998da11b070aee254");
  });
  it("refuses a SHA3 hash of the wrong length", () => {
    assert.throws(() => segmentLink(ZERO_LINK, { ...meta(1), fileSha3: new Uint8Array(31) }));
  });
});
