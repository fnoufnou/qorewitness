import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { dataPaths, ensureDirs } from "../src/setup/steps.js";
import { issueSession, sessionSecret, setPassword } from "../src/web/auth.js";
import { createHandler, type ServerOptions } from "../src/web/server.js";
import type { SponsorAnswer } from "../src/web/sponsor.js";
import type { Wizard } from "../src/web/wizard.js";

// Security review 4: M1 (outside checks in parallel, short limit), M2 (no false reset alarm), L5 (two tabs share one check).

const REGISTRY = "0x1111111111111111111111111111111111111111";
const SEAL_BLOCK = 10_600_000n;
const RESET_TITLE = /test network was reset/;
const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

type Checks = Pick<ServerOptions, "balance" | "sponsorStatus" | "registryCheck" | "cameraCheck" | "checkTimeoutMs">;

async function box(checks: Checks): Promise<{ status: () => Promise<{ code: number; body: { health: { level: string; title: string } } }>; close: () => void }> {
  const paths = dataPaths(mkdtempSync(join(tmpdir(), "qw-checks-")));
  ensureDirs(paths);
  setPassword(paths.uiDir, "a long enough password");
  // Set up two days ago, no video yet: the camera check runs.
  writeFileSync(paths.done, new Date(Date.now() - 2 * 86_400_000).toISOString());
  writeFileSync(paths.cameraEnv, "QW_DEVICE=cam\nQW_STREAM_URL=rtsp://user:pass@192.168.1.20:554/stream1\n", { mode: 0o600 });
  writeFileSync(paths.accountJson, JSON.stringify({
    device: "cam", deviceId: `0x${"ab".repeat(32)}`, owner: "0x2222222222222222222222222222222222222222", qor1: "qor1test",
    registry: REGISTRY, plan: "sponsored", keyFingerprint: "fp", setupAt: new Date().toISOString(),
  }));
  const receipts = join(paths.data, "cam", "receipts");
  mkdirSync(receipts, { recursive: true });
  const start = Math.floor(Date.now() / 1000 / 600) * 600 - 600;
  writeFileSync(join(receipts, `cam-${start}.json`), JSON.stringify({
    windowStart: String(start), windowSeconds: 600, generator: { spec: "qorewitness-spec/3" }, segments: [{}],
    chain: { blockNumber: String(SEAL_BLOCK), txHash: "0xabc", registry: REGISTRY },
  }));
  const cookie = issueSession(sessionSecret(paths.uiDir)!, Date.now());
  const server: Server = createServer(createHandler({ paths, wizard: {} as unknown as Wizard, appDir: process.cwd(), ...checks }));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  const status = () => new Promise<{ code: number; body: { health: { level: string; title: string } } }>((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/status", headers: { host: "192.168.1.50:8080", cookie: `qw_session=${encodeURIComponent(cookie)}` } }, (res) => {
      let text = "";
      res.on("data", (c: Buffer) => (text += c));
      res.on("end", () => ok({ code: res.statusCode ?? 0, body: JSON.parse(text) }));
    });
    req.on("error", fail);
    req.end();
  });
  return { status, close: () => server.close() };
}

/** Four checks that each take `ms` and log when they start and end. */
function slowChecks(ms: number) {
  const log: { name: string; start: number; end: number }[] = [];
  const calls: Record<string, number> = {};
  const timed = <T>(name: string, value: T) => async () => {
    calls[name] = (calls[name] ?? 0) + 1;
    const start = Date.now();
    await sleep(ms);
    log.push({ name, start, end: Date.now() });
    return value;
  };
  const checks: Checks = {
    balance: timed("balance", 50_000_000n),
    cameraCheck: timed("camera", true),
    sponsorStatus: timed<SponsorAnswer>("sponsor", { status: "funded" }),
    registryCheck: timed("registry", { hasCode: true, head: SEAL_BLOCK + 10n }),
  };
  return { checks, log, calls };
}

describe("dashboard: outside checks (security review 4)", () => {
  it("M1: runs the four outside checks at the same time", async () => {
    const s = slowChecks(300);
    const b = await box(s.checks);
    try {
      const t0 = Date.now();
      const r = await b.status();
      const took = Date.now() - t0;
      assert.equal(r.code, 200);
      assert.deepEqual(s.log.map((l) => l.name).sort(), ["balance", "camera", "registry", "sponsor"]);
      // Every check started before the first one ended.
      assert.ok(Math.max(...s.log.map((l) => l.start)) < Math.min(...s.log.map((l) => l.end)), "checks ran one after the other");
      assert.ok(took < 900, `page took ${took} ms, one after the other it is 1200 ms`);
    } finally {
      b.close();
    }
  });

  it("M1: a check that hangs does not hold the page past its limit", async () => {
    const hang = () => new Promise<never>(() => {});
    const b = await box({
      checkTimeoutMs: 200,
      balance: hang, sponsorStatus: hang, registryCheck: hang, cameraCheck: hang,
    });
    try {
      const t0 = Date.now();
      const r = await b.status();
      const took = Date.now() - t0;
      assert.equal(r.code, 200);
      assert.ok(took < 1000, `page took ${took} ms with a 200 ms limit`);
      assert.doesNotMatch(r.body.health.title, RESET_TITLE);
      // The failure is remembered: the next load does not wait again.
      const t1 = Date.now();
      await b.status();
      assert.ok(Date.now() - t1 < 150);
    } finally {
      b.close();
    }
  });

  it("L5: two tabs at the same moment share one call per check", async () => {
    const s = slowChecks(150);
    const b = await box(s.checks);
    try {
      const [x, y] = await Promise.all([b.status(), b.status()]);
      assert.equal(x.code, 200);
      assert.equal(y.code, 200);
      assert.deepEqual(s.calls, { balance: 1, camera: 1, sponsor: 1, registry: 1 });
    } finally {
      b.close();
    }
  });

  it("M2: a lagging node with no contract yet gives no reset line", async () => {
    const b = await box({ registryCheck: async () => ({ hasCode: false, head: SEAL_BLOCK - 50_000n }) });
    try {
      assert.doesNotMatch((await b.status()).body.health.title, RESET_TITLE);
    } finally {
      b.close();
    }
  });

  it("M2: a real reset (chain starts again near block 1) still shows the reset line", async () => {
    const b = await box({ registryCheck: async () => ({ hasCode: false, head: 1200n }) });
    try {
      const h = (await b.status()).body.health;
      assert.equal(h.level, "bad");
      assert.match(h.title, RESET_TITLE);
    } finally {
      b.close();
    }
  });
});
