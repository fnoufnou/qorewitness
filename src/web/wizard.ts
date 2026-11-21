/**
 * Browser setup for one camera (T25 phase 2). Screens:
 *   claim     pairing code or link, then a dashboard password   (rendered here, checked in server.ts)
 *   camera    Tapo C210 camera account, "Test camera" picture
 *   plan      Fees included (pilot code) or Self-managed
 *   account   create the keys of the box, backup note
 *   funding   wait for test QOR (pilot sponsor or the owner)
 *   register  registration on QoreChain with a plain progress bar
 *   done      sealing starts, link to the dashboard
 *
 * screenFor() is a pure state machine. Wizard keeps the state in
 * /data/ui/setup-state.json (mode 600, no passwords) and runs the long steps as
 * jobs in this process, so a closed browser or a restart resumes at the right
 * screen. All chain and sponsor access goes through injected dependencies.
 */
import { readFileSync, statfsSync } from "node:fs";
import { loadDeviceKey } from "../agent/device-key.js";
import { deviceIdOf } from "../core/message.js";
import { safeError } from "../core/redact.js";
import {
  FAUCET, LABEL_RE, MIN_SETUP_UQOR, REGISTER_STEPS, ensureDeviceKey, ensureOwnerAccount, finishSetup, isSetupDone, readOwnerPublic,
  keyFingerprint, readAccountInfo, readEnvFile, registerOnChain, saveCamera, writeSecretFile, type ChainOps, type Paths, type Plan,
} from "../setup/steps.js";
import { existsSync } from "node:fs";
import {
  cameraAccountProblem, cameraHostProblem, parseStreamUrl, proposeRetentionDays, tapoUrl,
  type SnapshotResult, type StreamInfo, type StreamPath,
} from "./camera.js";
import { esc, hidden } from "./html.js";
import { PILOT_CODE_RE, SPONSOR_TEXT, enrollDevice, type SponsorClient, type SponsorStatus } from "./sponsor.js";

export type Screen = "claim" | "camera" | "plan" | "account" | "funding" | "register" | "done";
export const SCREENS: Screen[] = ["camera", "plan", "account", "funding", "register", "done"];

export interface JobState {
  kind: "register" | "enroll";
  status: "running" | "failed" | "done";
  step: number;
  total: number;
  text: string;
  error?: string;
  startedAt: string;
}

export interface WizardState {
  v: 1;
  camera?: { label: string; host: string; user: string; path: StreamPath; custom?: boolean; retentionDays: number; info?: StreamInfo; testedAt: string };
  cameraConfirmed?: boolean;
  plan?: Plan;
  pilotCode?: string;
  backupAck?: boolean;
  sponsor?: { status: SponsorStatus; at: string; capPerDayUqor?: string };
  job?: JobState;
}

export interface Facts {
  claimed: boolean; // a dashboard password exists
  done: boolean; // setup.done exists
  ownerExists: boolean;
  keyExists: boolean;
  balanceOk?: boolean; // only asked once the earlier screens are complete
}

const SPONSOR_STOP: SponsorStatus[] = ["full", "invalid_code", "used_code", "paused", "rejected"];

/** Which screen to show. Pure: the same state and facts give the same screen. */
export function screenFor(s: WizardState, f: Facts): Screen {
  if (!f.claimed) return "claim";
  if (f.done) return "done";
  if (!s.camera || !s.cameraConfirmed) return "camera";
  if (!s.plan) return "plan";
  if (!f.ownerExists || !f.keyExists || !s.backupAck) return "account";
  if (s.job?.kind === "register") return "register";
  if (!f.balanceOk) return "funding";
  return "register";
}

export interface WizardDeps {
  paths: Paths;
  chain: ChainOps;
  sponsor: () => SponsorClient;
  snapshot: (url: string) => Promise<SnapshotResult>;
  diskFree?: () => number | undefined;
}

export interface PostResult {
  redirect?: string;
  html?: string; // body of a page to show directly (camera test result)
}

const statePath = (p: Paths) => `${p.uiDir}/setup-state.json`;

export function readState(p: Paths): WizardState {
  try {
    const s = JSON.parse(readFileSync(statePath(p), "utf8")) as WizardState;
    return s.v === 1 ? s : { v: 1 };
  } catch {
    return { v: 1 };
  }
}

export function writeState(p: Paths, s: WizardState): void {
  writeSecretFile(statePath(p), JSON.stringify(s, null, 2) + "\n");
}

const steps = (screen: Screen) => {
  const i = SCREENS.indexOf(screen);
  return `<div class="steps" aria-hidden="true">${SCREENS.slice(0, -1).map((_, n) => `<span class="${n <= i ? "on" : ""}"></span>`).join("")}</div>`;
};
const eyebrow = (screen: Screen, text: string) =>
  `${steps(screen)}<div class="eyebrow">Step ${Math.min(SCREENS.indexOf(screen) + 1, 5)} of 5 · ${esc(text)}</div>`;
const qor = (uqor: bigint) => (Number(uqor) / 1e6).toLocaleString("en", { maximumFractionDigits: 2 });

export class Wizard {
  private running?: Promise<void>;
  private lastSnapshot?: { jpeg: Buffer; at: number };
  private balance?: { at: number; value: bigint; address: string };
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

  private label(s: WizardState): string {
    return s.camera?.label ?? "camera-1";
  }

  private ownerExists(): boolean {
    return !!readEnvFile(this.d.paths.accountEnv).QORE_MNEMONIC;
  }

  private keyExists(s: WizardState): boolean {
    return !!s.camera && existsSync(`${this.d.paths.keysDir}/${s.camera.label}.key`);
  }

  /** Public addresses of the owner, read once (the account never changes after it exists). */
  private async owner() {
    if (!this.ownerPub) this.ownerPub = await readOwnerPublic(this.d.paths);
    if (!this.ownerPub) throw new Error("no owner account yet");
    return this.ownerPub;
  }

  private async balanceUqor(force = false): Promise<bigint | undefined> {
    if (!this.ownerExists()) return undefined;
    const owner = await this.owner();
    const fresh = this.balance && this.balance.address === owner.cosmos && Date.now() - this.balance.at < 10_000;
    if (fresh && !force) return this.balance!.value;
    try {
      const value = await this.d.chain.balanceUqor(owner.cosmos);
      this.balance = { at: Date.now(), value, address: owner.cosmos };
      return value;
    } catch {
      return this.balance?.value;
    }
  }

  async facts(s: WizardState, claimed: boolean): Promise<Facts> {
    const f: Facts = {
      claimed, done: isSetupDone(this.d.paths), ownerExists: this.ownerExists(), keyExists: this.keyExists(s),
    };
    if (claimed && !f.done && s.camera && s.cameraConfirmed && s.plan && f.ownerExists && f.keyExists && s.backupAck) {
      f.balanceOk = ((await this.balanceUqor()) ?? 0n) >= MIN_SETUP_UQOR;
    }
    return f;
  }

  async screen(claimed = true): Promise<Screen> {
    const s = this.state();
    return screenFor(s, await this.facts(s, claimed));
  }

  // ------------------------------------------------------------ jobs

  private startJob(kind: JobState["kind"], total: number, work: (update: (step: number, text: string) => void) => Promise<void>): void {
    if (this.running) return;
    const s = this.state();
    s.job = { kind, status: "running", step: 0, total, text: "Starting", startedAt: new Date().toISOString() };
    this.save(s);
    const update = (step: number, text: string) => {
      const n = this.state();
      if (n.job) Object.assign(n.job, { step, text });
      this.save(n);
    };
    this.running = work(update)
      .then(() => {
        const n = this.state();
        if (n.job) Object.assign(n.job, { status: "done", step: total });
        this.save(n);
      })
      .catch((e: unknown) => {
        const n = this.state();
        if (n.job) Object.assign(n.job, { status: "failed", error: safeError(e) });
        this.save(n);
      })
      .finally(() => {
        this.running = undefined;
      });
  }

  /** For tests: wait until the current job ends. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /**
   * Called on every page load: a job that was running when the process stopped
   * starts again (all steps are idempotent), and a Fees included box that has
   * not asked the sponsor yet does so now.
   */
  resumeIfInterrupted(): void {
    if (this.running) return;
    const s = this.state();
    if (s.job?.status === "running") {
      if (s.job.kind === "register") this.startRegister();
      else this.startEnroll();
      return;
    }
    const ready = s.plan === "sponsored" && s.pilotCode && s.backupAck && s.camera && this.ownerExists() && this.keyExists(s);
    if (ready && !s.sponsor && s.job?.kind !== "enroll" && s.job?.kind !== "register") this.startEnroll();
  }

  private startEnroll(): void {
    this.startJob("enroll", 2, async (update) => {
      const s = this.state();
      if (!s.camera || !s.pilotCode) throw new Error("no pilot code");
      update(1, "Asking the pilot to cover the network fees");
      const owner = await this.owner();
      const { key } = ensureDeviceKey(this.d.paths, s.camera.label);
      const answer = await enrollDevice(this.d.sponsor(), {
        pilotCode: s.pilotCode, registry: owner.registry, deviceId: deviceIdOf(s.camera.label), owner: owner.evm, key,
      });
      const n = this.state();
      n.sponsor = { status: answer.status, capPerDayUqor: answer.capPerDayUqor, at: new Date().toISOString() };
      this.save(n);
      if (SPONSOR_STOP.includes(answer.status)) throw new Error(SPONSOR_TEXT[answer.status]);
      update(2, "Waiting for the network fees");
    });
  }

  private startRegister(): void {
    this.startJob("register", REGISTER_STEPS.length, async (update) => {
      const s = this.state();
      if (!s.camera || !s.plan) throw new Error("camera or plan missing");
      const label = s.camera.label;
      const r = await registerOnChain(this.d.paths, label, this.d.chain, (n, _t, text) => update(n, text));
      const owner = await this.owner();
      const { key } = ensureDeviceKey(this.d.paths, label);
      finishSetup(this.d.paths, {
        device: label, deviceId: r.deviceId, owner: owner.evm, qor1: owner.cosmos, registry: owner.registry, plan: s.plan,
        keyFingerprint: keyFingerprint(key.keyHash), registeredTx: r.txHash ?? readAccountInfo(this.d.paths)?.registeredTx,
        setupAt: new Date().toISOString(),
      });
    });
  }

  // ------------------------------------------------------------ POST handlers

  async post(path: string, form: Record<string, string>): Promise<PostResult> {
    const screen = await this.screen();
    const s = this.state();
    const action = form.action ?? "";

    const canChangeCamera = ["camera", "plan", "account", "funding"].includes(screen) && s.job?.status !== "running";
    if (path === "/setup/camera" && (screen === "camera" || (action === "change" && canChangeCamera))) return this.postCamera(s, form);

    if (path === "/setup/plan") {
      if (action === "reset") {
        if (s.job?.kind === "register" && s.job.status !== "failed") return { redirect: "/setup" };
        // Back to the plan choice, e.g. when the pilot is full. Keys and account stay.
        delete s.plan;
        delete s.pilotCode;
        delete s.sponsor;
        if (s.job?.kind === "enroll") delete s.job;
        this.save(s);
        return { redirect: "/setup" };
      }
      if (screen !== "plan") return { redirect: "/setup" };
      const plan = form.plan === "sponsored" ? "sponsored" : form.plan === "self" ? "self" : undefined;
      if (!plan) return { html: await this.render("plan", form._csrf ?? "", "Choose one of the two plans.") };
      if (plan === "sponsored") {
        const code = (form.pilotCode ?? "").trim();
        if (!PILOT_CODE_RE.test(code)) return { html: await this.render("plan", form._csrf ?? "", "Type the pilot code from the website (letters, digits and dashes).") };
        s.pilotCode = code;
      } else delete s.pilotCode;
      s.plan = plan;
      this.save(s);
      return { redirect: "/setup" };
    }

    if (path === "/setup/account" && screen === "account") {
      if (action === "create") {
        if (!s.camera) return { redirect: "/setup" };
        await ensureOwnerAccount(this.d.paths);
        ensureDeviceKey(this.d.paths, s.camera.label);
        return { redirect: "/setup" };
      }
      if (action === "ack") {
        if (form.backup !== "yes") return { html: await this.render("account", form._csrf ?? "", "Tick the box to confirm that you know where the backup is.") };
        s.backupAck = true;
        this.save(s);
        if (s.plan === "sponsored" && !s.sponsor) this.startEnroll();
        return { redirect: "/setup" };
      }
    }

    if (path === "/setup/funding" && screen === "funding") {
      if (action === "enroll" && s.plan === "sponsored") this.startEnroll();
      if (action === "check") await this.balanceUqor(true);
      return { redirect: "/setup" };
    }

    if (path === "/setup/register" && screen === "register") {
      if (!this.running && !(s.job?.kind === "register" && s.job.status === "done")) this.startRegister();
      return { redirect: "/setup" };
    }

    return { redirect: "/setup" };
  }

  private async postCamera(s: WizardState, form: Record<string, string>): Promise<PostResult> {
    const csrf = form._csrf ?? "";
    const action = form.action ?? "test";
    if (action === "confirm" && s.camera) {
      s.cameraConfirmed = true;
      this.save(s);
      return { redirect: "/setup" };
    }
    if (action === "change") {
      s.cameraConfirmed = false;
      this.save(s);
      this.lastSnapshot = undefined;
      return { html: await this.render("camera", csrf, undefined, { edit: true }) };
    }

    // Build the stream URL: a new form, or the saved one (retest, standard quality).
    let url: string;
    let cam: NonNullable<WizardState["camera"]>;
    const info = readAccountInfo(this.d.paths);
    if (action === "retest" || action === "standard") {
      const saved = readEnvFile(this.d.paths.cameraEnv).QW_STREAM_URL;
      const parsed = saved ? parseStreamUrl(saved) : undefined;
      if (!s.camera || !saved || !parsed) return { html: await this.render("camera", csrf, undefined, { edit: true }) };
      cam = { ...s.camera };
      if (action === "standard" && !s.camera.custom) {
        cam.path = "stream2";
        url = tapoUrl({ host: parsed.host, user: parsed.user, password: parsed.password, path: "stream2", port: parsed.port });
      } else url = saved;
    } else {
      const label = (form.label ?? "").trim() || "camera-1";
      const values = { host: form.host ?? "", user: form.user ?? "", label, path: (form.path === "stream2" ? "stream2" : "stream1") as StreamPath, url: form.url ?? "" };
      const fail = async (msg: string) => ({ html: await this.render("camera", csrf, msg, { edit: true, values }) });
      if (!LABEL_RE.test(label)) return fail("Use lower-case letters, digits and dashes for the camera name, for example camera-1.");
      if (info && info.device !== label) return fail(`This box is set up for camera "${info.device}". Keep that name.`);
      if (form.consent !== "yes") return fail("Tick the box to confirm that the camera films your own property.");
      const custom = (form.url ?? "").trim();
      if (custom) {
        if (!/^(rtsps?|rtmps?|https?):\/\/\S+$/.test(custom)) return fail("A stream URL starts with rtsp://, rtmp:// or https://.");
        url = custom;
        const p = parseStreamUrl(custom);
        cam = { label, host: p?.host ?? "", user: p?.user ?? "", path: "stream1", custom: true, retentionDays: 14, testedAt: "" };
      } else {
        const problem = cameraHostProblem(values.host) ?? cameraAccountProblem(values.user, form.password ?? "");
        if (problem) return fail(problem);
        url = tapoUrl({ host: values.host, user: values.user, password: form.password ?? "", path: values.path });
        cam = { label, host: values.host.trim(), user: values.user, path: values.path, retentionDays: 14, testedAt: "" };
      }
    }

    const result = await this.d.snapshot(url);
    if (!result.ok) {
      const values = { host: cam.host, user: cam.user, label: cam.label, path: cam.path, url: "" };
      return { html: await this.render("camera", csrf, result.message, { edit: true, values, detail: result.detail }) };
    }
    cam.info = result.info;
    cam.testedAt = new Date().toISOString();
    cam.retentionDays = proposeRetentionDays(this.d.diskFree?.() ?? diskFree(this.d.paths.data), cam.path);
    saveCamera(this.d.paths, { label: cam.label, streamUrl: url, retentionDays: cam.retentionDays });
    s.camera = cam;
    s.cameraConfirmed = false;
    this.save(s);
    this.lastSnapshot = { jpeg: result.jpeg, at: Date.now() };
    return { html: await this.render("camera", csrf) };
  }

  // ------------------------------------------------------------ pages

  async render(screen: Screen, csrf: string, error?: string, opts: CameraRenderOptions = {}): Promise<string> {
    const s = this.state();
    const err = error ? `<div class="error" role="alert">${esc(error)}</div>` : "";
    switch (screen) {
      case "camera":
        return this.renderCamera(s, csrf, err, opts);
      case "plan":
        return this.renderPlan(s, csrf, err);
      case "account":
        return await this.renderAccount(s, csrf, err);
      case "funding":
        return this.renderFunding(s, csrf, err);
      case "register":
        return this.renderRegister(s, csrf, err);
      case "done":
        return renderDone(readAccountInfo(this.d.paths)?.device ?? this.label(s));
      default:
        return "";
    }
  }

  /** Seconds until the page should reload itself (a job is running, or we wait for funds). */
  refreshFor(screen: Screen): number | undefined {
    const s = this.state();
    if (s.job?.status === "running") return 3;
    if (screen === "funding") return 10;
    return undefined;
  }

  private renderCamera(s: WizardState, csrf: string, err: string, o: CameraRenderOptions): string {
    const c = s.camera;
    const form = (inner: string) => `<form method="post" action="/setup/camera">${hidden("_csrf", csrf)}${inner}</form>`;
    if (c && !o.edit) {
      const snap = this.lastSnapshot ? `<img class="snap" alt="Picture from your camera" src="data:image/jpeg;base64,${this.lastSnapshot.jpeg.toString("base64")}">` : "";
      const facts = c.info?.width ? `${c.info.width} x ${c.info.height}${c.info.fps ? `, ${c.info.fps} frames per second` : ""}` : "";
      return `<div class="card">${eyebrow("camera", "Camera")}
<h1>${snap ? "Is this your camera?" : "Camera saved"}</h1>${err}
${snap || `<p>The camera at ${esc(c.host)} is saved. The password is saved and stays on this box.</p>`}
${facts ? `<p class="muted">Picture received. ${esc(facts)}. ${c.path === "stream2" ? "Standard quality." : "High quality."}</p>` : ""}
<p>This box can keep about <strong>${esc(c.retentionDays)} days</strong> of video with the free disk space. Older video is deleted. Export what you need before then.</p>
<div class="row">${form(`${hidden("action", "confirm")}<button>Looks right</button>`)}
${c.path === "stream1" && !c.custom ? form(`${hidden("action", "standard")}<button class="secondary">Use standard quality</button>`) : ""}
${snap ? "" : form(`${hidden("action", "retest")}<button class="secondary">Test camera again</button>`)}
${form(`${hidden("action", "change")}<button class="secondary">Change camera</button>`)}</div>
<details><summary>Why standard quality?</summary><p>Standard quality uses less disk space and Wi-Fi. Use it when the box has a small disk or the camera is far from the router.</p></details></div>`;
    }
    const v = o.values ?? { host: c?.host ?? "", user: c?.user ?? "", label: c?.label ?? "camera-1", path: c?.path ?? "stream1", url: "" };
    const opt = (val: string, text: string) => `<option value="${val}"${v.path === val ? " selected" : ""}>${text}</option>`;
    return `<div class="card">${eyebrow("camera", "Camera")}
<h1>Connect your camera</h1>
<p>QoreWitness reads the video of your Tapo C210 over your home network. It needs the camera account from the Tapo app.</p>
<div class="note"><strong>In the Tapo app:</strong> tap the camera, then the gear, then <em>Advanced Settings</em> &gt; <em>Camera Account</em>. Make a user name and a password of 6 to 32 letters and digits. Use a new password, not the one of your TP-Link account. The IP address is under <em>Device Info</em>.</div>
${err}${o.detail ? `<details><summary>Technical details</summary><pre>${esc(o.detail)}</pre></details>` : ""}
${form(`${hidden("action", "test")}
<label for="host">Camera IP address</label><input id="host" name="host" type="text" inputmode="decimal" autocomplete="off" placeholder="192.168.1.20" value="${esc(v.host)}">
<label for="user">Camera account user name</label><input id="user" name="user" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" value="${esc(v.user)}">
<label for="password">Camera account password</label><input id="password" name="password" type="password" autocomplete="off">
${c ? `<div class="hint">For your safety the saved password is not shown. Type it again.</div>` : ""}
<label for="path">Video quality</label><select id="path" name="path">${opt("stream1", "High quality (stream 1)")}${opt("stream2", "Standard quality (stream 2)")}</select>
<label for="label">Name for this camera</label><input id="label" name="label" type="text" autocomplete="off" autocapitalize="none" value="${esc(v.label)}">
<div class="hint">Lower-case letters, digits and dashes. Do not use your name or address: the name is linked to your account in public.</div>
<label class="check"><input type="checkbox" name="consent" value="yes"> <span>The camera films my own property. I will not film the street or my neighbours without a good reason.</span></label>
<details><summary>Another camera brand</summary><label for="url">Full stream URL (instead of the fields above)</label><input id="url" name="url" type="text" autocomplete="off" placeholder="rtsp://user:password@192.168.1.20:554/stream" value="">
<div class="hint">Camera notes from other users are in docs/CAMERAS.md.</div></details>
<button>Test camera</button><div class="hint">The test takes up to 15 seconds.</div>`)}</div>`;
  }

  private renderPlan(s: WizardState, csrf: string, err: string): string {
    const checked = (p: Plan) => (s.plan === p ? " checked" : "");
    return `<div class="card">${eyebrow("plan", "Plan")}
<h1>Who pays the network fees?</h1>
<p>Every 10 minutes your box puts a seal on the QoreChain test network. Each seal has a small network fee, about 15 test tokens a day per camera. Both plans make the same proof. Both are free in the pilot.</p>${err}
<form method="post" action="/setup/plan">${hidden("_csrf", csrf)}<div class="plans">
<div class="plan"><label style="margin:0;font-weight:400"><input type="radio" name="plan" value="sponsored"${checked("sponsored")}><strong>Fees included (pilot)</strong><br><span class="muted">We pay the network fees for this camera. You need a pilot code from the website.</span></label>
<label for="pilotCode">Pilot code</label><input id="pilotCode" name="pilotCode" type="text" autocomplete="off" autocapitalize="characters" value="${esc(s.pilotCode ?? "")}"></div>
<label class="plan"><input type="radio" name="plan" value="self"${checked("self")}><strong>Self-managed</strong><br><span class="muted">You hold the account and add free test tokens yourself, about once a week.</span></label>
</div><button>Continue</button></form>
<p class="muted" style="margin-top:14px">No payment is collected. We will ask you before any future charge.</p></div>`;
  }

  private async renderAccount(s: WizardState, csrf: string, err: string): Promise<string> {
    const created = this.ownerExists() && this.keyExists(s);
    if (!created) {
      return `<div class="card">${eyebrow("account", "Keys")}
<h1>Create the keys of this box</h1>
<p>The box makes two keys: one for your account and one for the camera. The camera key signs every seal. The keys stay on this box.</p>${err}
<form method="post" action="/setup/account">${hidden("_csrf", csrf)}${hidden("action", "create")}<button>Create keys</button></form></div>`;
    }
    const owner = await this.owner();
    const keyHash = s.camera ? readKeyHash(this.d.paths, s.camera.label) : "";
    return `<div class="card">${eyebrow("account", "Keys")}
<h1>Keys ready</h1>
<p>Camera key: <strong class="mono">${esc(keyHash ? keyFingerprint(keyHash) : "")}</strong></p>
<h2>Keep a backup</h2>
<p>Your keys are files on this box, in the folder <span class="mono">qorewitness/data</span> (the file <span class="mono">qorewitness.env</span> and the folder <span class="mono">keys</span>). If the box breaks, these files are the only way to keep this camera and its history. Copy the folder to a USB stick and keep it in a safe place.</p>
<div class="note">Anyone with these files or with the box can use your test account. QoreWitness never asks for them, by email or on a website.</div>${err}
<form method="post" action="/setup/account">${hidden("_csrf", csrf)}${hidden("action", "ack")}
<label class="check"><input type="checkbox" name="backup" value="yes"> <span>I know where the backup is, and I will copy it to a safe place.</span></label>
<button>Continue</button></form>
<details><summary>Technical details</summary><p class="mono">Account ${esc(owner.cosmos)} (${esc(owner.evm)})<br>Camera key hash ${esc(keyHash)}<br>ML-DSA-87 (FIPS 204), testnet qorechain-diana</p></details></div>`;
  }

  private async renderFunding(s: WizardState, csrf: string, err: string): Promise<string> {
    const owner = await this.owner();
    const bal = await this.balanceUqor();
    const balText = bal === undefined ? "not known yet" : `${qor(bal)} test QOR`;
    if (s.plan === "sponsored") {
      // Ask the sponsor how it goes (at most every 10 s).
      if (s.sponsor && !SPONSOR_STOP.includes(s.sponsor.status) && Date.now() - Date.parse(s.sponsor.at) > 10_000 && s.job?.status !== "running") {
        try {
          const a = await this.d.sponsor().status(deviceIdOf(s.camera!.label));
          if (a.status !== "unknown") {
            s.sponsor = { status: a.status, capPerDayUqor: a.capPerDayUqor ?? s.sponsor.capPerDayUqor, at: new Date().toISOString() };
            this.save(s);
          }
        } catch {
          // Keep the last known answer. The page asks again in 10 s.
        }
      }
      const job = s.job?.kind === "enroll" ? s.job : undefined;
      const stopped = s.sponsor && SPONSOR_STOP.includes(s.sponsor.status);
      const failed = job?.status === "failed" && !stopped;
      const text = stopped ? SPONSOR_TEXT[s.sponsor!.status] : failed ? "The pilot service did not answer. Check the internet connection of the box." : s.sponsor ? SPONSOR_TEXT[s.sponsor.status] : "Asking the pilot to cover the network fees.";
      return `<div class="card">${eyebrow("funding", "Network fees")}
<h1>${stopped || failed ? "The pilot could not start" : "The pilot adds the network fees"}</h1>${err}
${stopped || failed ? `<div class="error" role="alert">${esc(text)}</div>` : `<p>${esc(text)}</p><progress aria-label="Waiting for the network fees"></progress><p class="muted">This page updates itself. It usually takes a few minutes.</p>`}
<div class="row">${failed ? `<form method="post" action="/setup/funding">${hidden("_csrf", csrf)}${hidden("action", "enroll")}<button>Try again</button></form>` : ""}
${stopped || failed ? `<form method="post" action="/setup/plan">${hidden("_csrf", csrf)}${hidden("action", "reset")}<button class="secondary">Choose another plan</button></form>` : ""}</div>
<details><summary>Technical details</summary><p class="mono">Account ${esc(owner.cosmos)}<br>Balance ${esc(balText)}${job?.error ? `<br>${esc(job.error)}` : ""}</p></details></div>`;
    }
    return `<div class="card">${eyebrow("funding", "Network fees")}
<h1>Add free test tokens</h1>
<p>Your account needs at least ${qor(MIN_SETUP_UQOR)} test QOR to start. About 15 test QOR keep one camera sealing for a day. Test QOR are free and have no value.</p>${err}
<ol><li>Copy your account address.</li><li>Open the <a href="${FAUCET}" target="_blank" rel="noreferrer">QoreChain dashboard</a> and choose <em>Faucet</em>.</li><li>Paste the address and claim test QOR. This page sees them by itself.</li></ol>
<p class="mono" id="addr">${esc(owner.cosmos)}</p><button type="button" class="secondary" data-copy="addr">Copy address</button>
<p style="margin-top:14px">Balance now: <strong>${esc(balText)}</strong></p>
<form method="post" action="/setup/funding">${hidden("_csrf", csrf)}${hidden("action", "check")}<button class="secondary">Check again</button></form>
<form method="post" action="/setup/plan">${hidden("_csrf", csrf)}${hidden("action", "reset")}<button class="secondary">Choose another plan</button></form></div>`;
  }

  private renderRegister(s: WizardState, csrf: string, err: string): string {
    const job = s.job?.kind === "register" ? s.job : undefined;
    if (job?.status === "running") {
      return `<div class="card">${eyebrow("register", "Connect")}
<h1>Connecting your camera</h1>
<p>Step ${esc(Math.max(job.step, 1))} of ${esc(job.total)}: ${esc(job.text)}</p>
<progress value="${esc(job.step)}" max="${esc(job.total)}" aria-label="Progress"></progress>
<p class="muted">This takes 1 to 3 minutes. You can close this page. The box goes on, and this page shows the right step when you open it again.</p></div>`;
    }
    if (job?.status === "failed") {
      return `<div class="card">${eyebrow("register", "Connect")}
<h1>The connection stopped</h1>${err}<div class="error" role="alert">Something went wrong while connecting to the QoreChain test network. Nothing is lost. Try again.</div>
<form method="post" action="/setup/register">${hidden("_csrf", csrf)}<button>Try again</button></form>
<details><summary>Technical details</summary><pre>${esc(job.error ?? "")}</pre></details></div>`;
    }
    return `<div class="card">${eyebrow("register", "Connect")}
<h1>Ready to connect</h1>
<p>The box now registers your camera on the QoreChain test network. After that, it seals your video every 10 minutes.</p>${err}
<ol>${REGISTER_STEPS.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>
<form method="post" action="/setup/register">${hidden("_csrf", csrf)}<button>Start</button></form></div>`;
  }

  /** Last test picture, for tests. */
  get snapshotBytes(): number {
    return this.lastSnapshot?.jpeg.length ?? 0;
  }
}

interface CameraRenderOptions {
  edit?: boolean;
  values?: { host: string; user: string; label: string; path: StreamPath; url: string };
  detail?: string;
}

function readKeyHash(p: Paths, label: string): string {
  try {
    return loadDeviceKey(`${p.keysDir}/${label}.key`).keyHash;
  } catch {
    return "";
  }
}

export function diskFree(path: string): number | undefined {
  try {
    const s = statfsSync(path);
    return s.bavail * s.bsize;
  } catch {
    return undefined;
  }
}

export function renderDone(device: string): string {
  return `<div class="card">${steps("done")}<div class="eyebrow">Done</div>
<h1>Sealing started</h1>
<p>Your box records camera <strong>${esc(device)}</strong> and seals the video every 10 minutes. The first seal comes in about 10 to 15 minutes.</p>
<a class="btn" href="/">Open my dashboard</a>
<h2>How to prove a video later</h2>
<ol><li>Open the dashboard and find the date and time.</li><li>Take the clip from the box and download its receipt. A one-click export comes in the next version.</li><li>Send both. The receiver checks them at <a href="https://qorewitness.fnoufnou.com/verifier.html" target="_blank" rel="noreferrer">qorewitness.fnoufnou.com</a>. Nobody needs to trust you or us.</li></ol>
<div class="note">Keep using the Tapo app for live view and alerts. Nothing changes there.</div></div>`;
}

// ---------------------------------------------------------------- claim (pairing and password)

export function renderClaimCode(error?: string, locked = false): string {
  return `<div class="card"><div class="eyebrow">Welcome</div>
<h1>Set up your QoreWitness box</h1>
<p>Type the 6-digit pairing code that the installer showed on the screen.</p>
<div class="note">Pilot on a test network. No money is collected.</div>
${error ? `<div class="error" role="alert">${esc(error)}</div>` : ""}
${locked ? "" : `<form method="post" action="/setup/pair"><label for="code">Pairing code</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}">
<button>Continue</button></form>`}</div>`;
}

export function renderClaimPassword(csrf: string, error?: string): string {
  return `<div class="card"><div class="eyebrow">Welcome</div>
<h1>Choose a password for this box</h1>
<p>You need it to open the dashboard later, from a phone or laptop on your home network.</p>
<div class="note">Pilot on a test network. No money is collected.</div>
${error ? `<div class="error" role="alert">${esc(error)}</div>` : ""}
<form method="post" action="/setup/password">${hidden("_csrf", csrf)}
<label for="pw">Password (at least 10 characters)</label><input id="pw" name="password" type="password" autocomplete="new-password">
<label for="pw2">Type it again</label><input id="pw2" name="again" type="password" autocomplete="new-password">
<button>Save password</button></form></div>`;
}

export function renderLogin(error?: string): string {
  return `<div class="card"><h1>Open your dashboard</h1>
${error ? `<div class="error" role="alert">${esc(error)}</div>` : ""}
<form method="post" action="/login"><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password">
<button>Open</button></form>
<details><summary>Forgot the password?</summary><p>On the box, run <span class="mono">cd ~/qorewitness &amp;&amp; ./install.sh --new-password</span>. It shows a new pairing code. Your camera and keys stay as they are.</p></details></div>`;
}
