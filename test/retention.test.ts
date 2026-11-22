import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

function clips(n: number, size = 40) {
  const dir = mkdtempSync(join(tmpdir(), "qw-ret-"));
  for (let i = 0; i < n; i++) writeFileSync(join(dir, `seg_20261122T07${String(i).padStart(2, "0")}00Z.mp4`), Buffer.alloc(size));
  writeFileSync(join(dir, "segments.csv"), "x");
  return dir;
}
const run = (dir: string, env: Record<string, string> = {}) =>
  spawnSync("bash", [resolve("deploy/qw-retention.sh")], { env: { PATH: process.env.PATH, QW_SEGMENT_DIR: dir, QW_DEVICE: "cam", ...env }, encoding: "utf8" });

describe("retention (e2e-1: disk guard)", () => {
  it("deletes the oldest clips when the disk is almost full, and keeps the 2 newest", () => {
    const dir = clips(6);
    // 1000 bytes disk, 50 free (5 %): it must free 150 - 50 = 100 bytes, so 3 clips of 40 bytes.
    const r = run(dir, { QW_DF: "1000 50" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /disk almost full, deleted the 3 oldest clips/);
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("seg_")).sort(), ["seg_20261122T070300Z.mp4", "seg_20261122T070400Z.mp4", "seg_20261122T070500Z.mp4"]);
  });

  it("never deletes the 2 newest clips, even on a full disk", () => {
    const dir = clips(3);
    run(dir, { QW_DF: "1000000 0" });
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("seg_")).length, 2);
    assert.ok(readdirSync(dir).includes("segments.csv"));
  });

  it("does nothing and says nothing with enough free space", () => {
    const dir = clips(4);
    const r = run(dir, { QW_DF: "1000 500" });
    assert.equal(r.stdout, "");
    assert.equal(readdirSync(dir).length, 5);
  });

  it("still deletes by age", () => {
    const dir = clips(3);
    const old = new Date(Date.now() - 20 * 86_400_000);
    utimesSync(join(dir, "seg_20261122T070000Z.mp4"), old, old);
    const r = run(dir, { QW_DF: "1000 500", QW_RETENTION_DAYS: "14" });
    assert.match(r.stdout, /deleted 1 segments older than 14 days/);
  });
});
