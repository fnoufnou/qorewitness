import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { describe, it } from "node:test";
import { cameraReachable, streamEndpoint } from "../src/web/camera.js";
import { dashboardPage } from "../src/web/server.js";
import { SponsorClient } from "../src/web/sponsor.js";
import {
  boxHealth, cameraStale, durationText, sealResetSeen, sponsorFacts, type BoxFacts, type BoxHealth, type LocalStatus,
} from "../src/web/status.js";

// W8: every dashboard line says what happened, since when and one thing to do, in plain words.

const base: LocalStatus = {
  device: "cam", receipts: 10, unanchored: [], latest: [], lastAnchorAgeSeconds: 240, pendingWindows: 0, openSegments: 1,
  segmentFiles: 100, segmentBytes: 1e9, newestSegmentAgeSeconds: 20, diskFreeBytes: 400e9, diskTotalBytes: 500e9,
};
const self: BoxFacts = { windowSeconds: 600, plan: "self", balanceUqor: 50_000_000, setupAgeSeconds: 86_400 };
const beta: BoxFacts = { ...self, plan: "sponsored", balanceUqor: 12_000_000 };
const JARGON = /\b(gas|keys?|RPC|hash(es)?|QOR|qor1|uqor|registry|contract|block|anchor\w*|tx|wallet)\b/i;

function plain(h: BoxHealth) {
  assert.ok(!JARGON.test(`${h.title} ${h.action ?? ""}`), `jargon in: ${h.title} ${h.action}`);
  if (h.level !== "ok") assert.ok(h.action, `no action for: ${h.title}`);
}

describe("status rules: durations in words", () => {
  it("rounds to minutes, hours and days", () => {
    assert.equal(durationText(20), "less than a minute");
    assert.equal(durationText(60), "1 minute");
    assert.equal(durationText(45 * 60), "45 minutes");
    assert.equal(durationText(3 * 3600), "about 3 hours");
    assert.equal(durationText(3600 * 1.6), "about 2 hours");
    assert.equal(durationText(3 * 86_400), "about 3 days");
  });
});

describe("status rules: camera and recording", () => {
  it("camera off: red, how long, power and Wi-Fi", () => {
    const h = boxHealth({ ...base, newestSegmentAgeSeconds: 12 * 60 }, { ...self, cameraReachable: false });
    assert.deepEqual([h.level, h.title], ["bad", "No video from the camera for 12 minutes."]);
    assert.match(h.action!, /power and Wi-Fi/);
    plain(h);
  });

  it("camera on but no video: recording stopped, restart the computer", () => {
    const h = boxHealth({ ...base, newestSegmentAgeSeconds: 2 * 3600 }, { ...self, cameraReachable: true });
    assert.equal(h.level, "bad");
    assert.equal(h.title, "Recording stopped about 2 hours ago. The camera is on, but sends no video.");
    assert.match(h.action!, /^Restart the computer that runs QoreWitness/);
    plain(h);
  });

  it("unknown reach keeps the camera line", () => {
    assert.equal(boxHealth({ ...base, newestSegmentAgeSeconds: 600 }, self).title, "No video from the camera for 10 minutes.");
  });

  it("stale only after 5 minutes, or 10 minutes after setup without any video", () => {
    assert.equal(cameraStale({ ...base, newestSegmentAgeSeconds: 299 }), false);
    assert.equal(cameraStale({ ...base, newestSegmentAgeSeconds: 301 }), true);
    assert.equal(cameraStale({ ...base, newestSegmentAgeSeconds: undefined }, 300), false);
    assert.equal(cameraStale({ ...base, newestSegmentAgeSeconds: undefined }, 900), true);
  });
});

describe("status rules: sealing", () => {
  it("no new seal for longer than expected: red with since when", () => {
    const h = boxHealth({ ...base, lastAnchorAgeSeconds: 50 * 60 }, self);
    assert.deepEqual([h.level, h.title], ["bad", "Sealing stopped 50 minutes ago."]);
    plain(h);
    assert.equal(boxHealth({ ...base, lastAnchorAgeSeconds: 25 * 60 }, self).level, "ok");
  });

  it("unsealed video: red for a day, with since when, then quiet", () => {
    const s = { ...base, unanchored: ["unanchored-cam-1795000000.json"], unanchoredAgeSeconds: 3 * 3600 };
    const h = boxHealth(s, self);
    assert.deepEqual([h.level, h.title], ["bad", "Some video from about 3 hours ago could not be sealed."]);
    assert.match(h.action!, /one computer only/);
    plain(h);
    assert.equal(boxHealth({ ...s, unanchoredAgeSeconds: 2 * 86_400 }, self).level, "ok");
  });
});

describe("status rules: fees", () => {
  it("own wallet low: orange with days left", () => {
    const h = boxHealth(base, { ...self, balanceUqor: 7_000_000 });
    assert.deepEqual([h.level, h.title], ["warn", "Fees are running low. Sealing pauses in about 1 day."]);
    plain(h);
  });

  it("own wallet empty: red, since the last seal", () => {
    const h = boxHealth({ ...base, lastAnchorAgeSeconds: 40 * 60 }, { ...self, balanceUqor: 0 });
    assert.deepEqual([h.level, h.title], ["bad", "Sealing paused 40 minutes ago: the fees ran out."]);
    plain(h);
  });

  it("free beta paused: orange while fees last, red when they ran out", () => {
    const paused = { paused: true, limitReached: false };
    const warn = boxHealth(base, { ...beta, sponsor: paused });
    assert.deepEqual([warn.level, warn.title], ["warn", "The free beta paused its fee top-ups. Your fees last about 1 day."]);
    plain(warn);
    const bad = boxHealth({ ...base, lastAnchorAgeSeconds: 3 * 3600 }, { ...beta, balanceUqor: 50_000, sponsor: paused });
    assert.deepEqual([bad.level, bad.title], ["bad", "Sealing paused about 3 hours ago: the free beta is paused."]);
    assert.match(bad.action!, /^Nothing to do/);
    plain(bad);
  });

  it("free beta daily limit reached and fees ran out: red, sealed after midnight", () => {
    const h = boxHealth(base, { ...beta, balanceUqor: 0, sponsor: { paused: false, limitReached: true } });
    assert.deepEqual([h.level, h.title], ["bad", "Sealing paused: today's free beta limit is reached."]);
    assert.match(h.action!, /after midnight/);
    plain(h);
    // With fees left, the limit alone is no problem.
    assert.equal(boxHealth(base, { ...beta, sponsor: { paused: false, limitReached: true } }).level, "ok");
  });

  it("reads the fee service answer", async () => {
    assert.deepEqual(sponsorFacts({ status: "active", paused: false, usedTodayUqor: "9000000", capPerDayUqor: "9000000" }), { paused: false, limitReached: true });
    assert.deepEqual(sponsorFacts({ status: "paused" }), { paused: true, limitReached: false });
    assert.deepEqual(sponsorFacts({ status: "active", usedTodayUqor: "1", capPerDayUqor: "0" }), { paused: false, limitReached: false });
    const body = { status: "active", paused: true, usedTodayUqor: "4000000", capPerDayUqor: "9000000", note: "x" };
    const fake = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
    const a = await new SponsorClient("https://example.invalid", fake).status("0x" + "ab".repeat(32), "0x" + "cd".repeat(20));
    assert.deepEqual(a, { status: "active", capPerDayUqor: "9000000", paused: true, usedTodayUqor: "4000000" });
  });
});

describe("status rules: disk and network reset", () => {
  it("disk nearly full: orange with free space", () => {
    const h = boxHealth({ ...base, diskFreeBytes: 40e9 }, self);
    assert.deepEqual([h.level, h.title], ["warn", "The disk is almost full: 40 GB free."]);
    plain(h);
  });

  it("reset only when the contract is gone and the chain is lower than half our newest seal", () => {
    assert.equal(sealResetSeen({ hasCode: false, head: 1200n }, "10600000"), true);
    assert.equal(sealResetSeen({ hasCode: true, head: 1200n }, "10600000"), false);
    assert.equal(sealResetSeen({ hasCode: false, head: 10_700_000n }, "10600000"), false);
    assert.equal(sealResetSeen({ hasCode: false, head: 1n }, undefined), false);
  });

  it("a lagging node (no contract yet, head some days behind) gives no reset alarm (review 4, M2)", () => {
    assert.equal(sealResetSeen({ hasCode: false, head: 10_550_000n }, "10600000"), false); // 50,000 blocks behind
    assert.equal(sealResetSeen({ hasCode: false, head: 5_300_000n }, "10600000"), false); // exactly half: still no alarm
    assert.equal(sealResetSeen({ hasCode: false, head: 5_299_999n }, "10600000"), true);
    assert.equal(sealResetSeen({ hasCode: false, head: 0n }, "10600000"), true); // a real reset starts near block 1
  });

  it("reset comes first, says to download now", () => {
    const h = boxHealth({ ...base, newestSegmentAgeSeconds: 900 }, { ...self, networkReset: true });
    assert.equal(h.level, "bad");
    assert.equal(h.title, "The test network was reset. Your earlier seals can no longer be checked.");
    assert.match(h.action!, /^Download the evidence files/);
    plain(h);
  });
});

describe("status rules: dashboard and camera probe", () => {
  it("shows one coloured line with its action", () => {
    const h = boxHealth({ ...base, newestSegmentAgeSeconds: 12 * 60 }, { ...self, cameraReachable: false });
    const html = dashboardPage({ status: { ...base, newestSegmentAgeSeconds: 12 * 60 }, health: h });
    assert.match(html, /<div class="status bad" role="status">/);
    assert.ok(html.includes("No video from the camera for 12 minutes."));
    assert.ok(html.includes("Check the power and Wi-Fi of the camera."));
  });

  it("finds host and port without the password", () => {
    assert.deepEqual(streamEndpoint("rtsp://u:p%40ss@192.168.1.20:554/stream1"), { host: "192.168.1.20", port: 554 });
    assert.deepEqual(streamEndpoint("rtsp://u:p@192.168.1.20/stream1"), { host: "192.168.1.20", port: 554 });
    assert.deepEqual(streamEndpoint("http://cam.local/video"), { host: "cam.local", port: 80 });
    assert.equal(streamEndpoint(undefined), undefined);
    assert.equal(streamEndpoint("not a url"), undefined);
  });

  it("a TCP connect tells on from off", async () => {
    const srv: Server = createServer((c) => c.end());
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
    const port = (srv.address() as { port: number }).port;
    assert.equal(await cameraReachable("127.0.0.1", port), true);
    await new Promise<void>((ok) => srv.close(() => ok()));
    assert.equal(await cameraReachable("127.0.0.1", port, 1000), false);
  });
});
