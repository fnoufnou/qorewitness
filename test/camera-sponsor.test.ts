import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { mldsa } from "@qorechain/pqc";
import { deviceKeyFromSeed } from "../src/agent/device-key.js";
import {
  CAMERA_ERRORS, classifyFfmpegError, parseStreamInfo, parseStreamUrl, proposeRetentionDays, snapshot, tapoUrl,
} from "../src/web/camera.js";
import { SponsorClient, enrollDevice, sponsorBaseUrl, sponsorMessage } from "../src/web/sponsor.js";

const PASS = "S3cret&Pass#1";

function fakeFfmpeg(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "qw-fakeff-"));
  const f = join(dir, "ffmpeg");
  writeFileSync(f, `#!/bin/sh\n${script}\n`);
  chmodSync(f, 0o755);
  return f;
}

describe("camera: Tapo C210 helper", () => {
  it("builds the stream URL with encoded user and password", () => {
    const url = tapoUrl({ host: "192.168.1.20", user: "qw cam", password: PASS, path: "stream1" });
    assert.equal(url, "rtsp://qw%20cam:S3cret%26Pass%231@192.168.1.20:554/stream1");
    const back = parseStreamUrl(url)!;
    assert.equal(back.password, PASS);
    assert.equal(back.user, "qw cam");
    assert.equal(back.path, "stream1");
  });

  it("refuses a host with a path or user info, and short passwords", () => {
    assert.throws(() => tapoUrl({ host: "1.2.3.4/x", user: "u", password: "123456", path: "stream1" }));
    assert.throws(() => tapoUrl({ host: "u@1.2.3.4", user: "u", password: "123456", path: "stream1" }));
    assert.throws(() => tapoUrl({ host: "300.1.1.1", user: "u", password: "123456", path: "stream1" }));
    assert.throws(() => tapoUrl({ host: "1.2.3.4", user: "u", password: "12345", path: "stream1" }));
  });

  it("maps ffmpeg errors to plain words", () => {
    assert.equal(classifyFfmpegError("[rtsp @ 0x1] method DESCRIBE failed: 401 Unauthorized", false), "auth");
    assert.equal(classifyFfmpegError("Connection to tcp://192.168.1.20:554 failed: Connection refused", false), "unreachable");
    assert.equal(classifyFfmpegError("method SETUP failed: 453 Not Enough Bandwidth", false), "busy");
    assert.equal(classifyFfmpegError("method DESCRIBE failed: 404 Not Found", false), "not_found");
    assert.equal(classifyFfmpegError("", true), "timeout");
    assert.ok(!/rtsp|401|URL/i.test(CAMERA_ERRORS.auth.replace("Camera Account", "")));
  });

  it("reads codec, size and frame rate from the stream line", () => {
    const info = parseStreamInfo("  Stream #0:0: Video: h264 (Main), yuv420p(progressive), 2304x1296, 15 fps, 15 tbr, 90k tbn");
    assert.deepEqual(info, { codec: "h264", width: 2304, height: 1296, fps: 15 });
  });

  it("returns the picture on success", async () => {
    const ff = fakeFfmpeg(`echo "  Stream #0:0: Video: h264 (Main), yuv420p, 1920x1080, 15 fps" >&2\nprintf '\\377\\330'; head -c 200 /dev/zero`);
    const r = await snapshot(tapoUrl({ host: "10.0.0.2", user: "u", password: PASS, path: "stream1" }), { ffmpeg: ff });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.jpeg[0], 0xff);
      assert.equal(r.info.width, 1920);
    }
  });

  it("gives a plain error and never shows the password", async () => {
    const ff = fakeFfmpeg(`echo "[rtsp @ 0x1] method DESCRIBE failed: 401 Unauthorized for $*" >&2\nexit 1`);
    const r = await snapshot(tapoUrl({ host: "10.0.0.2", user: "u", password: PASS, path: "stream1" }), { ffmpeg: ff });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.kind, "auth");
      assert.equal(r.message, CAMERA_ERRORS.auth);
      assert.ok(r.detail.includes("rtsp://***@10.0.0.2"), r.detail);
      assert.ok(!r.detail.includes("S3cret"), r.detail);
      assert.ok(!r.message.includes("rtsp://"));
    }
  });

  it("stops after the timeout", async () => {
    const ff = fakeFfmpeg("exec sleep 5");
    const r = await snapshot("rtsp://u:p@10.0.0.2/stream1", { ffmpeg: ff, timeoutMs: 200 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.kind, "timeout");
  });

  it("proposes retention days from free disk", () => {
    assert.equal(proposeRetentionDays(undefined, "stream1"), 14);
    assert.equal(proposeRetentionDays(10e9, "stream1"), 2);
    assert.equal(proposeRetentionDays(500e9, "stream1"), 17);
    assert.equal(proposeRetentionDays(2000e9, "stream2"), 30);
  });
});

describe("sponsor client", () => {
  const key = deviceKeyFromSeed(new Uint8Array(32).fill(7));
  const registry = "0xa1378D6558B32e1f8d37b68cf90e3C93839Da365";
  const deviceId = `0x${"AB".repeat(32)}`;
  const owner = "0xD6C6bDfBE567BcE731907789800205Df0B78ca52";

  it("signs the exact contract text with the camera key", async () => {
    const requests: { url: string; body?: Record<string, unknown> }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, body });
      if (url.endsWith("/v1/challenge")) return new Response(JSON.stringify({ nonce: "n0nce-1234abcd", expires: "2026-11-21T12:05:00Z" }));
      return new Response(JSON.stringify({ status: "enrolled", capPerDayUqor: "15840000" }));
    }) as typeof fetch;
    const client = new SponsorClient("https://sponsor.test/sponsor", fetchFn);
    const a = await enrollDevice(client, { pilotCode: "PILOT-1", registry, deviceId, owner, key });
    assert.deepEqual(a, { status: "enrolled", capPerDayUqor: "15840000" });
    assert.equal(requests[0].url, "https://sponsor.test/sponsor/v1/challenge");
    assert.deepEqual(requests[0].body, { deviceId: deviceId.toLowerCase() });
    const e = requests[1].body!;
    assert.deepEqual(Object.keys(e).sort(), ["deviceId", "devicePubkey", "nonce", "owner", "pilotCode", "signature"]);
    const text = `qorewitness-sponsor-v1|9800|${registry.toLowerCase()}|${deviceId.toLowerCase()}|${owner.toLowerCase()}|n0nce-1234abcd`;
    assert.equal(sponsorMessage(registry, deviceId, owner, "n0nce-1234abcd"), text);
    const sig = Buffer.from(String(e.signature).slice(2), "hex");
    assert.ok(mldsa.verify(key.publicKey, new TextEncoder().encode(text), sig));
    assert.equal(e.devicePubkey, key.publicKeyHex);
  });

  it("does not call the service with an invalid pilot code", async () => {
    let called = false;
    const client = new SponsorClient("https://sponsor.test", (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch);
    assert.equal((await enrollDevice(client, { pilotCode: "x y", registry, deviceId, owner, key })).status, "invalid_code");
    assert.equal(called, false);
  });

  it("maps unknown answers and needs https", async () => {
    const client = new SponsorClient("https://sponsor.test", (async () => new Response(JSON.stringify({ status: "<b>odd</b>" }))) as typeof fetch);
    assert.equal((await client.status(deviceId)).status, "unknown");
    assert.throws(() => sponsorBaseUrl("http://sponsor.example.com"));
    assert.equal(sponsorBaseUrl("http://localhost:8787/"), "http://localhost:8787");
    assert.equal(sponsorBaseUrl(), "https://qorewitness.fnoufnou.com/sponsor");
  });
});
