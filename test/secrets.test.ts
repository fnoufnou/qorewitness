import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { redactSecrets, safeError } from "../src/core/redact.js";

const SECRET = "Tap0Secret99";
const URL_WITH_PASS = `rtsp://qwuser:${SECRET}@192.168.1.20:554/stream1`;

describe("secret masking", () => {
  it("hides user and password in stream URLs", () => {
    assert.equal(redactSecrets(URL_WITH_PASS), "rtsp://***@192.168.1.20:554/stream1");
    assert.equal(redactSecrets(`[rtsp @ 0x5] method DESCRIBE failed: 401 Unauthorized (${URL_WITH_PASS})`),
      "[rtsp @ 0x5] method DESCRIBE failed: 401 Unauthorized (rtsp://***@192.168.1.20:554/stream1)");
    assert.equal(redactSecrets("rtmps://a:b@x/live and https://u:p%40q@h/x.m3u8"), "rtmps://***@x/live and https://***@h/x.m3u8");
  });

  it("hides a password that holds an unencoded @", () => {
    assert.ok(!redactSecrets("rtsp://u:p@ss@10.0.0.2/stream1").includes("ss@"));
  });

  it("keeps URLs without credentials as they are", () => {
    assert.equal(redactSecrets("rtsp://192.168.1.20:554/stream1"), "rtsp://192.168.1.20:554/stream1");
    assert.equal(redactSecrets("mail me at a@b.c"), "mail me at a@b.c");
  });

  it("safeError gives one redacted line", () => {
    assert.equal(safeError(new Error(`open ${URL_WITH_PASS} failed\nstack line`)), "open rtsp://***@192.168.1.20:554/stream1 failed");
  });

  it("record.sh masks the camera password in ffmpeg output", () => {
    // A fake ffmpeg prints its arguments to stderr, as the real one does in error lines.
    const bin = mkdtempSync(join(tmpdir(), "qw-ff-"));
    writeFileSync(join(bin, "ffmpeg"), `#!/bin/sh\necho "[rtsp @ 0x1] 401 Unauthorized: $*" >&2\nexit 1\n`);
    chmodSync(join(bin, "ffmpeg"), 0o755);
    const seg = mkdtempSync(join(tmpdir(), "qw-seg-"));
    const r = spawnSync("bash", [resolve("scripts/record.sh")], {
      env: { PATH: `${bin}:${process.env.PATH}`, QW_STREAM_URL: URL_WITH_PASS, QW_SEGMENT_DIR: seg },
      encoding: "utf8",
    });
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes("rtsp://***@192.168.1.20:554/stream1"), r.stderr);
    assert.ok(!r.stderr.includes(SECRET));
    assert.ok(!r.stdout.includes(SECRET));
  });
});
