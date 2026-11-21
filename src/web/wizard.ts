/**
 * Browser setup for one camera. Kept short on purpose (keep it simple):
 *   claim     pairing code or link, then a dashboard password   (rendered here, checked in server.ts)
 *   camera    camera address, camera account name and password, one tick. "Is this your camera?" with a picture
 *   connect   one progress bar that starts by itself: keys and account (silent), network fees, registration
 *   done      "Sealing started", the dashboard address, one backup line
 *
 * "Fees included" (the pilot sponsor) is the default and needs no code. "Use my own
 * wallet" (Self-managed) sits under "Advanced" on the camera screen, and is offered
 * when the pilot is full.
 *
 * screenFor() is a pure state machine. Wizard keeps the state in
 * /data/ui/setup-state.json (mode 600, no passwords) and runs the connect step as a
 * job in this process, so a closed browser or a restart resumes it. Chain, sponsor
 * and camera access go through injected dependencies.
 */
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { deviceIdOf } from "../core/message.js";
import { safeError } from "../core/redact.js";
import {
  FAUCET, MIN_SETUP_UQOR, REGISTER_STEPS, ensureDeviceKey, ensureOwnerAccount, finishSetup, isSetupDone, keyFingerprint,
  readAccountInfo, readEnvFile, readOwnerPublic, registerOnChain, saveCamera, writeSecretFile, type ChainOps, type Paths, type Plan,
} from "../setup/steps.js";
import { cameraAccountProblem, cameraHostProblem, parseStreamUrl, proposeRetentionDays, tapoUrl, type SnapshotResult, type StreamPath } from "./camera.js";
import { esc, hidden } from "./html.js";
import { SPONSOR_TEXT, enrollDevice, type SponsorClient, type SponsorStatus } from "./sponsor.js";

export type Screen = "claim" | "camera" | "connect" | "done";

/** Every box uses this camera name. The device id is per owner on chain, so it does not clash. */
export const DEFAULT_LABEL = "camera-1";

export interface JobState {
  kind: "connect";
  status: "running" | "failed" | "done";
  step: number;
  total: number;
  text: string;
  /** Why it stopped: the pilot said no, no fees arrived, or another error. */
  reason?: "sponsor_stop" | "no_funds" | "error";
  error?: string;
  startedAt: string;
}

export interface WizardState {
  v: 2;
  camera?: { label: string; host: string; user: string; path: StreamPath; retentionDays: number; testedAt: string };
  cameraConfirmed?: boolean;
  plan?: Plan; // default "sponsored"
  sponsor?: { status: SponsorStatus; at: string };
  job?: JobState;
}

export interface Facts {
  claimed: boolean; // a dashboard password exists
  done: boolean; // setup.done exists
}

const SPONSOR_STOP: SponsorStatus[] = ["full", "invalid_code", "used_code", "paused", "rejected"];

/** Which screen to show. Pure: the same state and facts give the same screen. */
export function screenFor(s: WizardState, f: Facts): Screen {
  if (!f.claimed) return "claim";
  if (f.done) return "done";
  if (!s.camera || !s.cameraConfirmed) return "camera";
  return "connect";
}

export interface WizardDeps {
  paths: Paths;
  chain: ChainOps;
  sponsor: () => SponsorClient;
  snapshot: (url: string) => Promise<SnapshotResult>;
  diskFree?: () => number | undefined;
  /** How often the connect step checks the balance and the sponsor (default 10 s). */
  pollMs?: number;
  /** How long the connect step waits for network fees (default 20 minutes). */
  fundsTimeoutMs?: number;
}

export interface PostResult {
  redirect?: string;
  html?: string; // body of a page to show directly (camera test result)
}

const statePath = (p: Paths) => `${p.uiDir}/setup-state.json`;

export function readState(p: Paths): WizardState {
  try {
    const s = JSON.parse(readFileSync(statePath(p), "utf8")) as WizardState;
    return s.v === 2 ? s : { v: 2 };
  } catch {
    return { v: 2 };
  }
}

export function writeState(p: Paths, s: WizardState): void {
  writeSecretFile(statePath(p), JSON.stringify(s, null, 2) + "\n");
}

const eyebrow = (n: 1 | 2, text: string) =>
  `<div class="steps" aria-hidden="true"><span class="on"></span><span class="${n === 2 ? "on" : ""}"></span></div><div class="eyebrow">Step ${n} of 2 · ${esc(text)}</div>`;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const CONNECT_TOTAL = 2 + REGISTER_STEPS.length;

class StopError extends Error {
  constructor(readonly reason: NonNullable<JobState["reason"]>, message: string) {
    super(message);
  }
}

export class Wizard {
  private running?: Promise<void>;
  private lastSnapshot?: Buffer;
  private ownerPub?: { cosmos: string; evm: `0x${string}`; registry: `0x${string}` };

  constructor(private readonly d: WizardDeps) {}

  get paths() {
    return this.d.paths;
  }

  state(): WizardState {
    return readState(this.d.paths);
  }

  private save(s: WizardState): void {
    writeState(this.d.paths, s);
  }

  private update(change: (s: WizardState) => void): void {
    const s = this.state();
    change(s);
    this.save(s);
  }

  private async owner() {
    if (!this.ownerPub) this.ownerPub = await readOwnerPublic(this.d.paths);
    if (!this.ownerPub) throw new Error("no owner account yet");
    return this.ownerPub;
  }

  async screen(claimed = true): Promise<Screen> {
    return screenFor(this.state(), { claimed, done: isSetupDone(this.d.paths) });
  }

  // ------------------------------------------------------------ the connect job

  /** For tests: wait until the current job ends. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /** Called on every setup page load: starts or resumes the connect step (all parts are idempotent). */
  resumeIfInterrupted(): void {
    if (this.running || isSetupDone(this.d.paths)) return;
    const s = this.state();
    if (s.camera && s.cameraConfirmed && (!s.job || s.job.status === "running")) this.startConnect();
  }

  private startConnect(): void {
    if (this.running) return;
    const setJob = (j: Partial<JobState>) => this.update((s) => {
      s.job = { ...(s.job ?? { kind: "connect", status: "running", step: 0, total: CONNECT_TOTAL, text: "", startedAt: new Date().toISOString() }), ...j };
    });
    setJob({ kind: "connect", status: "running", step: 0, total: CONNECT_TOTAL, text: "Preparing your box", reason: undefined, error: undefined, startedAt: new Date().toISOString() });
    this.running = this.connect((step, text) => setJob({ step, text }))
      .then(() => setJob({ status: "done", step: CONNECT_TOTAL, text: "Sealing started" }))
      .catch((e: unknown) => setJob({ status: "failed", reason: e instanceof StopError ? e.reason : "error", error: safeError(e) }))
      .finally(() => {
        this.running = undefined;
      });
  }

  private async connect(progress: (step: number, text: string) => void): Promise<void> {
    const p = this.d.paths;
    const s0 = this.state();
    if (!s0.camera) throw new Error("no camera yet");
    const label = s0.camera.label;

    // 1. Keys and account, made silently. Both steps keep what exists.
    progress(1, "Preparing your box");
    const owner = await ensureOwnerAccount(p);
    const { key } = ensureDeviceKey(p, label);
    this.ownerPub = { cosmos: owner.cosmos, evm: owner.evm, registry: owner.registry };

    // 2. Network fees: the pilot sends them (default), or the owner does (Self-managed).
    progress(2, "Getting the network fees");
    const poll = this.d.pollMs ?? 10_000;
    const deadline = Date.now() + (this.d.fundsTimeoutMs ?? 20 * 60_000);
    const deviceId = deviceIdOf(label);
    let lastAsk = 0;
    while ((await this.d.chain.balanceUqor(owner.cosmos)) < MIN_SETUP_UQOR) {
      const s = this.state();
      if ((s.plan ?? "sponsored") === "sponsored") {
        if (!s.sponsor || SPONSOR_STOP.includes(s.sponsor.status)) {
          const a = await enrollDevice(this.d.sponsor(), { registry: owner.registry, deviceId, owner: owner.evm, key });
          this.update((n) => (n.sponsor = { status: a.status, at: new Date().toISOString() }));
          if (SPONSOR_STOP.includes(a.status)) throw new StopError("sponsor_stop", SPONSOR_TEXT[a.status]);
        } else if (Date.now() - lastAsk > 3 * poll) {
          lastAsk = Date.now();
          try {
            const a = await this.d.sponsor().status(deviceId, owner.evm);
            if (a.status !== "unknown") this.update((n) => (n.sponsor = { status: a.status, at: new Date().toISOString() }));
            if (SPONSOR_STOP.includes(a.status)) throw new StopError("sponsor_stop", SPONSOR_TEXT[a.status]);
          } catch (e) {
            if (e instanceof StopError) throw e;
            // The sponsor did not answer. The balance check goes on.
          }
        }
      }
      if (Date.now() > deadline) throw new StopError("no_funds", "The network fees did not arrive in time.");
      await sleep(poll);
    }

    // 3. Registration on the test network, then the files that start recording.
    const r = await registerOnChain(p, label, this.d.chain, (n, _t, text) => progress(2 + n, text));
    const s = this.state();
    finishSetup(p, {
      device: label, deviceId: r.deviceId, owner: owner.evm, qor1: owner.cosmos, registry: owner.registry, plan: s.plan ?? "sponsored",
      keyFingerprint: keyFingerprint(key.keyHash), registeredTx: r.txHash ?? readAccountInfo(p)?.registeredTx, setupAt: new Date().toISOString(),
    });
  }

  // ------------------------------------------------------------ POST handlers

  async post(path: string, form: Record<string, string>): Promise<PostResult> {
    const screen = await this.screen();
    const action = form.action ?? "";
    if (path === "/setup/camera" && screen === "camera") return this.postCamera(form);
    if (path === "/setup/connect" && screen === "connect") {
      const s = this.state();
      if (this.running || s.job?.status !== "failed") return { redirect: "/setup" };
      if (action === "self") this.update((n) => (n.plan = "self"));
      if (action === "camera") {
        // Back to the camera form (wrong camera, or it went offline). Keys and account stay.
        this.update((n) => {
          n.cameraConfirmed = false;
          delete n.job;
        });
        return { redirect: "/setup" };
      }
      this.startConnect();
      return { redirect: "/setup" };
    }
    return { redirect: "/setup" };
  }

  private async postCamera(form: Record<string, string>): Promise<PostResult> {
    const csrf = form._csrf ?? "";
    const action = form.action ?? "test";
    const s = this.state();
    if (action === "confirm" && s.camera) {
      this.update((n) => (n.cameraConfirmed = true));
      this.startConnect();
      return { redirect: "/setup" };
    }
    if (action === "retry") {
      this.lastSnapshot = undefined;
      return { html: this.renderCameraForm(csrf, undefined, { host: s.camera?.host ?? "", user: s.camera?.user ?? "" }) };
    }

    let url: string;
    let cam: NonNullable<WizardState["camera"]>;
    if (action === "standard") {
      const saved = readEnvFile(this.d.paths.cameraEnv).QW_STREAM_URL;
      const parsed = saved ? parseStreamUrl(saved) : undefined;
      if (!s.camera || !parsed) return { html: this.renderCameraForm(csrf) };
      cam = { ...s.camera, path: "stream2" };
      url = tapoUrl({ host: parsed.host, user: parsed.user, password: parsed.password, path: "stream2", port: parsed.port });
    } else {
      const values = { host: (form.host ?? "").trim(), user: form.user ?? "" };
      const fail = (msg: string) => ({ html: this.renderCameraForm(csrf, msg, values) });
      if (form.consent !== "yes") return fail("Tick the box: my camera films my own property.");
      const problem = cameraHostProblem(values.host) ?? cameraAccountProblem(values.user, form.password ?? "");
      if (problem) return fail(problem);
      const label = readAccountInfo(this.d.paths)?.device ?? s.camera?.label ?? DEFAULT_LABEL;
      url = tapoUrl({ host: values.host, user: values.user, password: form.password ?? "", path: "stream1" });
      cam = { label, host: values.host, user: values.user, path: "stream1", retentionDays: 14, testedAt: "" };
      // Advanced: pay the fees yourself.
      this.update((n) => (n.plan = form.selfManaged === "yes" ? "self" : "sponsored"));
    }

    const result = await this.d.snapshot(url);
    if (!result.ok) return { html: this.renderCameraForm(csrf, result.message, { host: cam.host, user: cam.user }, result.detail) };
    cam.testedAt = new Date().toISOString();
    cam.retentionDays = proposeRetentionDays(this.d.diskFree?.(), cam.path);
    saveCamera(this.d.paths, { label: cam.label, streamUrl: url, retentionDays: cam.retentionDays });
    this.update((n) => {
      n.camera = cam;
      n.cameraConfirmed = false;
    });
    this.lastSnapshot = result.jpeg;
    return { html: this.renderPicture(csrf) };
  }

  // ------------------------------------------------------------ pages

  async render(screen: Screen, csrf: string, base = ""): Promise<string> {
    if (screen === "camera") {
      const s = this.state();
      return s.camera && this.lastSnapshot ? this.renderPicture(csrf) : this.renderCameraForm(csrf, undefined, { host: s.camera?.host ?? "", user: s.camera?.user ?? "" });
    }
    if (screen === "connect") return this.renderConnect(csrf);
    if (screen === "done") return renderDone(base);
    return "";
  }

  /** Seconds until the page reloads itself (the connect step runs). */
  refreshFor(screen: Screen): number | undefined {
    return screen === "connect" && this.state().job?.status !== "failed" ? 5 : undefined;
  }

  private renderCameraForm(csrf: string, error?: string, v: { host: string; user: string } = { host: "", user: "" }, detail?: string): string {
    const plan = this.state().plan;
    return `<div class="card">${eyebrow(1, "Camera")}
<h1>Connect your camera</h1>
<div class="note"><strong>In the Tapo app:</strong> tap the camera, then the gear, then <em>Advanced Settings</em> &gt; <em>Camera Account</em>. Make a user name and a password of 6 to 32 letters and digits. The camera address (IP) is under <em>Device Info</em>.</div>
${error ? `<div class="error" role="alert">${esc(error)}</div>` : ""}${detail ? `<details><summary>Technical details</summary><pre>${esc(detail)}</pre></details>` : ""}
<form method="post" action="/setup/camera">${hidden("_csrf", csrf)}${hidden("action", "test")}
<label for="host">Camera address</label><input id="host" name="host" type="text" inputmode="decimal" autocomplete="off" placeholder="192.168.1.20" value="${esc(v.host)}">
<label for="user">Camera account name</label><input id="user" name="user" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" value="${esc(v.user)}">
<label for="password">Camera account password</label><input id="password" name="password" type="password" autocomplete="off">
<label class="check"><input type="checkbox" name="consent" value="yes"> <span>My camera films my own property.</span></label>
<p class="hint">Tapo Care, the microSD card and a recorder such as this box: only two of the three work at a time. If all three are on, turn one off.</p>
<button>Test camera</button><div class="hint">The test takes up to 15 seconds.</div>
<details><summary>Advanced</summary><label class="check"><input type="checkbox" name="selfManaged" value="yes"${plan === "self" ? " checked" : ""}> <span>Use my own wallet (Self-managed). You pay the network fees with your own test tokens.</span></label></details>
</form></div>`;
  }

  private renderPicture(csrf: string): string {
    const form = (action: string, label: string, cls = "") => `<form method="post" action="/setup/camera">${hidden("_csrf", csrf)}${hidden("action", action)}<button${cls ? ` class="${cls}"` : ""}>${label}</button></form>`;
    const img = this.lastSnapshot ? `<img class="snap" alt="Picture from your camera" src="data:image/jpeg;base64,${this.lastSnapshot.toString("base64")}">` : "";
    const std = this.state().camera?.path === "stream1";
    return `<div class="card">${eyebrow(1, "Camera")}
<h1>Is this your camera?</h1>${img}
<div class="row">${form("confirm", "Yes, this is my camera")}${form("retry", "Try again", "secondary")}</div>
${std ? `<details><summary>Why standard quality?</summary><p>Standard quality uses less disk space and Wi-Fi. Use it when the box has a small disk or the camera is far from the router.</p>${form("standard", "Use standard quality", "secondary")}</details>` : ""}</div>`;
  }

  private async renderConnect(csrf: string): Promise<string> {
    const s = this.state();
    const job = s.job;
    const self = s.plan === "self";
    const btn = (action: string, label: string, cls = "") => `<form method="post" action="/setup/connect">${hidden("_csrf", csrf)}${hidden("action", action)}<button${cls ? ` class="${cls}"` : ""}>${label}</button></form>`;
    if (job?.status === "failed") {
      const msg = job.reason === "sponsor_stop" ? job.error ?? SPONSOR_TEXT.unknown
        : job.reason === "no_funds" ? (self ? "No test tokens arrived yet. Add them, then try again." : "The network fees did not arrive yet. Try again in a few minutes.")
        : "Something went wrong while connecting to the test network. Nothing is lost. Try again.";
      return `<div class="card">${eyebrow(2, "Connect")}
<h1>The connection stopped</h1><div class="error" role="alert">${esc(msg)}</div>
<div class="row">${btn("retry", "Try again")}${job.reason === "sponsor_stop" && !self ? btn("self", "Use my own wallet", "secondary") : ""}${btn("camera", "Check the camera again", "secondary")}</div>
${job.reason === "error" ? `<details><summary>Technical details</summary><pre>${esc(job.error ?? "")}</pre></details>` : ""}</div>`;
    }
    const step = Math.max(job?.step ?? 0, 1);
    const total = job?.total ?? CONNECT_TOTAL;
    let waitSelf = "";
    if (self && step === 2 && existsSync(this.d.paths.accountEnv)) {
      const owner = await this.owner().catch(() => undefined);
      if (owner) {
        waitSelf = `<div class="note"><strong>Self-managed:</strong> add at least 2 test QOR to your account. Claim them at the <a href="${FAUCET}" target="_blank" rel="noreferrer">QoreChain dashboard</a> (Faucet). This page goes on by itself when they arrive.
<p class="mono" id="addr" style="margin:8px 0 0">${esc(owner.cosmos)}</p><button type="button" class="secondary" data-copy="addr">Copy address</button></div>`;
      }
    }
    return `<div class="card">${eyebrow(2, "Connect")}
<h1>Connecting your camera</h1>
<p>${esc(job?.text ?? "Preparing your box")}</p>
<progress value="${esc(step)}" max="${esc(total)}" aria-label="Progress"></progress>
<p class="muted">This takes 2 to 5 minutes. You can close this page. The box goes on.</p>${waitSelf}</div>`;
  }

  /** Last test picture, for tests. */
  get snapshotBytes(): number {
    return this.lastSnapshot?.length ?? 0;
  }
}

export function renderDone(dashboardUrl: string): string {
  return `<div class="card"><div class="eyebrow">Done</div>
<h1>Sealing started</h1>
<p>Your box records your camera and seals the video every 10 minutes. The first seal comes in about 10 to 15 minutes.</p>
<p>Your dashboard is here. Bookmark it now, or add it to your home screen:</p>
<p style="font-size:24px;font-weight:600;margin:4px 0 12px" class="mono">${esc(dashboardUrl || "/")}</p>
<a class="btn" href="/">Open my dashboard</a>
<p style="margin-top:16px">To prove a video later: open the dashboard and press <strong>Download</strong> next to the time you need.</p>
<p class="muted">Your box keeps its keys in the qorewitness folder. Back up that folder once.</p></div>`;
}

// ---------------------------------------------------------------- claim (pairing and password)

export function renderClaimCode(error?: string, locked = false): string {
  return `<div class="card"><div class="eyebrow">Welcome</div>
<h1>Set up your QoreWitness box</h1>
<p>Type the 6-digit pairing code that the installer showed.</p>
${error ? `<div class="error" role="alert">${esc(error)}</div>` : ""}
${locked ? "" : `<form method="post" action="/setup/pair"><label for="code">Pairing code</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7">
<button>Continue</button></form>`}</div>`;
}

const showToggle = (id: string) => `<label class="check" style="margin-top:8px"><input type="checkbox" data-show="${id}"> <span>Show password</span></label>`;

export function renderClaimPassword(csrf: string, error?: string): string {
  return `<div class="card"><div class="eyebrow">Welcome</div>
<h1>Choose a password for this box</h1>
<p>You need it to open your dashboard later.</p>
${error ? `<div class="error" role="alert">${esc(error)}</div>` : ""}
<form method="post" action="/setup/password">${hidden("_csrf", csrf)}
<label for="pw">Password (10 characters or more)</label><input id="pw" name="password" type="password" autocomplete="new-password">
${showToggle("pw")}<button>Save password</button></form></div>`;
}

export function renderLogin(error?: string): string {
  return `<div class="card"><h1>Open your dashboard</h1>
${error ? `<div class="error" role="alert">${esc(error)}</div>` : ""}
<form method="post" action="/login"><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password">
${showToggle("pw")}<button>Open</button></form>
<details><summary>Forgot the password?</summary><p>Run the install command again and add <span class="mono">--new-password</span>. It shows a new pairing code. Your camera and video stay as they are.</p></details></div>`;
}
