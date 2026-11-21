import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { mldsa } from "@qorechain/pqc";
import { MIN_SETUP_UQOR, dataPaths, readEnvFile, type Paths } from "../src/setup/steps.js";
import { readPairing } from "../src/web/auth.js";
import type { SnapshotResult } from "../src/web/camera.js";
import { createHandler } from "../src/web/server.js";
import { SponsorClient } from "../src/web/sponsor.js";
import { Wizard, screenFor, type Facts, type WizardState } from "../src/web/wizard.js";
import { mockChain } from "./helpers/mock-chain.js";

const CAM_PASS = "Tapo1234Secret";
const PASSWORD = "my long box password";

describe("wizard: state machine", () => {
  const f = (x: Partial<Facts> = {}): Facts => ({ claimed: true, done: false, ownerExists: false, keyExists: false, ...x });
  const cam = { label: "cam", host: "10.0.0.2", user: "u", path: "stream1" as const, retentionDays: 14, testedAt: "t" };

  it("walks claim, camera, plan, account, funding, register, done", () => {
    let s: WizardState = { v: 1 };
    assert.equal(screenFor(s, f({ claimed: false })), "claim");
    assert.equal(screenFor(s, f()), "camera");
    s = { ...s, camera: cam };
    assert.equal(screenFor(s, f()), "camera", "a tested camera still needs 'Looks right'");
    s = { ...s, cameraConfirmed: true };
    assert.equal(screenFor(s, f()), "plan");
    s = { ...s, plan: "self" };
    assert.equal(screenFor(s, f()), "account");
    assert.equal(screenFor(s, f({ ownerExists: true, keyExists: true })), "account", "backup not confirmed");
    s = { ...s, backupAck: true };
    assert.equal(screenFor(s, f({ ownerExists: true, keyExists: true, balanceOk: false })), "funding");
    assert.equal(screenFor(s, f({ ownerExists: true, keyExists: true, balanceOk: true })), "register");
    assert.equal(screenFor(s, f({ done: true })), "done");
  });

  it("stays on register while a registration job runs or failed, even if funds drop", () => {
    const s: WizardState = { v: 1, camera: cam, cameraConfirmed: true, plan: "self", backupAck: true, job: { kind: "register", status: "failed", step: 2, total: 4, text: "", startedAt: "" } };
    assert.equal(screenFor(s, f({ ownerExists: true, keyExists: true, balanceOk: false })), "register");
  });

  it("an unclaimed box always shows claim, even when setup is done", () => {
    assert.equal(screenFor({ v: 1 }, f({ claimed: false, done: true })), "claim");
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

function setup(opts: { sponsorStatus?: string } = {}) {
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
    if (url.includes("/v1/enroll")) return new Response(JSON.stringify({ status: opts.sponsorStatus ?? "enrolled", capPerDayUqor: "15840000" }));
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
    const { ensureDirs } = await import("../src/setup/steps.js");
    const { ensurePairing } = await import("../src/web/auth.js");
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
    assert.equal(r.status, 303);
    assert.equal(r.headers.location, "/setup");
    const page = await b.get("/setup");
    assert.match(page.body, /pairing code/);
    const wrong = await b.post("/setup/pair", { code: "12345x" });
    assert.equal(wrong.status, 403);
    const other = new Browser((server.address() as AddressInfo).port);
    assert.match((await other.get("/setup")).body, /Type the 6-digit pairing code/);
  });

  it("the link token also works and moves into a cookie", async () => {
    const pairing = readPairing(t.paths.uiDir)!;
    const viaLink = new Browser((server.address() as AddressInfo).port);
    const r = await viaLink.get(`/setup?token=${pairing.token}`);
    assert.equal(r.status, 200);
    assert.ok(viaLink.cookies.has("qw_claim"));
    assert.match((await viaLink.get("/setup")).body, /Choose a password/);
  });

  it("sets the password with CSRF, then deletes the pairing token", async () => {
    const pairing = readPairing(t.paths.uiDir)!;
    assert.equal((await b.post("/setup/pair", { code: pairing.code })).status, 303);
    const form = await b.get("/setup");
    assert.match(form.body, /Choose a password/);
    assert.equal((await b.post("/setup/password", { password: PASSWORD, again: PASSWORD, _csrf: "forged" })).status, 403);
    assert.equal((await b.post("/setup/password", { password: "short", again: "short", _csrf: csrfOf(form.body) })).status, 400);
    const ok = await b.post("/setup/password", { password: PASSWORD, again: PASSWORD, _csrf: csrfOf(form.body) });
    assert.equal(ok.status, 303);
    assert.ok(b.cookies.has("qw_session"));
    assert.equal(existsSync(join(t.paths.uiDir, "setup-token")), false);
    assert.equal(statSync(join(t.paths.uiDir, "auth.json")).mode & 0o777, 0o600);
  });

  it("camera: plain error on a wrong password, picture on success, camera.env 600", async () => {
    const page = await b.get("/setup");
    assert.match(page.body, /Connect your camera/);
    const csrf = csrfOf(page.body);
    const fields = { action: "test", host: "192.168.1.20", user: "qwcam", password: CAM_PASS, path: "stream1", label: "drive-way", consent: "yes", _csrf: csrf };
    assert.equal((await b.post("/setup/camera", { ...fields, _csrf: "nope" })).status, 403);
    assert.match((await b.post("/setup/camera", { ...fields, consent: "" })).body, /films your own property/);

    t.setSnapshot({ ok: false, kind: "auth", message: "The camera refused the password. Check Camera Account in the Tapo app.", detail: "rtsp://***@192.168.1.20:554/stream1 401" });
    const bad = await b.post("/setup/camera", fields);
    assert.match(bad.body, /The camera refused the password/);
    assert.ok(!bad.body.includes(CAM_PASS));
    assert.equal(existsSync(t.paths.cameraEnv), false, "a failed test saves nothing");

    t.setSnapshot({ ok: true, jpeg: JPEG, info: { codec: "h264", width: 2304, height: 1296, fps: 15 } });
    const good = await b.post("/setup/camera", fields);
    assert.match(good.body, /Is this your camera\?/);
    assert.match(good.body, /data:image\/jpeg;base64,/);
    assert.ok(!good.body.includes(CAM_PASS));
    assert.equal(t.snapshots.at(-1), `rtsp://qwcam:${CAM_PASS}@192.168.1.20:554/stream1`);
    assert.equal(statSync(t.paths.cameraEnv).mode & 0o777, 0o600);
    assert.equal(readEnvFile(t.paths.cameraEnv).QW_DEVICE, "drive-way");

    const std = await b.post("/setup/camera", { action: "standard", _csrf: csrf });
    assert.match(std.body, /Standard quality/);
    assert.match(readEnvFile(t.paths.cameraEnv).QW_STREAM_URL, /\/stream2$/);
    assert.equal((await b.post("/setup/camera", { action: "confirm", _csrf: csrf })).status, 303);
  });

  it("plan, keys and backup note, funding, registration, done", async () => {
    let page = await b.get("/setup");
    assert.match(page.body, /Who pays the network fees/);
    const csrf = csrfOf(page.body);
    assert.match((await b.post("/setup/plan", { plan: "sponsored", pilotCode: "bad code!", _csrf: csrf })).body, /pilot code/);
    await b.post("/setup/plan", { plan: "self", _csrf: csrf });

    page = await b.get("/setup");
    assert.match(page.body, /Create the keys/);
    await b.post("/setup/account", { action: "create", _csrf: csrf });
    mnemonic = readEnvFile(t.paths.accountEnv).QORE_MNEMONIC;
    assert.equal(mnemonic.split(" ").length, 24);
    assert.equal(statSync(t.paths.accountEnv).mode & 0o777, 0o600);
    page = await b.get("/setup");
    assert.match(page.body, /Keep a backup/);
    assert.match((await b.post("/setup/account", { action: "ack", _csrf: csrf })).body, /Tick the box/);
    await b.post("/setup/account", { action: "ack", backup: "yes", _csrf: csrf });

    page = await b.get("/setup");
    assert.match(page.body, /Add free test tokens/);
    assert.match(page.body, /qor1[0-9a-z]+/);
    assert.match(page.body, /http-equiv="refresh"/);

    t.chainOpts.balance = MIN_SETUP_UQOR;
    await b.post("/setup/funding", { action: "check", _csrf: csrf });
    page = await b.get("/setup");
    assert.match(page.body, /Ready to connect/);
    assert.equal((await b.post("/setup/register", { _csrf: csrf })).status, 303);
    await t.wizard.idle();
    assert.deepEqual(t.m.calls.filter((c) => c !== "assert"), ["registerPqcKey", "ensureWindow", "registerDevice"]);

    const done = await b.get("/setup");
    assert.equal(done.headers.location, "/setup/done");
    assert.match((await b.get("/setup/done")).body, /Sealing started/);
    const info = JSON.parse(readFileSync(t.paths.accountJson, "utf8"));
    assert.equal(info.device, "drive-way");
    assert.equal(info.plan, "self");
    assert.ok(existsSync(t.paths.done));
  });

  it("after setup: /setup is closed, the dashboard shows status in plain words", async () => {
    const dash = await b.get("/");
    assert.equal(dash.status, 200);
    assert.match(dash.body, /class="status (ok|warn|bad)"/);
    assert.match(dash.body, /Network fees/);
    const csrf = csrfOf(dash.body);
    assert.equal((await b.post("/setup/camera", { action: "test", _csrf: csrf })).status, 404);
    assert.equal((await b.get("/setup")).headers.location, "/setup/done");
    assert.equal((await b.post("/setup/register", { _csrf: csrf })).status, 404);
    const api = JSON.parse((await b.get("/api/status")).body);
    assert.ok(["ok", "warn", "bad"].includes(api.health.level));
    assert.equal((await b.post("/logout", { _csrf: "x" })).status, 403);
  });

  it("login: wrong passwords are limited, the right one opens the dashboard", async () => {
    const port = (server.address() as AddressInfo).port;
    const c = new Browser(port);
    assert.equal((await c.get("/")).headers.location, "/login");
    assert.equal((await c.get("/api/status")).status, 401);
    for (let i = 0; i < 5; i++) assert.equal((await c.post("/login", { password: "wrong password" })).status, 403);
    assert.equal((await c.post("/login", { password: PASSWORD })).status, 429);
    // The limiter also counts all clients together for one minute. A fresh handler checks the good path.
    const t2 = setup();
    const { setPassword } = await import("../src/web/auth.js");
    const { ensureDirs } = await import("../src/setup/steps.js");
    ensureDirs(t2.paths);
    setPassword(t2.paths.uiDir, PASSWORD);
    const l2 = await listen(t2.handler);
    try {
      const e = new Browser(l2.port, "qorewitness.local:8080");
      const r = await e.post("/login", { password: PASSWORD });
      assert.equal(r.status, 303);
      assert.equal(r.headers.location, "/setup");
    } finally {
      l2.server.close();
    }
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

describe("wizard: Fees included plan (mocked sponsor)", () => {
  it("enrolls with a camera signature, waits for fees, then registers", async () => {
    const t = setup();
    const { ensureDirs, saveCamera } = await import("../src/setup/steps.js");
    const { writeState } = await import("../src/web/wizard.js");
    ensureDirs(t.paths);
    saveCamera(t.paths, { label: "cam", streamUrl: `rtsp://u:${CAM_PASS}@10.0.0.2:554/stream1` });
    writeState(t.paths, { v: 1, camera: { label: "cam", host: "10.0.0.2", user: "u", path: "stream1", retentionDays: 14, testedAt: "t" }, cameraConfirmed: true });
    await t.wizard.post("/setup/plan", { plan: "sponsored", pilotCode: "PILOT-42" });
    await t.wizard.post("/setup/account", { action: "create" });
    await t.wizard.post("/setup/account", { action: "ack", backup: "yes" });
    await t.wizard.idle();
    assert.equal(t.wizard.state().sponsor?.status, "enrolled");
    const enroll = t.sponsorCalls.find((c) => c.url.endsWith("/v1/enroll"))!.body!;
    assert.equal(enroll.pilotCode, "PILOT-42");
    const mnemonic = readEnvFile(t.paths.accountEnv).QORE_MNEMONIC;
    assert.ok(!JSON.stringify(t.sponsorCalls).includes(mnemonic.split(" ")[0] + " " + mnemonic.split(" ")[1]));
    assert.ok(!JSON.stringify(t.sponsorCalls).includes(CAM_PASS));
    const text = `qorewitness-sponsor-v1|9800|${String(t.wizard.state() && readEnvFile(t.paths.accountEnv).QORE_REGISTRY).toLowerCase()}|${enroll.deviceId}|${enroll.owner}|nonce-0001-abcd`;
    assert.ok(mldsa.verify(Buffer.from(String(enroll.devicePubkey).slice(2), "hex"), new TextEncoder().encode(text), Buffer.from(String(enroll.signature).slice(2), "hex")));

    assert.equal(await t.wizard.screen(), "funding");
    const html = await t.wizard.render("funding", "x");
    assert.ok(!/mnemonic|ML-DSA|EVM|gas|faucet/i.test(html.replace(/<details>[\s\S]*<\/details>/, "")), "no jargon on the main screen");
    t.chainOpts.balance = MIN_SETUP_UQOR;
    await t.wizard.post("/setup/funding", { action: "check" });
    assert.equal(await t.wizard.screen(), "register");
    await t.wizard.post("/setup/register", {});
    await t.wizard.idle();
    assert.equal(t.wizard.state().job?.error, undefined);
    assert.equal(await t.wizard.screen(), "done");
  });

  it("shows a clear stop and a way back when the pilot is full", async () => {
    const t = setup({ sponsorStatus: "full" });
    const { ensureDirs, saveCamera } = await import("../src/setup/steps.js");
    const { writeState } = await import("../src/web/wizard.js");
    ensureDirs(t.paths);
    saveCamera(t.paths, { label: "cam", streamUrl: "rtsp://u:p@10.0.0.2:554/stream1" });
    writeState(t.paths, { v: 1, camera: { label: "cam", host: "10.0.0.2", user: "u", path: "stream1", retentionDays: 14, testedAt: "t" }, cameraConfirmed: true });
    await t.wizard.post("/setup/plan", { plan: "sponsored", pilotCode: "PILOT-42" });
    await t.wizard.post("/setup/account", { action: "create" });
    await t.wizard.post("/setup/account", { action: "ack", backup: "yes" });
    await t.wizard.idle();
    const html = await t.wizard.render("funding", "x");
    assert.match(html, /The pilot is full/);
    assert.match(html, /Choose another plan/);
    await t.wizard.post("/setup/plan", { action: "reset" });
    assert.equal(await t.wizard.screen(), "plan");
  });

  it("resumes an interrupted registration after a restart", async () => {
    const t = setup();
    const { ensureDirs, saveCamera, ensureOwnerAccount, ensureDeviceKey } = await import("../src/setup/steps.js");
    const { writeState } = await import("../src/web/wizard.js");
    ensureDirs(t.paths);
    saveCamera(t.paths, { label: "cam", streamUrl: "rtsp://u:p@10.0.0.2:554/stream1" });
    await ensureOwnerAccount(t.paths);
    ensureDeviceKey(t.paths, "cam");
    t.chainOpts.balance = MIN_SETUP_UQOR;
    writeState(t.paths, {
      v: 1, camera: { label: "cam", host: "10.0.0.2", user: "u", path: "stream1", retentionDays: 14, testedAt: "t" }, cameraConfirmed: true,
      plan: "self", backupAck: true, job: { kind: "register", status: "running", step: 2, total: 4, text: "Protect your account", startedAt: "t" },
    });
    // A new Wizard, as after a restart of the ui container.
    const w2 = new Wizard({ paths: t.paths, chain: t.m.chain, sponsor: () => { throw new Error("no sponsor"); }, snapshot: async () => ({ ok: false, kind: "unknown", message: "", detail: "" }) });
    assert.equal(await w2.screen(), "register");
    w2.resumeIfInterrupted();
    await w2.idle();
    assert.equal(await w2.screen(), "done");
  });
});
