/**
 * Browser setup for one camera. Kept short on purpose (keep it simple):
 *   claim     pairing code or link, then a dashboard password   (rendered here, checked in server.ts)
 *   camera    camera address, camera account name and password, one tick. "Is this your camera?" with a picture
 *   connect   one progress bar that starts by itself: keys and account (silent), network fees, registration
 *   done      "Sealing started", the dashboard address, one backup line
 *
 * "Free beta: we cover the network fees" (the fee sponsor) is the default and needs no code. "Use my own
 * wallet" (Self-managed) sits under "Advanced" on the camera screen, and is offered
 * when the free beta is full.
 *
 * screenFor() is a pure state machine. Wizard keeps the state in
 * /data/ui/setup-state.json (mode 600, no passwords) and runs the connect step as a
 * job in this process, so a closed browser or a restart resumes it. Chain, sponsor
 * and camera access go through injected dependencies.
 */
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { deviceIdOf } from "../core/message.js";
import { safeError } from "../core/redact.js";
import {
  FAUCET, MIN_SETUP_UQOR, REGISTER_STEPS, ensureDeviceKey, ensureOwnerAccount, finishSetup, isSetupDone, keyFingerprint,
  readAccountInfo, readEnvFile, readOwnerPublic, registerOnChain, saveCamera, writeSecretFile, type ChainOps, type Paths, type Plan,
} from "../setup/steps.js";
import { brandStreamUrl, parseStreamUrl, proposeRetentionDays, type SnapshotResult, type StreamPath } from "./camera.js";
import { CAMERA_BRANDS, brandById, type BrandId } from "./cameras.js";
import { cameraLabel, type FoundCamera } from "./discover.js";
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
  /** Why it stopped: the beta sponsor said no, no fees arrived, or another error. */
  reason?: "sponsor_stop" | "no_funds" | "error";
  error?: string;
  startedAt: string;
}

export interface WizardState {
  v: 2;
  camera?: {
    label: string; host: string; user: string; retentionDays: number; testedAt: string;
    brand?: BrandId; quality?: "main" | "sub";
    path?: StreamPath; // before 0.6.1: Tapo only
  };
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
  /** "Find my camera": search the home network. Missing: no search (tests). The server passes discoverCameras. */
  discover?: (hints: (string | undefined)[]) => Promise<FoundCamera[]>;
}

/** Address hints for the home /24: QW_LAN_CIDR, the address from install.sh, the address the browser used. */
export const lanHints = (base: string) => [process.env.QW_LAN_CIDR, process.env.QW_UI_PUBLIC_URL, base];

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
  private scan?: { at: number; found: FoundCamera[]; running?: Promise<void> };
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
    setJob({ kind: "connect", status: "running", step: 0, total: CONNECT_TOTAL, text: "Preparing QoreWitness", reason: undefined, error: undefined, startedAt: new Date().toISOString() });
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
    progress(1, "Preparing QoreWitness");
    const owner = await ensureOwnerAccount(p);
    const { key } = ensureDeviceKey(p, label);
    this.ownerPub = { cosmos: owner.cosmos, evm: owner.evm, registry: owner.registry };

    // 2. Network fees: the free beta sends them (default), or the owner does (Self-managed).
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
      return { html: await this.renderCameraForm(csrf, undefined, this.formValues(s)) };
    }
    if (action === "rescan") {
      this.scan = undefined;
      return { html: await this.renderCameraForm(csrf, undefined, this.formValues(s), undefined, form._base ?? "") };
    }

    let url: string;
    let cam: NonNullable<WizardState["camera"]>;
    if (action === "standard") {
      const saved = readEnvFile(this.d.paths.cameraEnv).QW_STREAM_URL;
      const parsed = saved ? parseStreamUrl(saved) : undefined;
      const brand = brandById(s.camera?.brand ?? (s.camera?.path ? "tapo" : undefined));
      if (!s.camera || !parsed || brand.fullLink || !brand.subPath) return { html: await this.renderCameraForm(csrf, undefined, this.formValues(s)) };
      cam = { ...s.camera, brand: brand.id, quality: "sub" };
      url = brandStreamUrl(brand, { host: parsed.host, user: parsed.user, password: parsed.password, quality: "sub" });
    } else {
      const host = ((form.host ?? "").trim() || (form.found ?? "")).trim();
      const values: CameraFormValues = { host, user: form.user ?? "", brand: form.brand ?? "", link: form.link ?? "" };
      const fail = async (msg: string) => ({ html: await this.renderCameraForm(csrf, msg, values) });
      if (!CAMERA_BRANDS.some((b) => b.id === values.brand)) return fail("Pick the brand of your camera. Not in the list? Pick Other camera.");
      if (form.consent !== "yes") return fail("Tick the box: my camera films my own property.");
      const brand = brandById(values.brand);
      try {
        url = brandStreamUrl(brand, { host, user: values.user, password: form.password ?? "", link: values.link, quality: "main" });
      } catch (e) {
        return fail(e instanceof Error ? e.message : "Check the camera details.");
      }
      const label = readAccountInfo(this.d.paths)?.device ?? s.camera?.label ?? DEFAULT_LABEL;
      const shownHost = brand.fullLink ? (parseStreamUrl(url)?.host ?? "") : host;
      cam = { label, host: shownHost, user: values.user, brand: brand.id, quality: "main", retentionDays: 14, testedAt: "" };
      // Advanced: pay the fees yourself.
      this.update((n) => (n.plan = form.selfManaged === "yes" ? "self" : "sponsored"));
    }

    const result = await this.d.snapshot(url);
    if (!result.ok) {
      // Brand hints only for that brand (for example the Tapo recording rule).
      const hint = result.kind === "no_video" || result.kind === "busy" ? brandById(cam.brand).notes[0] : undefined;
      const msg = cam.brand === "tapo" && hint ? `${result.message} ${hint}` : result.message;
      return { html: await this.renderCameraForm(csrf, msg, { host: cam.host, user: cam.user, brand: cam.brand ?? "", link: "" }, result.detail) };
    }
    cam.testedAt = new Date().toISOString();
    // Without an injected value, ask the disk that holds /data (the server passes none).
    cam.retentionDays = proposeRetentionDays(this.d.diskFree ? this.d.diskFree() : freeBytes(this.d.paths.data), cam.quality === "sub" ? "stream2" : "stream1");
    saveCamera(this.d.paths, { label: cam.label, streamUrl: url, retentionDays: cam.retentionDays });
    this.update((n) => {
      n.camera = cam;
      n.cameraConfirmed = false;
    });
    this.lastSnapshot = result.jpeg;
    return { html: this.renderPicture(csrf) };
  }

  private formValues(s: WizardState): CameraFormValues {
    return { host: s.camera?.host ?? "", user: s.camera?.user ?? "", brand: s.camera?.brand ?? (s.camera?.path ? "tapo" : ""), link: "" };
  }

  /** Runs "Find my camera" once (cached for 2 minutes). At most about 5 seconds. */
  private async findCameras(base: string): Promise<FoundCamera[] | undefined> {
    if (!this.d.discover) return undefined;
    if (this.scan && !this.scan.running && Date.now() - this.scan.at < 120_000) return this.scan.found;
    if (!this.scan?.running) {
      const scan: { at: number; found: FoundCamera[]; running?: Promise<void> } = { at: Date.now(), found: [] };
      scan.running = this.d.discover(lanHints(base))
        .then((f) => {
          scan.found = f;
        })
        .catch(() => {
          scan.found = [];
        })
        .finally(() => {
          scan.at = Date.now();
          scan.running = undefined;
        });
      this.scan = scan;
    }
    await this.scan.running;
    return this.scan.found;
  }

  // ------------------------------------------------------------ pages

  async render(screen: Screen, csrf: string, base = ""): Promise<string> {
    if (screen === "camera") {
      const s = this.state();
      return s.camera && this.lastSnapshot ? this.renderPicture(csrf) : this.renderCameraForm(csrf, undefined, this.formValues(s), undefined, base);
    }
    if (screen === "connect") return this.renderConnect(csrf);
    if (screen === "done") return renderDone(base, process.env.QW_UI_PUBLIC_URL);
    return "";
  }

  /** Seconds until the page reloads itself (the connect step runs). */
  refreshFor(screen: Screen): number | undefined {
    return screen === "connect" && this.state().job?.status !== "failed" ? 5 : undefined;
  }

  private async renderCameraForm(csrf: string, error?: string, v: CameraFormValues = { host: "", user: "", brand: "", link: "" }, detail?: string, base?: string): Promise<string> {
    const plan = this.state().plan;
    // "Find my camera" runs when the screen opens (base is set on a page load, not after a failed test).
    const found = base !== undefined ? await this.findCameras(base) : this.scan?.found;
    const pick = v.host || found?.[0]?.ip || "";
    const brand = v.brand || found?.find((f) => f.ip === pick)?.brand || "";
    const list = found === undefined ? ""
      : found.length
        ? `<fieldset style="border:0;padding:0;margin:0"><legend style="font-weight:500;margin:14px 0 4px">Cameras on your network</legend>${found.map((f) =>
            `<label class="check" style="margin:6px 0"><input type="radio" name="found" value="${esc(f.ip)}"${f.brand ? ` data-brand="${esc(f.brand)}"` : ""}${f.ip === pick ? " checked" : ""}> <span>${esc(cameraLabel(f))}</span></label>`).join("")}</fieldset>`
        : `<p class="note">No camera answered on your network. Type its address below. Your router's app lists the devices on your network.</p>`;
    const brands = CAMERA_BRANDS.map((b) => `<option value="${b.id}"${b.id === brand ? " selected" : ""}${b.fullLink ? ' data-full="1"' : ""}>${esc(b.name)}</option>`).join("");
    const howTo = CAMERA_BRANDS.map((b) => `<p data-hint="${b.id}"><strong>${esc(b.name)}:</strong> ${esc(b.enableRtsp)}${b.notes.map((n) => ` ${esc(n)}`).join("")}${b.pathStatus === "check-manual" ? "" : ""}</p>`).join("");
    return `<div class="card">${eyebrow(1, "Camera")}
<h1>Connect your camera</h1>
<p>QoreWitness works with cameras that send a video stream (RTSP or ONVIF). Pick your camera, choose its brand and type the camera account.</p>
${error ? `<div class="error" role="alert">${esc(error)}</div>` : ""}${detail ? `<details><summary>Technical details</summary><pre>${esc(detail)}</pre></details>` : ""}
<form method="post" action="/setup/camera">${hidden("_csrf", csrf)}${hidden("action", "test")}
${list}
<label for="host">${found?.length ? "Or type the camera address" : "Camera address"}</label><input id="host" name="host" type="text" inputmode="decimal" autocomplete="off" placeholder="192.168.1.20" value="${esc(found?.some((f) => f.ip === v.host) ? "" : v.host)}">
<label for="brand">Brand</label><select id="brand" name="brand" data-brand><option value="">Choose the brand</option>${brands}</select>
<label for="user">Camera account name</label><input id="user" name="user" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" value="${esc(v.user)}">
<label for="password">Camera account password</label><input id="password" name="password" type="password" autocomplete="off">
<div data-linkfield><label for="link">Camera link (only for Other camera and UniFi Protect)</label><input id="link" name="link" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="rtsp://..." value="${esc(v.link)}"></div>
<label class="check"><input type="checkbox" name="consent" value="yes"> <span>My camera films my own property.</span></label>
<p class="hint">Clips keep sound when your camera's microphone is on. You can switch it off in your camera's app at any time.</p>
<button>Test camera</button><div class="hint">The test takes up to 15 seconds.</div>
<details><summary>Where do I find the camera account?</summary>${howTo}</details>
<details><summary>Advanced</summary><label class="check"><input type="checkbox" name="selfManaged" value="yes"${plan === "self" ? " checked" : ""}> <span>Use my own wallet (Self-managed). You pay the network fees with your own test tokens.</span></label></details>
</form>
${this.d.discover ? `<form method="post" action="/setup/camera">${hidden("_csrf", csrf)}${hidden("action", "rescan")}<button class="secondary">Search my network again</button></form>` : ""}</div>`;
  }

  private renderPicture(csrf: string): string {
    const form = (action: string, label: string, cls = "") => `<form method="post" action="/setup/camera">${hidden("_csrf", csrf)}${hidden("action", action)}<button${cls ? ` class="${cls}"` : ""}>${label}</button></form>`;
    const img = this.lastSnapshot ? `<img class="snap" alt="Picture from your camera" src="data:image/jpeg;base64,${this.lastSnapshot.toString("base64")}">` : "";
    const cam = this.state().camera;
    const b = brandById(cam?.brand ?? (cam?.path ? "tapo" : undefined));
    const std = !!cam && cam.quality !== "sub" && cam.path !== "stream2" && !b.fullLink && !!b.subPath;
    return `<div class="card">${eyebrow(1, "Camera")}
<h1>Is this your camera?</h1>${img}
<div class="row">${form("confirm", "Yes, this is my camera")}${form("retry", "Try again", "secondary")}</div>
${std ? `<details><summary>Why standard quality?</summary><p>Standard quality uses less disk space and Wi-Fi. Use it when the computer has a small disk or the camera is far from the router.</p>${form("standard", "Use standard quality", "secondary")}</details>` : ""}</div>`;
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
<h1>Connecting your camera…</h1>
<progress value="${esc(step)}" max="${esc(total)}" aria-label="Progress"></progress>
<p class="muted">This takes a few minutes. You can close this page. QoreWitness goes on.</p>${waitSelf}</div>`;
  }

  /** Last test picture, for tests. */
  get snapshotBytes(): number {
    return this.lastSnapshot?.length ?? 0;
  }
}

/** Free bytes on the disk that holds `path`, or undefined when statfs is missing. */
export function freeBytes(path: string): number | undefined {
  try {
    const st = statfsSync(path);
    return st.bavail * st.bsize;
  } catch {
    return undefined;
  }
}

/** The done page shows the address the browser used and, when it differs, the address that the installer printed. */
export function renderDone(dashboardUrl: string, installerUrl?: string): string {
  const big = (u: string) => `<p style="font-size:clamp(15px,4.6vw,24px);font-weight:600;margin:4px 0 12px;word-break:normal;overflow-wrap:anywhere" class="mono">${esc(u)}</p>`;
  const other = installerUrl && /^https?:\/\/[^\s"<>]+$/.test(installerUrl) && installerUrl.replace(/\/+$/, "") !== dashboardUrl.replace(/\/+$/, "") ? installerUrl.replace(/\/+$/, "") : undefined;
  return `<div class="card"><div class="eyebrow">Done</div>
<h1>Sealing started</h1>
<p>QoreWitness records your camera and seals the video every 10 minutes. The first seal comes in about 10 to 15 minutes.</p>
<p>Your dashboard is here. Bookmark it now, or add it to your home screen:</p>
${big(dashboardUrl || "/")}${other ? `<p>From any phone or computer in your home, this address also works:</p>${big(other)}` : ""}
<a class="btn" href="/">Open my dashboard</a>
<p style="margin-top:16px">To prove a video later: open the dashboard and press <strong>Download</strong> next to the time you need.</p>
<p class="muted">QoreWitness keeps its keys in the qorewitness folder on this computer. Back up that folder once.</p></div>`;
}

// ---------------------------------------------------------------- claim (pairing and password)

export function renderClaimCode(error?: string, locked = false): string {
  return `<div class="card"><div class="eyebrow">Welcome</div>
<h1>Set up QoreWitness</h1>
<p>Type the 6-digit pairing code that the installer showed.</p>
${error ? `<div class="error" role="alert">${esc(error)}</div>` : ""}
${locked ? "" : `<form method="post" action="/setup/pair"><label for="code">Pairing code</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7">
<button>Continue</button></form>`}</div>`;
}

const showToggle = (id: string) => `<label class="check" style="margin-top:8px"><input type="checkbox" data-show="${id}"> <span>Show password</span></label>`;

export function renderClaimPassword(csrf: string, error?: string): string {
  return `<div class="card"><div class="eyebrow">Welcome</div>
<h1>Choose a password for QoreWitness</h1>
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

interface CameraFormValues {
  host: string;
  user: string;
  brand: string;
  link: string;
}
