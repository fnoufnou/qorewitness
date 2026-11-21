import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

/** Starts the entrypoint in supervise mode with a tiny child that prints its settings. */
function supervise(data: string) {
  const p = spawn("bash", [resolve("deploy/docker-entrypoint.sh"), "supervise", "--", "sh", "-c", 'echo "child $QW_DEVICE $QW_SEGMENT_DIR"; exec sleep 30'], {
    env: { PATH: process.env.PATH, QW_APP: resolve("."), QW_DATA: data, QW_SUPERVISE_POLL: "0.2" },
  });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  const waitFor = async (text: string, ms = 5000) => {
    const end = Date.now() + ms;
    while (!out.includes(text)) {
      if (Date.now() > end) throw new Error(`timeout waiting for "${text}". Output:\n${out}`);
      await new Promise((ok) => setTimeout(ok, 50));
    }
  };
  const exited = new Promise<number | null>((ok) => p.on("exit", (code) => ok(code)));
  /** TERM lets the trap stop the child too, so no orphan keeps the pipes open. */
  const stop = async () => {
    if (p.exitCode === null) p.kill("SIGTERM");
    return exited;
  };
  return { p, waitFor, stop, out: () => out };
}

describe("docker entrypoint: supervise mode", () => {
  it("waits for setup.done, restarts on a camera.env change, stops on TERM", async () => {
    const data = mkdtempSync(join(tmpdir(), "qw-sup-"));
    const s = supervise(data);
    try {
      await s.waitFor("waiting for setup");
      await new Promise((ok) => setTimeout(ok, 400));
      assert.ok(!s.out().includes("child "), "child must not start before setup.done");

      writeFileSync(join(data, "camera.env"), "QW_DEVICE=cam1\n", { mode: 0o600 });
      writeFileSync(join(data, "setup.done"), "");
      await s.waitFor(`child cam1 ${data}/cam1/segments`);

      writeFileSync(join(data, "camera.env"), "QW_DEVICE=cam2\n", { mode: 0o600 });
      await s.waitFor("camera settings changed, restarting");
      await s.waitFor(`child cam2 ${data}/cam2/segments`);

      assert.equal(await s.stop(), 0);
    } finally {
      await s.stop();
    }
  });

  it("reads camera.env as data and never runs it as shell code", async () => {
    const data = mkdtempSync(join(tmpdir(), "qw-sup-"));
    const marker = join(data, "pwned");
    writeFileSync(join(data, "camera.env"), `QW_DEVICE=cam\nQW_STREAM_URL=rtsp://u:$(touch ${marker})@10.0.0.2/stream1\n`, { mode: 0o600 });
    writeFileSync(join(data, "setup.done"), "");
    const s = supervise(data);
    try {
      await s.waitFor("child cam");
      assert.equal(existsSync(marker), false);
    } finally {
      await s.stop();
    }
  });

  it("treats an older terminal install with receipts as done", async () => {
    const data = mkdtempSync(join(tmpdir(), "qw-sup-"));
    writeFileSync(join(data, "camera.env"), "QW_DEVICE=old\n", { mode: 0o600 });
    writeFileSync(join(data, "qorewitness.env"), "QORE_NETWORK=testnet\n", { mode: 0o600 });
    mkdirSync(join(data, "old", "receipts"), { recursive: true });
    writeFileSync(join(data, "old", "receipts", "old-1794000000.json"), "{}");
    const s = supervise(data);
    try {
      await s.waitFor("child old");
      assert.ok(existsSync(join(data, "setup.done")));
    } finally {
      await s.stop();
    }
  });
});
