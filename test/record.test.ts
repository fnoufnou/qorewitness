import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

/** Runs record.sh with a fake ffmpeg that writes its arguments to a file. */
function args(env: Record<string, string> = {}): string[] {
  const bin = mkdtempSync(join(tmpdir(), "qw-rec-"));
  const out = join(bin, "args");
  writeFileSync(join(bin, "ffmpeg"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${out}"\n`);
  chmodSync(join(bin, "ffmpeg"), 0o755);
  const r = spawnSync("bash", [resolve("scripts/record.sh")], {
    env: { PATH: `${bin}:${process.env.PATH}`, QW_STREAM_URL: "rtsp://u:p@10.0.0.2:554/stream1", QW_SEGMENT_DIR: mkdtempSync(join(tmpdir(), "qw-seg-")), ...env },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(out, "utf8").trim().split("\n");
}

describe("recorder: sound (audio-decision.md)", () => {
  it("keeps the camera's sound by default: video copied, audio as AAC 32k mono, optional", () => {
    const a = args().join(" ");
    assert.match(a, /-map 0:v -c:v copy -map 0:a:0\? -c:a aac -b:a 32k -ac 1 -f segment/);
  });

  it("QW_AUDIO=0 records video only", () => {
    const a = args({ QW_AUDIO: "0" }).join(" ");
    assert.match(a, /-map 0:v -c:v copy -f segment/);
    assert.doesNotMatch(a, /0:a|aac/);
  });
});
