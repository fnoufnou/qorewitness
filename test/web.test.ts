import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { esc, page, tokenOk } from "../src/web/server.js";
import { boxHealth, collectStatus, feeDaysLeft, health, RECEIPT_NAME, summarize, type LocalStatus } from "../src/web/status.js";

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
    const s = collectStatus({ device: "<script>x", receiptDir: f.receipts, segmentDir: f.segments });
    const html = page(s, { level: "ok", text: "<b>" }, "0x1234567890");
    assert.ok(!html.includes("<script>x"));
    // The only script is the hashed box script at the end of the page.
    assert.ok(!/<main>[\s\S]*<script/.test(html.split("</main>")[0] + "</main>"));
    assert.ok(html.includes("&lt;b&gt;"));
  });
});

describe("dashboard: box health in plain words", () => {
  const base: LocalStatus = {
    device: "cam", receipts: 10, unanchored: [], latest: [], lastAnchorAgeSeconds: 240, pendingWindows: 0, openSegments: 1,
    segmentFiles: 100, segmentBytes: 1e9, newestSegmentAgeSeconds: 20, diskFreeBytes: 400e9, diskTotalBytes: 500e9,
  };
  const facts = { windowSeconds: 600, plan: "self" as const, balanceUqor: 50_000_000, setupAgeSeconds: 86_400, qor1: "qor1abc" };

  it("green with the age of the last seal", () => {
    const h = boxHealth(base, facts);
    assert.equal(h.level, "ok");
    assert.equal(h.title, "Sealing OK. Last seal 4 minutes ago.");
    assert.equal(h.action, undefined);
  });

  it("red when the camera sends no video, with one action", () => {
    const h = boxHealth({ ...base, newestSegmentAgeSeconds: 600 }, facts);
    assert.equal(h.level, "bad");
    assert.equal(h.title, "No video from the camera for 10 minutes.");
    assert.match(h.action!, /power and Wi-Fi/);
  });

  it("orange when fees run low on Self-managed, red when they ran out", () => {
    const low = boxHealth(base, { ...facts, balanceUqor: 20_000_000 });
    assert.equal(low.level, "warn");
    assert.equal(low.title, "Fees are running low. Sealing pauses in about 2 days.");
    assert.equal(low.action, "Add test tokens to your own account. The address is under Details.");
    assert.ok(!/QOR|qor1/.test(low.title + low.action));
    assert.equal(boxHealth(base, { ...facts, balanceUqor: 100_000 }).level, "bad");
    assert.equal(Math.round(feeDaysLeft(6_912_000, 600)! * 10) / 10, 1);
  });

  it("Free beta: a normal top-up level is not a warning", () => {
    assert.equal(boxHealth(base, { ...facts, plan: "sponsored", balanceUqor: 15_000_000 }).level, "ok");
    assert.equal(boxHealth(base, { ...facts, plan: "sponsored", balanceUqor: 100_000 }).level, "bad");
  });

  it("orange while the first seal is pending, red after 30 minutes without one", () => {
    const first = { ...base, receipts: 0, lastAnchorAgeSeconds: undefined };
    assert.equal(boxHealth(first, { ...facts, setupAgeSeconds: 300 }).level, "warn");
    assert.equal(boxHealth(first, { ...facts, setupAgeSeconds: 3600 }).level, "bad");
  });

  it("red when sealing stopped or windows could not be sealed, orange on a full disk", () => {
    assert.equal(boxHealth({ ...base, lastAnchorAgeSeconds: 3000 }, facts).level, "bad");
    assert.equal(boxHealth({ ...base, unanchored: ["unanchored-cam-1.json"] }, facts).level, "bad");
    assert.equal(boxHealth({ ...base, diskFreeBytes: 10e9 }, facts).level, "warn");
  });
});

describe("e2e-1 regressions: dashboard words", () => {
  const base: LocalStatus = {
    device: "cam", receipts: 1, unanchored: [], latest: [], lastAnchorAgeSeconds: 60, pendingWindows: 0, openSegments: 1,
    segmentFiles: 3, segmentBytes: 1e8, newestSegmentAgeSeconds: 5, diskFreeBytes: 400e9, diskTotalBytes: 500e9,
  };
  it("says 1 minute, not 1 minutes", () => {
    assert.equal(boxHealth(base, { windowSeconds: 600, plan: "sponsored" }).title, "Sealing OK. Last seal 1 minute ago.");
    assert.equal(boxHealth({ ...base, lastAnchorAgeSeconds: 10 }, { windowSeconds: 600, plan: "sponsored" }).title, "Sealing OK. Last seal less than a minute ago.");
  });
});
