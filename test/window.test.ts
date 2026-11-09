import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WindowBatcher, type Segment } from "../src/agent/window.js";

const seg = (t: number, name = `s${t}.mp4`): Segment => ({ path: name, sha256: new Uint8Array(32).fill(t % 251), size: 1, completedAt: t });

describe("WindowBatcher", () => {
  it("groups segments into fixed windows and closes them after the grace time", () => {
    const b = new WindowBatcher(600);
    for (const t of [1200, 1500, 1799, 1800, 2000]) b.add(seg(t));
    assert.deepEqual(b.closeReady(1804), []);
    const ready = b.closeReady(1805);
    assert.equal(ready.length, 1);
    assert.equal(ready[0].windowStart, 1200n);
    assert.deepEqual(ready[0].segments.map((s) => s.completedAt), [1200, 1500, 1799]);
    assert.deepEqual(b.openSegments().map((s) => s.completedAt), [1800, 2000]);
  });

  it("a new batcher fed with openSegments() gives the same windows (restart keeps open segments)", () => {
    const a = new WindowBatcher(600);
    for (const t of [1200, 1300, 1400]) a.add(seg(t));
    const restarted = new WindowBatcher(600);
    for (const s of a.openSegments()) restarted.add(s);
    restarted.add(seg(1500));
    const [w] = restarted.closeReady(2000);
    assert.deepEqual(w.segments.map((s) => s.completedAt), [1200, 1300, 1400, 1500]);
  });

  it("refuses window lengths below 10 seconds", () => {
    assert.throws(() => new WindowBatcher(5));
  });
});
