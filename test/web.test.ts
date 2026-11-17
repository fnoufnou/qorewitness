import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { esc, page, tokenOk } from "../src/web/server.js";
import { collectStatus, health, RECEIPT_NAME, summarize } from "../src/web/status.js";

const receipt = (start: number, warn = false) => JSON.stringify({
  windowStart: String(start), windowSeconds: 600,
  chain: { blockNumber: "10", txHash: "0xabc" }, generator: { spec: "qorewitness-spec/3" },
  segments: [{}, warn ? { gapBeforeMs: 5000 } : {}],
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qw-ui-"));
  const receipts = join(root, "receipts");
  const segments = join(root, "segments");
  mkdirSync(receipts);
  mkdirSync(segments);
  writeFileSync(join(receipts, "cam-1794000000.json"), receipt(1794000000));
  writeFileSync(join(receipts, "cam-1794000600.json"), receipt(1794000600, true));
  writeFileSync(join(receipts, "other-1794000600.json"), receipt(1794000600));
  writeFileSync(join(receipts, ".state-cam.json"), JSON.stringify({ pending: [{}], open: [{}, {}] }));
  writeFileSync(join(segments, "seg_20261117T000000Z.mp4"), Buffer.alloc(1000));
  writeFileSync(join(segments, "segments.csv"), "x");
  return { receipts, segments };
}

describe("local dashboard: status", () => {
  it("reads receipts of this camera only, newest first, with warnings", () => {
    const f = fixture();
    const s = collectStatus({ device: "cam", receiptDir: f.receipts, segmentDir: f.segments, now: 1794001800 });
    assert.equal(s.receipts, 2);
    assert.deepEqual(s.latest.map((a) => a.windowStart), [1794000600, 1794000000]);
    assert.equal(s.latest[0].warnings, 1);
    assert.equal(s.lastAnchorAgeSeconds, 600);
    assert.equal(s.pendingWindows, 1);
    assert.equal(s.openSegments, 2);
    assert.equal(s.segmentFiles, 1);
    assert.equal(s.segmentBytes, 1000);
  });

  it("works on an empty install", () => {
    const s = collectStatus({ device: "cam", receiptDir: "/nonexistent/r", segmentDir: "/nonexistent/s" });
    assert.equal(s.receipts, 0);
    assert.equal(health(s, 600).level, "warn");
  });

  it("flags a stalled agent and unanchored windows", () => {
    const f = fixture();
    const stalled = collectStatus({ device: "cam", receiptDir: f.receipts, segmentDir: f.segments, now: 1794010000 });
    assert.equal(health(stalled, 600).level, "bad");
    writeFileSync(join(f.receipts, "unanchored-cam-1794001200.json"), "{}");
    const s = collectStatus({ device: "cam", receiptDir: f.receipts, segmentDir: f.segments, now: 1794001800 });
    assert.equal(health(s, 600).level, "bad");
  });

  it("ignores broken receipts and accepts only receipt file names", () => {
    assert.equal(summarize("x.json", "{not json"), undefined);
    assert.ok(RECEIPT_NAME.test("lsc-indoor-1794726000.json"));
    assert.ok(!RECEIPT_NAME.test("../etc/passwd"));
    assert.ok(!RECEIPT_NAME.test(".state-cam.json"));
    assert.ok(!RECEIPT_NAME.test("unanchored-cam-1794001200.jsonx"));
  });
});

describe("local dashboard: server", () => {
  it("checks the token exactly", () => {
    assert.equal(tokenOk("abc", "abc"), true);
    assert.equal(tokenOk("abd", "abc"), false);
    assert.equal(tokenOk("ab", "abc"), false);
    assert.equal(tokenOk(undefined, "abc"), false);
  });

  it("escapes every value it shows", () => {
    assert.equal(esc(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
    const f = fixture();
    const s = collectStatus({ device: "<script>", receiptDir: f.receipts, segmentDir: f.segments });
    const html = page(s, { level: "ok", text: "<b>" }, "0x1234567890");
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("&lt;b&gt;"));
  });
});
