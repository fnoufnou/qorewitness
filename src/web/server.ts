/**
 * QoreWitness box: local dashboard and browser setup, on one port.
 *
 * Node's built-in http module, no extra dependencies. While /data/setup.done is
 * missing, every page leads to /setup. After setup, /setup answers 404 and the
 * dashboard shows the health of the box in plain words, the latest seals and
 * receipt downloads.
 *
 * Access (src/web/auth.ts): pairing token or code on first run, then a password,
 * signed session cookies and a CSRF token on every POST. Host allowlist,
 * same-origin POST, private clients only, body limit 16 KB.
 *
 * The process never loads qorewitness.env into its environment. During setup the
 * wizard reads the recovery phrase from the file only for the steps that sign.
 *
 * Env: QW_DATA (default /data), QW_UI_HOST (default 127.0.0.1), QW_UI_PORT (8080),
 * QW_UI_HOSTNAME (extra allowed host names, comma separated), QW_UI_TRUST_PROXY=1,
 * QW_UI_PUBLIC_URL (shown in the log with the pairing link), QW_SPONSOR_URL.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { safeError } from "../core/redact.js";
import {
  EXPLORER, dataPaths, ensureDirs, fetchBalanceUqor, isSetupDone, liveChain, lockSecrets, readAccountInfo, readEnvFile, type AccountInfo, type Paths,
} from "../setup/steps.js";
import {
  FailureLimiter, checkPassword, clearPairing, csrfOk, csrfToken, ensurePairing, hasPassword, hostAllowed, issueSession, originOk,
  passwordProblem, privateAddress, readPairing, safeEqual, sessionSecret, sessionValid, setPassword, SESSION_SECONDS,
} from "./auth.js";
import { snapshot } from "./camera.js";
import { discoverCameras, lanPrefix } from "./discover.js";
import { evidenceForm, evidencePage, parseRange, planEvidence, writeZip } from "./evidence.js";
import { CSP, esc, layout } from "./html.js";
import { SponsorClient } from "./sponsor.js";
import { boxHealth, collectStatus, daysText, health, RECEIPT_NAME, type BoxHealth, type LocalStatus } from "./status.js";
import { Wizard, renderClaimCode, renderClaimPassword, renderDone, renderLogin } from "./wizard.js";

export { esc };
/** Constant-time string compare (kept for older callers). */
export const tokenOk = (given: string | undefined, expected: string) => safeEqual(given, expected);

const VERIFIER = "https://qorewitness.fnoufnou.com/verifier.html";
const MAX_BODY = 16 * 1024;
const ASSETS: Record<string, { file: string; type: string }> = {
  "/assets/plex-sans.woff2": { file: "web/site/fonts/plex-sans.woff2", type: "font/woff2" },
  "/assets/plex-mono-400.woff2": { file: "web/site/fonts/plex-mono-400.woff2", type: "font/woff2" },
  "/favicon.svg": { file: "web/site/favicon.svg", type: "image/svg+xml" },
};

export interface ServerOptions {
  paths: Paths;
  wizard: Wizard;
  hostnames?: string[];
  trustProxy?: boolean;
  appDir?: string;
  balance?: (qor1: string) => Promise<bigint>;
  now?: () => number;
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) {
      try {
        return decodeURIComponent(v.join("="));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

const setCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

function send(res: ServerResponse, code: number, type: string, body: string | Buffer, extra: Record<string, string | string[]> = {}) {
  res.writeHead(code, {
    "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff",
    // same-origin, not no-referrer: with no-referrer, browsers send "Origin: null" on form posts.
    "referrer-policy": "same-origin", "x-frame-options": "DENY", "content-security-policy": CSP,
    ...extra,
  });
  res.end(body);
}

const html = (res: ServerResponse, code: number, title: string, body: string, opts: { refresh?: number; script?: boolean; evidence?: boolean; wide?: boolean; extra?: Record<string, string | string[]> } = {}) =>
  send(res, code, "text/html; charset=utf-8", layout({ title, body, refreshSeconds: opts.refresh, script: opts.script, evidence: opts.evidence, wide: opts.wide }), opts.extra);

const redirect = (res: ServerResponse, to: string, extra: Record<string, string | string[]> = {}) =>
  send(res, 303, "text/plain", "", { location: to, ...extra });

async function readForm(req: IncomingMessage): Promise<Record<string, string> | undefined> {
  const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) return undefined;
    chunks.push(c as Buffer);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

// ---------------------------------------------------------------- dashboard page

const isoTime = (s: number) => new Date(s * 1000).toISOString();
const utcTime = (s: number) => isoTime(s).replace("T", " ").slice(0, 16) + " UTC";
const gb = (n?: number) => (n === undefined ? "unknown" : `${(n / 1e9).toFixed(0)} GB`);

export const GAP_TIP = "Part of the video is missing here, or the camera restarted";

/** "34 MB", "1.2 GB". */
export const sizeText = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);

/**
 * Row time from the real clips (the first window after setup holds only a few
 * minutes). A short window also says how much video it holds. The browser shows
 * the times in its own zone (box script), the text inside is the UTC fallback.
 */
function rowTime(a: LocalStatus["latest"][number], mark = ""): string {
  const from = a.videoStartMs ? Math.floor(a.videoStartMs / 1000) : a.windowStart;
  const to = a.videoEndMs ? Math.floor(a.videoEndMs / 1000) : a.windowStart + a.windowSeconds;
  const minutes = Math.round(a.videoMs / 60000);
  const partial = a.videoMs > 0 && a.videoMs < a.windowSeconds * 1000 * 0.8;
  const extra = [partial ? `${minutes < 1 ? "less than a minute" : `${minutes} minute${minutes === 1 ? "" : "s"}`} of video` : "", a.bytes ? sizeText(a.bytes) : ""].filter(Boolean).join(" · ");
  return `<time data-local datetime="${esc(isoTime(from))}" data-end="${esc(isoTime(to))}">${esc(utcTime(from))}</time>${mark}${extra ? `<div class="muted" style="font-size:13px">${esc(extra)}</div>` : ""}`;
}

export interface DashboardView {
  status: LocalStatus;
  health: BoxHealth;
  info?: AccountInfo;
  balanceUqor?: number;
  retentionDays?: number;
  csrf?: string;
}

/**
 * The owner's main view: one coloured line with one action, four plain facts,
 * the latest seals in local time with a Download button each. Every technical
 * word (block, registry, QOR, key) sits in the folded Details.
 */
export function dashboardPage(v: DashboardView): string {
  const s = v.status;
  const h = v.health;
  const download = (a: LocalStatus["latest"][number]) => v.csrf
    ? `<form method="post" action="/evidence/download" style="margin:0">${`<input type="hidden" name="_csrf" value="${esc(v.csrf)}">`}<input type="hidden" name="fromMs" value="${a.windowStart * 1000}"><input type="hidden" name="toMs" value="${(a.windowStart + a.windowSeconds) * 1000}"><input type="hidden" name="tz" value="0"><button class="secondary" style="margin:0;padding:8px 12px">Download</button></form>`
    : "";
  const rows = s.latest.map((a) => `<tr>
    <td>${rowTime(a, a.warnings ? ` <span title="${GAP_TIP}" aria-label="${GAP_TIP}">&#9888;</span>` : "")}</td>
    <td style="text-align:right">${download(a)}</td></tr>`).join("");
  const fees = v.info?.plan === "self"
    ? (h.feeDaysLeft === undefined ? "unknown" : `${daysText(h.feeDaysLeft)} left`)
    : "Free beta: we cover them";
  const camera = s.newestSegmentAgeSeconds === undefined ? "no video yet" : s.newestSegmentAgeSeconds <= 300 ? "online" : `no video for ${Math.round(s.newestSegmentAgeSeconds / 60)} min`;
  const tech = s.latest.filter((a) => a.txHash).map((a) => `${esc(utcTime(a.windowStart))}: <a href="${EXPLORER}/tx/${esc(a.txHash)}" rel="noreferrer" target="_blank">block ${esc(a.blockNumber ?? "")}</a>, ${esc(a.segments)} clips, <a href="/receipts/${encodeURIComponent(a.file)}" download>receipt</a>`).join("<br>");
  return `<div class="status ${h.level}" role="status"><span class="dot"></span><div><strong>${esc(h.title)}</strong>${h.action ? `<p>${esc(h.action)}</p>` : ""}</div></div>
<div class="facts">
<div><b>Camera</b>${esc(camera)}</div>
<div><b>Last seal</b>${s.lastAnchorAgeSeconds === undefined ? "none yet" : `${esc(Math.max(0, Math.round(s.lastAnchorAgeSeconds / 60)))} min ago`}</div>
<div><b>Network fees</b>${esc(fees)}</div>
<div><b>Video kept</b>${esc(v.retentionDays ?? 14)} days, ${esc(gb(s.diskFreeBytes))} free</div>
</div>
<div class="card"><h2 style="margin-top:0">Latest seals</h2><div class="scroll"><table><tbody>${rows || `<tr><td>No seals yet.</td></tr>`}</tbody></table></div>
<p class="muted" style="margin-top:12px">Press Download next to the time you need. You get one file with the original video and its proof. The file is large, so share it with an upload or a link (for example your cloud drive) rather than by e-mail. Send it to an insurer, the police or a lawyer. They check it at <a href="${VERIFIER}" rel="noreferrer" target="_blank">qorewitness.fnoufnou.com</a>.</p>
<details><summary>Details</summary><p class="mono">${tech}${tech ? "<br>" : ""}Receipts ${esc(s.receipts)}, waiting windows ${esc(s.pendingWindows)}, open segments ${esc(s.openSegments)}, clips on disk ${esc(s.segmentFiles)}<br>
${v.balanceUqor !== undefined ? `Balance ${esc((v.balanceUqor / 1e6).toFixed(2))} test QOR<br>` : ""}${v.info ? `Account ${esc(v.info.qor1)}<br>Owner ${esc(v.info.owner)}<br>Device id ${esc(v.info.deviceId)}<br>Camera key ${esc(v.info.keyFingerprint)} (ML-DSA-87)<br>Registry <a href="${EXPLORER}/address/${esc(v.info.registry)}" rel="noreferrer" target="_blank">${esc(v.info.registry)}</a>` : ""}</p></details></div>
${v.csrf ? `<details class="card"><summary>Pick another time</summary>${evidenceForm(v.csrf)}</details>` : ""}
${v.csrf ? `<form method="post" action="/logout"><input type="hidden" name="_csrf" value="${esc(v.csrf)}"><button class="secondary">Log out</button></form>` : ""}`;
}

/** Older read-only page (kept for the phase 1 tests). */
export function page(s: LocalStatus, h: ReturnType<typeof health>, reg: string): string {
  return layout({
    title: s.device, refreshSeconds: 60, wide: true,
    body: dashboardPage({ status: s, health: { level: h.level, title: h.text }, info: reg ? ({ registry: reg } as AccountInfo) : undefined }),
  });
}

// ---------------------------------------------------------------- handler

export function createHandler(o: ServerOptions) {
  const p = o.paths;
  const ui = p.uiDir;
  const appDir = o.appDir ?? resolve(".");
  const now = o.now ?? Date.now;
  const pairFails = new FailureLimiter(10, 24 * 3600_000); // then: run "pair" again or restart the ui
  const loginFails = new FailureLimiter(5, 60_000);
  let exporting = false;
  let balanceCache: { at: number; qor1: string; value?: number } | undefined;

  async function balance(qor1: string): Promise<number | undefined> {
    if (balanceCache && balanceCache.qor1 === qor1 && now() - balanceCache.at < 60_000) return balanceCache.value;
    let value: number | undefined;
    try {
      value = Number(await (o.balance ?? fetchBalanceUqor)(qor1));
    } catch {
      value = balanceCache?.qor1 === qor1 ? balanceCache.value : undefined;
    }
    balanceCache = { at: now(), qor1, value };
    return value;
  }

  async function dashboard(res: ServerResponse, csrf: string, json: boolean) {
    const info = readAccountInfo(p);
    const cam = readEnvFile(p.cameraEnv);
    const device = info?.device ?? cam.QW_DEVICE ?? "camera";
    const windowSeconds = Number(cam.QW_WINDOW_SECONDS ?? 600);
    const status = collectStatus({ device, receiptDir: join(p.data, device, "receipts"), segmentDir: join(p.data, device, "segments") });
    let setupAgeSeconds: number | undefined;
    try {
      setupAgeSeconds = (now() - Date.parse(readFileSync(p.done, "utf8").trim() || "x")) / 1000;
    } catch {
      setupAgeSeconds = undefined;
    }
    if (!Number.isFinite(setupAgeSeconds)) setupAgeSeconds = undefined;
    const bal = info ? await balance(info.qor1) : undefined;
    const h = boxHealth(status, { windowSeconds, plan: info?.plan, balanceUqor: bal, setupAgeSeconds, qor1: info?.qor1 });
    if (json) return send(res, 200, "application/json", JSON.stringify({ ...status, health: h, plan: info?.plan, balanceUqor: bal }));
    return html(res, 200, device, dashboardPage({ status, health: h, info, balanceUqor: bal, retentionDays: Number(cam.QW_RETENTION_DAYS ?? 14), csrf }), { refresh: 60, wide: true, evidence: true });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 1. Network checks on every request.
    if (!hostAllowed(req.headers.host, o.hostnames)) {
      return send(res, 421, "text/plain; charset=utf-8", "Unknown host name. Open QoreWitness by its IP address, as the installer showed. To allow a name, set QW_UI_HOSTNAME.");
    }
    if (!o.trustProxy && (req.headers["x-forwarded-for"] || req.headers.forwarded)) {
      return send(res, 400, "text/plain; charset=utf-8", "Requests through a proxy are refused. Set QW_UI_TRUST_PROXY=1 if you use one on purpose.");
    }
    if (!privateAddress(req.socket.remoteAddress)) return send(res, 403, "text/plain; charset=utf-8", "Only devices on the home network can open this page.");
    const url = new URL(req.url ?? "/", "http://local");
    const path = url.pathname;

    // 2. Static files (fonts, icon). Public, no secrets.
    if (req.method === "GET" && ASSETS[path]) {
      try {
        return send(res, 200, ASSETS[path].type, readFileSync(join(appDir, ASSETS[path].file)), { "cache-control": "public, max-age=86400" });
      } catch {
        return send(res, 404, "text/plain", "not found");
      }
    }
    if (req.method !== "GET" && req.method !== "POST") return send(res, 405, "text/plain", "method not allowed");

    let form: Record<string, string> = {};
    if (req.method === "POST") {
      if (!originOk(req.headers.origin, req.headers.host)) return send(res, 403, "text/plain; charset=utf-8", "This form must be sent from this page.");
      const f = await readForm(req);
      if (!f) return send(res, 413, "text/plain; charset=utf-8", "The form is too large or of the wrong type.");
      form = f;
    }

    const claimed = hasPassword(ui);
    const done = isSetupDone(p);
    const client = req.socket.remoteAddress ?? "?";

    // 3. First run: pairing, then a password.
    if (!claimed) {
      const pairing = readPairing(ui);
      if (!pairing) return html(res, 503, "Setup", renderClaimCode("There is no pairing code yet. Run the installer again to get one.", true));
      const claimCsrf = csrfToken(pairing.token, "claim");
      const claimOk = safeEqual(cookie(req, "qw_claim"), pairing.token);
      const claimCookie = setCookie("qw_claim", pairing.token, 24 * 3600);
      if (req.method === "GET" && url.searchParams.has("token")) {
        if (!safeEqual(url.searchParams.get("token") ?? "", pairing.token)) {
          // Not counted in pairFails: a GET needs no Origin, so any web page could send
          // bad links and lock the code entry. The 192-bit token needs no limit.
          return html(res, 403, "Setup", renderClaimCode("This setup link is not valid. Type the pairing code instead."));
        }
        // Move the token from the address bar into a cookie. A same-page reload keeps SameSite=Strict happy.
        return send(res, 200, "text/html; charset=utf-8", `<!doctype html><meta http-equiv="refresh" content="0;url=/setup"><title>QoreWitness</title><a href="/setup">Continue</a>`, { "set-cookie": claimCookie });
      }
      if (req.method === "POST" && path === "/setup/pair") {
        if (pairFails.blocked("pair")) return html(res, 429, "Setup", renderClaimCode("Too many wrong codes. Run the installer again to get a new code.", true));
        if (!safeEqual((form.code ?? "").replace(/\s/g, ""), pairing.code)) {
          pairFails.fail("pair");
          return html(res, 403, "Setup", renderClaimCode("This code is not right. Check the code on the installer screen."));
        }
        pairFails.reset("pair");
        return redirect(res, "/setup", { "set-cookie": claimCookie });
      }
      if (req.method === "POST" && path === "/setup/password") {
        if (!claimOk || !csrfOk(pairing.token, "claim", form._csrf)) return send(res, 403, "text/plain; charset=utf-8", "Open the setup link again.");
        const problem = passwordProblem(form.password ?? "");
        if (problem) return html(res, 400, "Setup", renderClaimPassword(claimCsrf, problem));
        setPassword(ui, form.password!);
        clearPairing(ui);
        const session = issueSession(sessionSecret(ui)!, now());
        return redirect(res, "/setup", { "set-cookie": [setCookie("qw_session", session, SESSION_SECONDS), setCookie("qw_claim", "", 0)] });
      }
      if (req.method === "GET" && path === "/setup") {
        return claimOk ? html(res, 200, "Setup", renderClaimPassword(claimCsrf)) : html(res, 200, "Setup", renderClaimCode(pairFails.blocked("pair") ? "Too many wrong codes. Run the installer again to get a new code." : undefined, pairFails.blocked("pair")));
      }
      return req.method === "GET" ? redirect(res, "/setup") : send(res, 404, "text/plain", "not found");
    }

    // 4. Login.
    const secret = sessionSecret(ui)!;
    const session = cookie(req, "qw_session");
    const authed = sessionValid(secret, session, now());
    if (!authed) {
      if (req.method === "POST" && path === "/login") {
        if (loginFails.blocked(client, now()) || loginFails.blocked("*", now())) return html(res, 429, "Log in", renderLogin("Too many tries. Wait one minute."));
        if (!checkPassword(ui, form.password ?? "")) {
          loginFails.fail(client, now());
          loginFails.fail("*", now());
          return html(res, 403, "Log in", renderLogin("This password is not right."));
        }
        loginFails.reset(client);
        return redirect(res, done ? "/" : "/setup", { "set-cookie": setCookie("qw_session", issueSession(secret, now()), SESSION_SECONDS) });
      }
      if (req.method === "GET" && path === "/login") return html(res, 200, "Log in", renderLogin());
      if (path.startsWith("/api/")) return send(res, 401, "application/json", JSON.stringify({ error: "login needed" }));
      return req.method === "GET" ? redirect(res, "/login") : send(res, 403, "text/plain", "login needed");
    }

    // 5. Signed in. Every POST needs the CSRF token of this session.
    const csrf = csrfToken(secret, session!);
    if (req.method === "POST" && !csrfOk(secret, session, form._csrf)) return send(res, 403, "text/plain; charset=utf-8", "The form expired. Go back and reload the page.");
    if (req.method === "POST" && path === "/logout") return redirect(res, "/login", { "set-cookie": setCookie("qw_session", "", 0) });
    if (path === "/login") return redirect(res, done ? "/" : "/setup");

    if (!done) {
      const w = o.wizard;
      if (req.method === "POST" && path.startsWith("/setup/")) {
        const r = await w.post(path, { ...form, _csrf: csrf, _base: `http://${req.headers.host ?? ""}` });
        if (r.redirect) return redirect(res, r.redirect);
        return html(res, 200, "Setup", r.html ?? "");
      }
      if (req.method === "GET" && path === "/setup") {
        w.resumeIfInterrupted();
        const screen = await w.screen();
        if (screen === "done") return redirect(res, "/setup/done");
        return html(res, 200, "Setup", await w.render(screen, csrf, `http://${req.headers.host ?? ""}`), { refresh: w.refreshFor(screen) });
      }
      return req.method === "GET" ? redirect(res, "/setup") : send(res, 404, "text/plain", "not found");
    }

    // 6. Setup is done: dashboard. /setup is closed (no more setup actions), only the done page stays.
    // From now on this process never reads the recovery phrase or the camera keys (enforced in steps.ts).
    lockSecrets();
    if (req.method === "GET" && path === "/setup/done") return html(res, 200, "Sealing started", renderDone(`http://${req.headers.host ?? ""}`, process.env.QW_UI_PUBLIC_URL));
    if (req.method === "GET" && path === "/setup") return redirect(res, "/setup/done");
    if (path === "/setup" || path.startsWith("/setup/")) {
      return html(res, 404, "Setup finished", `<div class="card"><h1>Setup is finished</h1><p>QoreWitness is set up. Changes to the camera come in a later version.</p><a class="btn" href="/">Open my dashboard</a></div>`);
    }
    if (req.method === "GET" && path === "/") return dashboard(res, csrf, false);
    if (req.method === "GET" && path === "/api/status") return dashboard(res, csrf, true);
    if (req.method === "POST" && (path === "/evidence/check" || path === "/evidence/download")) {
      const info = readAccountInfo(p);
      const cam = readEnvFile(p.cameraEnv);
      const device = info?.device ?? cam.QW_DEVICE ?? "camera";
      const range = parseRange(form, now());
      if (!range) return html(res, 400, "Save evidence", evidencePage({ problems: ["Pick a date and a start and end time."] }, csrf));
      if (exporting) return html(res, 429, "Save evidence", evidencePage({ problems: ["Another export is running. Try again in a minute."] }, csrf));
      exporting = true;
      try {
        const plan = await planEvidence({
          device, receiptDir: join(p.data, device, "receipts"), segmentDir: join(p.data, device, "segments"),
          ...range, now: now(), account: info ? { registry: info.registry, owner: info.owner, deviceId: info.deviceId, keyFingerprint: info.keyFingerprint } : undefined,
        });
        if (path === "/evidence/check" || !plan.entries.length) {
          return html(res, plan.entries.length || path === "/evidence/check" ? 200 : 404, "Save evidence", evidencePage({ plan, range }, csrf));
        }
        res.writeHead(200, {
          "content-type": "application/zip", "content-length": String(plan.zipBytes), "cache-control": "no-store",
          "content-disposition": `attachment; filename="${plan.zipName}"`, "x-content-type-options": "nosniff",
        });
        try {
          await writeZip(plan.entries, res);
          res.end();
        } catch (e) {
          console.error(`${new Date().toISOString()} evidence export failed: ${safeError(e)}`);
          res.destroy(); // a cut-off download is better than a ZIP with a wrong file in it
        }
        return;
      } finally {
        exporting = false;
      }
    }
    const m = /^\/receipts\/([^/]+)$/.exec(path);
    if (req.method === "GET" && m) {
      const info = readAccountInfo(p);
      const device = info?.device ?? readEnvFile(p.cameraEnv).QW_DEVICE ?? "camera";
      let name: string;
      try {
        name = decodeURIComponent(m[1]);
      } catch {
        return send(res, 404, "text/plain", "not found");
      }
      if (!RECEIPT_NAME.test(name) || !name.startsWith(`${device}-`)) return send(res, 404, "text/plain", "not found");
      try {
        return send(res, 200, "application/json", readFileSync(join(p.data, device, "receipts", name)), { "content-disposition": `attachment; filename="${name}"` });
      } catch {
        return send(res, 404, "text/plain", "not found");
      }
    }
    return send(res, 404, "text/plain", "not found");
  }

  return (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((e: unknown) => {
      console.error(`${new Date().toISOString()} ui error: ${safeError(e)}`);
      if (!res.headersSent) send(res, 500, "text/plain; charset=utf-8", "Something went wrong. Reload the page.");
      else res.end();
    });
  };
}

// ---------------------------------------------------------------- main

if (process.argv[1] && /server\.(ts|js)$/.test(process.argv[1])) {
  const paths = dataPaths();
  ensureDirs(paths);
  if (isSetupDone(paths)) lockSecrets();
  const wizard = new Wizard({
    paths, chain: liveChain(), sponsor: () => new SponsorClient(), snapshot: (u) => snapshot(u),
    discover: async (hints) => {
      const prefix = lanPrefix(hints);
      return prefix ? discoverCameras({ prefix }) : [];
    },
  });
  const host = process.env.QW_UI_HOST?.trim() || "127.0.0.1";
  const port = Number(process.env.QW_UI_PORT ?? 8080);
  const handler = createHandler({
    paths, wizard,
    hostnames: (process.env.QW_UI_HOSTNAME ?? "").split(","),
    trustProxy: process.env.QW_UI_TRUST_PROXY === "1",
  });
  createServer({ requestTimeout: 60_000, headersTimeout: 20_000 }, handler).listen(port, host, () => {
    const at = new Date().toISOString();
    console.log(`${at} QoreWitness box on ${host}:${port}`);
    if (!hasPassword(paths.uiDir)) {
      // The pairing link, once per start, in the container log only.
      const { pairing } = ensurePairing(paths.uiDir);
      const base = process.env.QW_UI_PUBLIC_URL?.replace(/\/+$/, "") || `http://localhost:${port}`;
      if (pairing) console.log(`${at} first-run setup: ${base}/setup?token=${pairing.token}  pairing code ${pairing.code}`);
    } else if (!isSetupDone(paths)) {
      console.log(`${at} setup is open: log in at /setup with the dashboard password`);
    }
  });
}
