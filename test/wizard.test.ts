import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { mldsa } from "@qorechain/pqc";
import {
  MIN_SETUP_UQOR, dataPaths, ensureDirs, readEnvFile, saveCamera, unlockSecretsForTests, type Paths,
} from "../src/setup/steps.js";
import { ensurePairing, readPairing, setPassword } from "../src/web/auth.js";
import type { SnapshotResult } from "../src/web/camera.js";
import { createHandler } from "../src/web/server.js";
import { SponsorClient } from "../src/web/sponsor.js";
import type { FoundCamera } from "../src/web/discover.js";
import { DEFAULT_LABEL, Wizard, freeBytes, screenFor, writeState, type WizardState } from "../src/web/wizard.js";
import { proposeRetentionDays } from "../src/web/camera.js";
import { mockChain } from "./helpers/mock-chain.js";

const CAM_PASS = "Tapo1234Secret";
const PASSWORD = "my long box password";

beforeEach(() => unlockSecretsForTests());

describe("wizard: state machine (3 screens and a progress bar)", () => {
  const cam = { label: DEFAULT_LABEL, host: "10.0.0.2", user: "u", path: "stream1" as const, retentionDays: 14, testedAt: "t" };
  it("walks claim, camera, connect, done", () => {
    let s: WizardState = { v: 2 };
    assert.equal(screenFor(s, { claimed: false, done: false }), "claim");
    assert.equal(screenFor(s, { claimed: true, done: false }), "camera");
    s = { ...s, camera: cam };
    assert.equal(screenFor(s, { claimed: true, done: false }), "camera", "the picture still needs 'Yes, this is my camera'");
    s = { ...s, cameraConfirmed: true };
    assert.equal(screenFor(s, { claimed: true, done: false }), "connect");
    assert.equal(screenFor(s, { claimed: true, done: true }), "done");
  });

  it("an unclaimed box always shows claim, even when setup is done", () => {
    assert.equal(screenFor({ v: 2 }, { claimed: false, done: true }), "claim");
  });
});

// ---------------------------------------------------------------- HTTP flow

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }

class Browser {
  cookies = new Map<string, string>();
  bodies: string[] = [];
  constructor(private readonly port: number, private readonly host = `192.168.1.50:8080`) {}

  call(method: string, path: string, opts: { form?: Record<string, string>; headers?: Record<string, string>; origin?: string | null } = {}): Promise<Res> {
    const body = opts.form ? new URLSearchParams(opts.form).toString() : undefined;
    const headers: Record<string, string> = { host: this.host, ...(opts.headers ?? {}) };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (body !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
    if (method === "POST" && opts.origin !== null) headers.origin = opts.origin ?? `http://${this.host}`;
    return new Promise((ok, fail) => {
      const req = request({ host: "127.0.0.1", port: this.port, method, path, headers }, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          for (const c of ([] as string[]).concat(res.headers["set-cookie"] ?? [])) {
            const [kv] = c.split(";");
            const [k, v] = kv.split("=");
            if (/Max-Age=0/.test(c)) this.cookies.delete(k);
            else this.cookies.set(k, v);
          }
          this.bodies.push(data);
          ok({ status: res.statusCode ?? 0, headers: res.headers, body: data });
        });
      });
      req.on("error", fail);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  get = (path: string, headers?: Record<string, string>) => this.call("GET", path, { headers });
  post = (path: string, form: Record<string, string>, origin?: string | null) => this.call("POST", path, { form, origin });
}

const csrfOf = (html: string) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(300, 1)]);

function setup(opts: { sponsorStatus?: string; grant?: boolean } = {}) {
  const paths: Paths = dataPaths(mkdtempSync(join(tmpdir(), "qw-wiz-")));
  const chainOpts = { balance: 0n };
  const m = mockChain(chainOpts);
  const snapshots: string[] = [];
  let nextSnapshot: SnapshotResult = { ok: true, jpeg: JPEG, info: { codec: "h264", width: 2304, height: 1296, fps: 15 } };
  const sponsorCalls: { url: string; body?: Record<string, unknown> }[] = [];
  const sponsorFetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sponsorCalls.push({ url, body });
    if (url.endsWith("/v1/challenge")) return new Response(JSON.stringify({ nonce: "nonce-0001-abcd", expires: "x" }));
    if (url.includes("/v1/enroll")) {
      const status = opts.sponsorStatus ?? "pending";
      if (status === "pending" && opts.grant !== false) chainOpts.balance = 3_000_000n; // the start grant arrives
      return new Response(JSON.stringify({ status, capPerDayUqor: "9000000" }), { status: status === "pending" ? 200 : 409 });
    }
    return new Response(JSON.stringify({ status: "funded" }));
  }) as typeof fetch;
  const wizard = new Wizard({
    paths, chain: m.chain,
    sponsor: () => new SponsorClient("https://sponsor.test", sponsorFetch),
    snapshot: async (url) => {
      snapshots.push(url);
      return nextSnapshot;
    },
    diskFree: () => 500e9,
    pollMs: 10,
    fundsTimeoutMs: 300,
  });
  const handler = createHandler({ paths, wizard, appDir: process.cwd(), balance: async () => chainOpts.balance });
  return { paths, wizard, handler, chainOpts, m, snapshots, sponsorCalls, setSnapshot: (r: SnapshotResult) => (nextSnapshot = r) };
}

async function listen(handler: ReturnType<typeof createHandler>): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, port: (server.address() as AddressInfo).port };
}

describe("wizard: browser setup over HTTP (mocked chain, camera and sponsor)", () => {
  let t: ReturnType<typeof setup>;
  let server: Server;
  let b: Browser;
  let mnemonic = "";

  before(async () => {
    t = setup();
    ensureDirs(t.paths);
    ensurePairing(t.paths.uiDir);
    const l = await listen(t.handler);
    server = l.server;
    b = new Browser(l.port);
  });
  after(() => server.close());

  it("refuses foreign Host names, proxies and requests without Origin", async () => {
    assert.equal((await b.get("/setup", { host: "evil.example.com" })).status, 421);
    assert.equal((await b.get("/setup", { "x-forwarded-for": "1.2.3.4" })).status, 400);
    assert.equal((await b.post("/setup/pair", { code: "000000" }, null)).status, 403);
    assert.equal((await b.post("/setup/pair", { code: "000000" }, "http://evil.example.com")).status, 403);
  });

  it("needs the pairing code before anything else", async () => {
    const r = await b.get("/");
    assert.equal(r.headers.location, "/setup");
    assert.match((await b.get("/setup")).body, /pairing code/);
    assert.equal((await b.post("/setup/pair", { code: "12345x" })).status, 403);
  });

  it("the link token also works and moves into a cookie", async () => {
    const pairing = readPairing(t.paths.uiDir)!;
    const viaLink = new Browser((server.address() as AddressInfo).port);
    assert.equal((await viaLink.get(`/setup?token=${pairing.token}`)).status, 200);
    assert.match((await viaLink.get("/setup")).body, /Choose a password/);
  });

  it("screen 1: one password field (code typed with a space), CSRF, then the token is gone", async () => {
    const pairing = readPairing(t.paths.uiDir)!;
    assert.equal((await b.post("/setup/pair", { code: `${pairing.code.slice(0, 3)} ${pairing.code.slice(3)}` })).status, 303);
    const form = await b.get("/setup");
    assert.match(form.body, /Choose a password/);
    assert.doesNotMatch(form.body, /Type it again/);
    assert.match(form.body, /Show password/);
    assert.equal((await b.post("/setup/password", { password: PASSWORD, _csrf: "forged" })).status, 403);
    assert.equal((await b.post("/setup/password", { password: "short", _csrf: csrfOf(form.body) })).status, 400);
    assert.equal((await b.post("/setup/password", { password: PASSWORD, _csrf: csrfOf(form.body) })).status, 303);
    assert.ok(b.cookies.has("qw_session"));
    assert.equal(existsSync(join(t.paths.uiDir, "setup-token")), false);
    assert.equal(statSync(join(t.paths.uiDir, "auth.json")).mode & 0o777, 0o600);
  });

  it("screen 2: camera with three fields and one tick, plain error, then the picture", async () => {
    const page = await b.get("/setup");
    assert.match(page.body, /Step 1 of 2/);
    assert.doesNotMatch(page.body, /pilot code|Video quality|Name for this camera|stream URL|Who pays/i);
    const csrf = csrfOf(page.body);
    const fields = { action: "test", host: "192.168.1.20", brand: "tapo", user: "qwcam", password: CAM_PASS, consent: "yes", _csrf: csrf };
    assert.equal((await b.post("/setup/camera", { ...fields, _csrf: "nope" })).status, 403);
    assert.match((await b.post("/setup/camera", { ...fields, consent: "" })).body, /my own property/);

    t.setSnapshot({ ok: false, kind: "auth", message: "The camera refused the password. Check Camera Account in the Tapo app.", detail: "rtsp://***@192.168.1.20:554/stream1 401" });
    const bad = await b.post("/setup/camera", fields);
    assert.match(bad.body, /The camera refused the password/);
    assert.ok(!bad.body.includes(CAM_PASS));
    assert.equal(existsSync(t.paths.cameraEnv), false, "a failed test saves nothing");

    t.setSnapshot({ ok: true, jpeg: JPEG, info: { codec: "h264", width: 2304, height: 1296, fps: 15 } });
    const good = await b.post("/setup/camera", fields);
    assert.match(good.body, /Is this your camera\?/);
    assert.match(good.body, /Yes, this is my camera/);
    assert.match(good.body, /data:image\/jpeg;base64,/);
    assert.doesNotMatch(good.body, /2304|frames per second/);
    assert.ok(!good.body.includes(CAM_PASS));
    assert.equal(t.snapshots.at(-1), `rtsp://qwcam:${CAM_PASS}@192.168.1.20:554/stream1`);
    assert.equal(statSync(t.paths.cameraEnv).mode & 0o777, 0o600);
    assert.equal(readEnvFile(t.paths.cameraEnv).QW_DEVICE, DEFAULT_LABEL);
    const std = await b.post("/setup/camera", { action: "standard", _csrf: csrf });
    assert.match(std.body, /Is this your camera/);
    assert.match(readEnvFile(t.paths.cameraEnv).QW_STREAM_URL, /\/stream2$/);
  });

  it("screen 3: one progress bar to Sealing started, keys made silently, free beta fees without a code", async () => {
    const csrf = csrfOf((await b.get("/setup")).body);
    assert.equal((await b.post("/setup/camera", { action: "confirm", _csrf: csrf })).status, 303);
    const progress = await b.get("/setup");
    assert.match(progress.body, /Connecting your camera|Sealing started/);
    await t.wizard.idle();
    mnemonic = readEnvFile(t.paths.accountEnv).QORE_MNEMONIC;
    assert.equal(mnemonic.split(" ").length, 24);
    assert.equal(statSync(t.paths.accountEnv).mode & 0o777, 0o600);
    const enroll = t.sponsorCalls.find((c) => c.url.endsWith("/v1/enroll"))!.body!;
    assert.equal("pilotCode" in enroll, false, "no pilot code");
    assert.deepEqual(t.m.calls.filter((c) => c !== "assert"), ["registerPqcKey", "ensureWindow", "registerDevice"]);

    assert.equal((await b.get("/setup")).headers.location, "/setup/done");
    const done = (await b.get("/setup/done")).body;
    assert.match(done, /Sealing started/);
    assert.match(done, /http:\/\/192\.168\.1\.50:8080/);
    assert.doesNotMatch(done, /Back up that folder|close this page|never asks for your passwords/, "no friction lines (Pieter, 28 Nov)");
    const info = JSON.parse(readFileSync(t.paths.accountJson, "utf8"));
    assert.equal(info.plan, "sponsored");
    assert.ok(existsSync(t.paths.done));
  });

  it("after setup: dashboard in plain words with Download per row, setup closed, keys locked", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const dir = join(t.paths.data, DEFAULT_LABEL, "receipts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${DEFAULT_LABEL}-1794000000.json`), JSON.stringify({ windowStart: "1794000000", windowSeconds: 600, chain: { blockNumber: "10", txHash: "0xabc" }, segments: [{}] }));
    const dash = await b.get("/");
    assert.equal(dash.status, 200);
    assert.match(dash.body, /class="status (ok|warn|bad)"/);
    assert.match(dash.body, /<time data-local datetime="2026-11-[0-9T:.]+Z"/);
    assert.match(dash.body, /action="\/evidence\/download"[\s\S]*name="fromMs" value="1794000000000"[\s\S]*name="toMs" value="1794000600000"/);
    const main = /<main>([\s\S]*)<\/main>/.exec(dash.body)![1].replace(/<details[\s\S]*?<\/details>/g, "").replace(/<[^>]+>/g, " ");
    assert.doesNotMatch(main, /ML-DSA|\bblock\b|registry|\bQOR\b|Merkle|qor1/i);
    const csrf = csrfOf(dash.body);
    assert.equal((await b.post("/setup/camera", { action: "test", _csrf: csrf })).status, 404);
    assert.equal((await b.get("/setup")).headers.location, "/setup/done");
    assert.throws(() => readEnvFile(t.paths.accountEnv), /no longer reads keys/);
    assert.equal((await b.post("/logout", { _csrf: "x" })).status, 403);
  });

  it("login: wrong passwords are limited", async () => {
    const c = new Browser((server.address() as AddressInfo).port);
    assert.equal((await c.get("/")).headers.location, "/login");
    assert.equal((await c.get("/api/status")).status, 401);
    for (let i = 0; i < 5; i++) assert.equal((await c.post("/login", { password: "wrong password" })).status, 403);
    assert.equal((await c.post("/login", { password: PASSWORD })).status, 429);
  });

  it("never shows a secret in any page", () => {
    const words = mnemonic.split(" ");
    for (const body of b.bodies) {
      assert.ok(!body.includes(CAM_PASS), "camera password in a page");
      assert.ok(!body.includes(words.slice(0, 4).join(" ")), "recovery phrase in a page");
      assert.ok(!body.includes(PASSWORD), "dashboard password in a page");
    }
  });
});

/** A wizard with a confirmed camera, as after "Yes, this is my camera". */
async function confirmed(t: ReturnType<typeof setup>, plan?: "self") {
  ensureDirs(t.paths);
  saveCamera(t.paths, { label: DEFAULT_LABEL, streamUrl: `rtsp://u:${CAM_PASS}@10.0.0.2:554/stream1` });
  writeState(t.paths, { v: 2, plan, camera: { label: DEFAULT_LABEL, host: "10.0.0.2", user: "u", path: "stream1", retentionDays: 14, testedAt: "t" } });
  await t.wizard.post("/setup/camera", { action: "confirm" });
}

describe("wizard: connect step (mocked chain and sponsor)", () => {
  it("Free beta: the camera signs the enrolment, no secret leaves the box", async () => {
    const t = setup();
    await confirmed(t);
    await t.wizard.idle();
    assert.equal(await t.wizard.screen(), "done");
    const enroll = t.sponsorCalls.find((c) => c.url.endsWith("/v1/enroll"))!.body!;
    const mnemonic = readEnvFile(t.paths.accountEnv).QORE_MNEMONIC;
    const sent = JSON.stringify(t.sponsorCalls);
    assert.ok(!sent.includes(mnemonic.split(" ").slice(0, 2).join(" ")));
    assert.ok(!sent.includes(CAM_PASS));
    const registry = readEnvFile(t.paths.accountEnv).QORE_REGISTRY.toLowerCase();
    const text = `qorewitness-sponsor-v1|9800|${registry}|${enroll.deviceId}|${enroll.owner}|nonce-0001-abcd`;
    assert.ok(mldsa.verify(Buffer.from(String(enroll.devicePubkey).slice(2), "hex"), new TextEncoder().encode(text), Buffer.from(String(enroll.signature).slice(2), "hex")));
  });

  it("asks the sponsor for status with the owner, because every box uses the same camera name", async () => {
    const t = setup({ grant: false });
    await confirmed(t);
    await new Promise((ok) => setTimeout(ok, 80));
    t.chainOpts.balance = MIN_SETUP_UQOR;
    await t.wizard.idle();
    const st = t.sponsorCalls.find((c) => c.url.includes("/v1/status/"));
    assert.ok(st, "status was asked");
    assert.match(st!.url, /\?owner=0x[0-9a-f]{40}$/);
    assert.equal(await t.wizard.screen(), "done");
  });

  it("beta full: the progress bar stops in plain words and offers Self-managed", async () => {
    const t = setup({ sponsorStatus: "full" });
    await confirmed(t);
    await t.wizard.idle();
    const html = await t.wizard.render("connect", "x");
    assert.match(html, /The free beta is full/);
    assert.match(html, /Use my own wallet/);
    await t.wizard.post("/setup/connect", { action: "self" });
    assert.equal(t.wizard.state().plan, "self");
    while (t.wizard.state().job?.step !== 2) await new Promise((ok) => setTimeout(ok, 5));
    const waiting = await t.wizard.render("connect", "x");
    assert.match(waiting, /qor1[0-9a-z]+/);
    assert.match(waiting, /href="https:\/\/dashboard\.qorechain\.io\/faucet"/, "a direct link to the faucet");
    assert.match(waiting, /Request Tokens/);
    assert.equal(t.wizard.refreshFor("connect"), 15, "slow refresh while the owner claims test QOR");
    t.chainOpts.balance = MIN_SETUP_UQOR;
    await t.wizard.idle();
    assert.equal(await t.wizard.screen(), "done");
    assert.equal(JSON.parse(readFileSync(t.paths.accountJson, "utf8")).plan, "self");
  });

  it("Self-managed from Advanced never calls the sponsor, and says so when no tokens arrive", async () => {
    const t = setup();
    await confirmed(t, "self");
    await t.wizard.idle();
    assert.equal(t.sponsorCalls.length, 0);
    assert.match(await t.wizard.render("connect", "x"), /No test QOR arrived yet\. Claim them at the faucet/);
  });

  it("resumes an interrupted connect step after a restart", async () => {
    const t = setup();
    await confirmed(t);
    await t.wizard.idle();
    // As if the box restarted in the middle: a job marked running, no setup.done.
    const { rmSync } = await import("node:fs");
    rmSync(t.paths.done);
    const s = t.wizard.state();
    s.job = { kind: "connect", status: "running", step: 3, total: 6, text: "x", startedAt: "t" };
    writeState(t.paths, s);
    const w2 = new Wizard({ paths: t.paths, chain: t.m.chain, sponsor: () => { throw new Error("no sponsor"); }, snapshot: async () => ({ ok: false, kind: "unknown", message: "", detail: "" }), pollMs: 10 });
    assert.equal(await w2.screen(), "connect");
    w2.resumeIfInterrupted();
    await w2.idle();
    assert.equal(await w2.screen(), "done");
    assert.equal(t.m.calls.filter((c) => c === "registerDevice").length, 1, "registered once");
  });

  it("a password set by the claim flow opens setup at the camera screen", async () => {
    const t = setup();
    ensureDirs(t.paths);
    setPassword(t.paths.uiDir, PASSWORD);
    const l = await listen(t.handler);
    try {
      const e = new Browser(l.port, "qorewitness.local:8080");
      const r = await e.post("/login", { password: PASSWORD });
      assert.equal(r.headers.location, "/setup");
      assert.match((await e.get("/setup")).body, /Connect your camera/);
    } finally {
      l.server.close();
    }
  });
});

describe("e2e-1 regressions", () => {
  it("proposes the retention days from the real free disk when no value is injected (server default)", async () => {
    const paths = dataPaths(mkdtempSync(join(tmpdir(), "qw-ret-")));
    ensureDirs(paths);
    const w = new Wizard({
      paths, chain: mockChain().chain, sponsor: () => { throw new Error("no sponsor"); },
      snapshot: async () => ({ ok: true, jpeg: JPEG, info: {} }),
    });
    await w.post("/setup/camera", { action: "test", host: "10.0.0.2", brand: "tapo", user: "qwcam", password: CAM_PASS, consent: "yes" });
    const free = freeBytes(paths.data);
    assert.ok(free && free > 0);
    // Standard quality when high quality fits less than a week (small CI disks).
    const path = proposeRetentionDays(free, "stream1") < 7 ? "stream2" : "stream1";
    assert.equal(readEnvFile(paths.cameraEnv).QW_RETENTION_DAYS, String(proposeRetentionDays(free, path)));
    assert.match(readEnvFile(paths.cameraEnv).QW_STREAM_URL, new RegExp(`/${path}$`));
  });
});

describe("wizard: any camera (find, brand, link)", () => {
  const found = [
    { ip: "192.168.1.20", ports: [554, 2020], onvif: true, name: "TP-IPC", hardware: "C210", brand: "tapo" as const },
    { ip: "192.168.1.31", ports: [554], onvif: false },
  ];
  function wiz(snap: SnapshotResult = { ok: true, jpeg: JPEG, info: { codec: "h264" } }) {
    const paths = dataPaths(mkdtempSync(join(tmpdir(), "qw-any-")));
    ensureDirs(paths);
    const urls: string[] = [];
    const hints: (string | undefined)[][] = [];
    const w = new Wizard({
      paths, chain: mockChain().chain, sponsor: () => { throw new Error("no sponsor"); }, diskFree: () => 500e9,
      snapshot: async (u) => {
        urls.push(u);
        return snap;
      },
      discover: async (h) => {
        hints.push(h);
        return found;
      },
    });
    return { w, paths, urls, hints };
  }

  it("searches the network when the screen opens and lists what it found, brand preselected", async () => {
    const t = wiz();
    const html = await t.w.render("camera", "x", "http://192.168.1.228:8080");
    assert.match(html, /Camera at 192\.168\.1\.20 · TP-IPC C210/);
    assert.match(html, /Camera at 192\.168\.1\.31/);
    assert.match(html, /value="192\.168\.1\.20" data-brand="tapo" checked/);
    assert.match(html, /<option value="tapo" selected>/);
    assert.match(html, /<details data-brandbox[^>]*><summary>Brand: <b data-brandname>TP-Link Tapo<\/b>/, "a known brand is folded, with a way to change it");
    assert.ok(t.hints[0].includes("http://192.168.1.228:8080"));
    await t.w.render("camera", "x", "http://192.168.1.228:8080");
    assert.equal(t.hints.length, 1, "the search result is cached");
    assert.doesNotMatch(html.replace(/<details>[\s\S]*?<\/details>/g, ""), /Tapo app|Tapo C210/, "no Tapo wording outside the brand hints");
  });

  it("shows Searching while the search runs, then the list; skip and rescan work (run 1, 28 Nov)", async () => {
    const paths = dataPaths(mkdtempSync(join(tmpdir(), "qw-any-")));
    ensureDirs(paths);
    let release: (f: FoundCamera[]) => void = () => {};
    let searches = 0;
    const w = new Wizard({
      paths, chain: mockChain().chain, sponsor: () => { throw new Error("no sponsor"); }, diskFree: () => 500e9,
      snapshot: async () => ({ ok: true, jpeg: JPEG, info: {} }),
      discover: (_h, onProgress) => {
        searches++;
        onProgress?.(Object.assign([{ ip: "192.168.1.162", ports: [8554], onvif: false }] as FoundCamera[], { searched: ["192.168.1"] }));
        return new Promise((r) => (release = r));
      },
    });
    const h1 = await w.render("camera", "x", "http://192.168.1.229:8080");
    assert.match(h1, /Searching your network for cameras/);
    assert.match(h1, /role="status"/);
    assert.match(h1, /Found so far:<\/p><ul><li>Camera at 192\.168\.1\.162<\/li>/, "the page shows what is found per /24");
    assert.equal(w.refreshFor("camera"), 2, "the page reloads itself while searching");
    const skip = await w.post("/setup/camera", { action: "skipscan", _csrf: "x" });
    assert.match(skip.html!, /id="host"/);
    assert.doesNotMatch(skip.html!, /No camera answered|Searching/);
    const re = await w.post("/setup/camera", { action: "rescan", _csrf: "x", _base: "http://192.168.1.229:8080" });
    assert.equal(re.redirect, "/setup");
    assert.equal(searches, 2);
    release(Object.assign([] as FoundCamera[], { searched: ["192.168.1", "192.168.0", "192.168.2", "192.168.3"], network: "192.168.0.0/21" }));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(w.refreshFor("camera"), undefined);
    const h2 = await w.render("camera", "x", "http://192.168.1.229:8080");
    assert.match(h2, /We searched 192\.168\.0\.1 to 192\.168\.3\.254 and no camera answered\./);
  });

  it("a camera that is there but silent is not called absent (run 1, 28 Nov)", async () => {
    const paths = dataPaths(mkdtempSync(join(tmpdir(), "qw-any-")));
    ensureDirs(paths);
    const reached: string[] = [];
    let snap: SnapshotResult = { ok: false, kind: "unreachable", message: "No camera answered at this address.", detail: "" };
    const w = new Wizard({
      paths, chain: mockChain().chain, sponsor: () => { throw new Error("no sponsor"); }, diskFree: () => 500e9,
      snapshot: async () => snap,
      reach: async (h, p) => {
        reached.push(`${h}:${p}`);
        return h === "192.168.2.53";
      },
    });
    const form = { action: "test", host: "192.168.2.53", brand: "tapo", user: "dogcam", password: "secret12", consent: "yes" };
    const r1 = await w.post("/setup/camera", form);
    assert.match(r1.html!, /A camera is on this address, but it sent no video/);
    assert.deepEqual(reached, ["192.168.2.53:554"]);
    // Second test after a "No route to host" on a sleeping Wi-Fi camera: the retry gives the picture.
    let calls = 0;
    const paths2 = dataPaths(mkdtempSync(join(tmpdir(), "qw-any-")));
    ensureDirs(paths2);
    const w2 = new Wizard({
      paths: paths2, chain: mockChain().chain, sponsor: () => { throw new Error("no sponsor"); }, diskFree: () => 500e9,
      snapshot: async () => (++calls === 1 ? { ok: false, kind: "unreachable", message: "No camera answered at this address.", detail: "No route to host" } : { ok: true, jpeg: JPEG, info: {} }),
      reach: async () => true,
    });
    assert.match((await w2.post("/setup/camera", form)).html!, /Is this your camera/);
    assert.equal(calls, 2);
    const r2 = await w.post("/setup/camera", { ...form, host: "192.168.2.99" });
    assert.match(r2.html!, /No camera answered at this address/);
    snap = { ok: false, kind: "auth", message: "The camera refused the name or password.", detail: "" };
    const r3 = await w.post("/setup/camera", form);
    assert.match(r3.html!, /refused the name or password\./);
    assert.doesNotMatch(r3.html!, /No camera answered on your network|and no camera answered/, "no search note under a test error");
    assert.equal(reached.length, 2, "no port check after a clear answer");
  });

  it("chooses the quality for the owner: no quality choice on the picture screen, standard on a small disk (Pieter, 28 Nov)", async () => {
    const mk = (free: number) => {
      const paths = dataPaths(mkdtempSync(join(tmpdir(), "qw-any-")));
      ensureDirs(paths);
      const urls: string[] = [];
      const w = new Wizard({ paths, chain: mockChain().chain, sponsor: () => { throw new Error("no sponsor"); }, diskFree: () => free,
        snapshot: async (u) => { urls.push(u); return { ok: true, jpeg: JPEG, info: {} }; } });
      return { w, paths, urls };
    };
    const form = { action: "test", host: "192.168.2.53", brand: "tapo", user: "Dogcam", password: "secret12", consent: "yes" };
    const big = mk(500e9);
    const pic = (await big.w.post("/setup/camera", form)).html!;
    assert.doesNotMatch(pic, /standard quality/i);
    assert.match(readEnvFile(big.paths.cameraEnv).QW_STREAM_URL, /\/stream1$/);
    const small = mk(60e9); // about 2 days of high quality
    await small.w.post("/setup/camera", form);
    assert.equal(small.urls[0], "rtsp://Dogcam:secret12@192.168.2.53:554/stream1", "the test uses high quality");
    assert.match(readEnvFile(small.paths.cameraEnv).QW_STREAM_URL, /\/stream2$/, "the recorder gets standard quality");
    const html = await small.w.render("camera", "x");
    assert.doesNotMatch(html, /never asks for your passwords/, "no footer line");
  });

  it("says that the account name is case-sensitive, and the browser does not fill in an old password", async () => {
    const t = wiz();
    const html = await t.w.render("camera", "x", "http://192.168.1.228:8080");
    assert.match(html, /Upper and lower case count\./);
    assert.match(html, /id="password" name="password" type="password" autocomplete="new-password"/);
  });

  it("a picked camera and a brand give the vendor link, name and password typed only", async () => {
    const t = wiz();
    const r = await t.w.post("/setup/camera", { action: "test", found: "192.168.1.31", brand: "dahua", user: "admin", password: "p&ss 1", consent: "yes" });
    assert.match(r.html!, /Is this your camera/);
    assert.equal(t.urls[0], "rtsp://admin:p%26ss%201@192.168.1.31:554/cam/realmonitor?channel=1&subtype=0");
    const std = await t.w.post("/setup/camera", { action: "standard" });
    assert.match(std.html!, /Is this your camera/);
    assert.equal(t.urls[1], "rtsp://admin:p%26ss%201@192.168.1.31:554/cam/realmonitor?channel=1&subtype=1");
    assert.equal(readEnvFile(t.paths.cameraEnv).QW_STREAM_URL, t.urls[1]);
  });

  it("Other camera: one field for the full link, a typed address wins over the list", async () => {
    const t = wiz();
    const r1 = await t.w.post("/setup/camera", { action: "test", brand: "other", link: "http://x", consent: "yes" });
    assert.match(r1.html!, /starts with rtsp:\/\//);
    await t.w.post("/setup/camera", { action: "test", brand: "other", link: "rtsp://10.0.0.9:8554/live", user: "u", password: "secret12", consent: "yes" });
    assert.equal(t.urls[0], "rtsp://u:secret12@10.0.0.9:8554/live");
    await t.w.post("/setup/camera", { action: "test", found: "192.168.1.20", host: "192.168.1.77", brand: "hikvision", user: "admin", password: "secret12", consent: "yes" });
    assert.equal(t.urls[1], "rtsp://admin:secret12@192.168.1.77:554/Streaming/Channels/101");
  });

  it("asks for a brand, and adds the Tapo recording note only for Tapo", async () => {
    const t = wiz({ ok: false, kind: "no_video", message: "The camera sends no picture.", detail: "" });
    assert.match((await t.w.post("/setup/camera", { action: "test", found: "192.168.1.20", user: "u", password: "secret12", consent: "yes" })).html!, /Pick the brand/);
    const alert = (h: string) => /role="alert">([^<]*)</.exec(h)![1];
    assert.match(alert((await t.w.post("/setup/camera", { action: "test", found: "192.168.1.20", brand: "tapo", user: "u", password: "secret12", consent: "yes" })).html!), /only two of the three work/);
    assert.doesNotMatch(alert((await t.w.post("/setup/camera", { action: "test", found: "192.168.1.31", brand: "reolink", user: "u", password: "secret12", consent: "yes" })).html!), /only two of the three work/);
  });

  it("after a failed test the tick and the typed password stay, the password never in the page", async () => {
    const t = wiz({ ok: false, kind: "unreachable", message: "The camera does not respond.", detail: "" });
    const r = await t.w.post("/setup/camera", { action: "test", host: "192.168.2.53", brand: "tapo", user: "dogcam", password: "s3cret-pass", consent: "yes" });
    assert.match(r.html!, /name="consent" value="yes" checked/);
    assert.match(r.html!, /Leave empty to use the password you typed/);
    assert.doesNotMatch(r.html!, /s3cret-pass/);
    await t.w.post("/setup/camera", { action: "test", host: "192.168.2.53", brand: "tapo", user: "dogcam", password: "", consent: "yes" });
    assert.equal(t.urls[1], "rtsp://dogcam:s3cret-pass@192.168.2.53:554/stream1");
    await t.w.post("/setup/camera", { action: "test", host: "192.168.2.54", brand: "tapo", user: "dogcam", password: "", consent: "yes" });
    assert.ok(!t.urls.some((u) => u.includes("192.168.2.54") && u.includes("s3cret-pass")), "another address does not get the old password");
    const v = await t.w.post("/setup/camera", { action: "test", host: "192.168.2.53", brand: "tapo", user: "dogcam", password: "x", consent: "" });
    assert.doesNotMatch(v.html!, /name="consent" value="yes" checked/);
  });

  it("an unsupported video format is a plain error", async () => {
    const t = wiz({ ok: false, kind: "unsupported", message: "Your camera sends a video format that QoreWitness cannot record yet. In the camera's settings, choose H.264 or H.265 and try again.", detail: "video codec mjpeg" });
    const r = await t.w.post("/setup/camera", { action: "test", found: "192.168.1.31", brand: "axis", user: "u", password: "secret12", consent: "yes" });
    assert.match(r.html!, /choose H\.264 or H\.265/);
    assert.equal(existsSync(t.paths.cameraEnv), false);
  });
});
