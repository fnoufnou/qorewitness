import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { humanDuration } from "../src/core/verify.js";
import { GAP_TIP, dashboardPage, sizeText } from "../src/web/server.js";
import { summarize, type LocalStatus } from "../src/web/status.js";
import { renderDone } from "../src/web/wizard.js";
import { verdictOf, type ClipOutcome } from "../web/verifier/package.js";

// Product-owner wording points from the first end-to-end run (team/e2e-1.md).

describe("wording: verifier", () => {
  it("rounds durations into words people use", () => {
    assert.equal(humanDuration(352_666), "About 6 minutes");
    assert.equal(humanDuration(61_000), "About 1 minute");
    assert.equal(humanDuration(42_000), "About 40 seconds");
    assert.equal(humanDuration(800), "About 1 second");
    assert.equal(humanDuration(2.2 * 3600_000), "About 2 hours");
  });

  const clip = (kind: ClipOutcome["kind"], warn?: string): ClipOutcome => ({
    file: "seg_20261122T071653Z.mp4", kind, startMs: Date.UTC(2026, 10, 22, 7, 16), durationMs: 60_000,
    anchoredAt: new Date(Date.UTC(2026, 10, 22, 7, 20)), steps: warn ? [{ state: "warn", text: warn }] : [],
  });

  it("an orange verdict for missing minutes gets one calm line", () => {
    const v = verdictOf([clip("ok"), clip("warn", "About 6 minutes of video are missing before this clip.")], "Europe/Amsterdam");
    assert.equal(v.level, "warn");
    assert.match(v.detail, /The clips are original\. Some minutes are missing, for example when the camera was off\.$/);
    assert.deepEqual(v.notes, ["About 6 minutes of video are missing before this clip."]);
  });

  it("other notes still ask to read them", () => {
    const v = verdictOf([clip("warn", "The owner revoked this camera at 2026-11-23.")], "Europe/Amsterdam");
    assert.match(v.detail, /Read the notes below\.$/);
  });
});

describe("wording: dashboard and done page", () => {
  const receipt = (segs: { startMs: number; durationMs: number; size: number; gapBeforeMs?: number }[]) => JSON.stringify({
    windowStart: "1795330200", windowSeconds: 600, chain: { blockNumber: "10539946", txHash: "0xabc" },
    segments: segs.map((s) => ({ ...s, startMs: String(s.startMs) })),
  });
  const base: LocalStatus = {
    device: "camera-1", receipts: 1, unanchored: [], latest: [], lastAnchorAgeSeconds: 60, pendingWindows: 0, openSegments: 1,
    segmentFiles: 2, segmentBytes: 0, newestSegmentAgeSeconds: 5, diskFreeBytes: 1e10, diskTotalBytes: 2e10,
  };

  it("a partial first window shows the real clip times and how much video it holds, plus the file size", () => {
    const a = summarize("camera-1-1795330200.json", receipt([
      { startMs: 1795330672000, durationMs: 60_000, size: 33_883_821 },
      { startMs: 1795330731000, durationMs: 60_000, size: 33_903_206 },
    ]))!;
    assert.equal(a.videoStartMs, 1795330672000);
    assert.equal(a.videoEndMs, 1795330791000);
    const html = dashboardPage({ status: { ...base, latest: [a] }, health: { level: "ok", title: "Sealing OK." }, csrf: "x" });
    assert.match(html, /<time data-local datetime="2026-11-22T06:57:52\.000Z" data-end="2026-11-22T06:59:51\.000Z">/);
    assert.match(html, /2 minutes of video · 68 MB/);
    assert.match(html, /rather than by e-mail/);
    assert.equal(sizeText(338_813_060), "339 MB");
    assert.equal(sizeText(2.4e9), "2.4 GB");
  });

  it("a full window has no extra note, a gap shows the plain tooltip", () => {
    const segs = Array.from({ length: 10 }, (_, i) => ({ startMs: 1795330200000 + i * 60_000, durationMs: 60_000, size: 1e6, gapBeforeMs: i === 3 ? 352_666 : undefined }));
    const a = summarize("camera-1-1795330200.json", receipt(segs))!;
    const html = dashboardPage({ status: { ...base, latest: [a] }, health: { level: "ok", title: "Sealing OK." }, csrf: "x" });
    assert.doesNotMatch(html, /of video/);
    assert.match(html, /10 MB/);
    assert.ok(html.includes(`title="${GAP_TIP}"`));
    assert.equal(GAP_TIP, "Part of the video is missing here, or the camera restarted");
    assert.doesNotMatch(html, /short gap/);
  });

  it("the done page also shows the address from the installer", () => {
    const html = renderDone("http://qorewitness.local:8080", "http://192.168.1.228:8080");
    assert.match(html, /qorewitness\.local:8080/);
    assert.match(html, /this address also works[\s\S]*192\.168\.1\.228:8080/);
    assert.doesNotMatch(renderDone("http://192.168.1.228:8080", "http://192.168.1.228:8080/"), /also works/);
  });
});

describe("wording: QoreWitness Verify page", () => {
  it("names a changed clip by its recording time, never by its file name", () => {
    const c: ClipOutcome = { file: "demo-clip.mp4", kind: "changed", startMs: Date.UTC(2026, 10, 22, 7, 16), durationMs: 60_000, steps: [] };
    const v = verdictOf([c], "Europe/Amsterdam");
    assert.equal(v.headline, "Changed after sealing");
    assert.doesNotMatch(v.detail, /demo-clip|\.mp4/);
    assert.match(v.detail, /the clip recorded at 08:16 CET/);
  });

  it("heading QoreWitness Verify, a calm try-it button, no demo wording", async () => {
    const { readFileSync } = await import("node:fs");
    const html = readFileSync("web/verifier/index.html", "utf8");
    const main = readFileSync("web/verifier/main.ts", "utf8");
    assert.match(html, /<h1>QoreWitness Verify<\/h1>/);
    assert.match(html, /<title>QoreWitness Verify<\/title>/);
    assert.match(html, />Try it: change one byte and check again</);
    assert.doesNotMatch(html + main, /Tamper demo|demo-clip/i);
  });

  it("a judge can try the public sample in one click, and the page may fetch it from its own site", async () => {
    const { readFileSync } = await import("node:fs");
    const html = readFileSync("web/verifier/index.html", "utf8");
    const main = readFileSync("web/verifier/main.ts", "utf8");
    const build = readFileSync("scripts/build-verifier.mjs", "utf8");
    assert.match(html, /<button id="sample" type="button"[^>]*>Try the sample<\/button>/);
    assert.match(html, /change one byte and watch the result turn red/);
    assert.match(main, /"sample-clip\.mp4"/);
    assert.match(main, /"sample-receipt\.json"/);
    assert.match(main, /URLSearchParams\(location\.search\)\.has\("sample"\)/);
    assert.match(build, /connect-src 'self' https:\/\/evm-testnet\.qore\.host;/);
  });
});

describe("wording: sound in the setup", () => {
  it("the camera screen says that clips keep sound when the microphone is on", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { dataPaths, ensureDirs } = await import("../src/setup/steps.js");
    const { Wizard } = await import("../src/web/wizard.js");
    const { mockChain } = await import("./helpers/mock-chain.js");
    const paths = dataPaths(mkdtempSync(join(tmpdir(), "qw-snd-")));
    ensureDirs(paths);
    const w = new Wizard({ paths, chain: mockChain().chain, sponsor: () => { throw new Error("x"); }, snapshot: async () => ({ ok: false, kind: "unknown", message: "", detail: "" }) });
    const html = await w.render("camera", "x");
    assert.match(html, /My camera films my own property\.<\/span><\/label>\n<p class="hint">Clips keep sound when your camera's microphone is on\. You can switch it off in your camera's app at any time\.<\/p>/);
  });
});
