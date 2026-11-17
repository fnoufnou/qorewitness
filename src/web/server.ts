/**
 * QoreWitness local dashboard (T25, phase 1: read only).
 *
 * A small web server inside the container, with Node's built-in http module and
 * no extra dependencies. It shows the camera's health, the latest anchors with
 * links to the public explorer, and lets the owner download receipts. It holds
 * no keys and sends no transactions.
 *
 * Access: a token. Set QW_UI_TOKEN, or the server makes one at start and prints
 * the link in the log. The token is checked in constant time, then kept in an
 * HttpOnly cookie. Listen address: QW_UI_HOST (default 127.0.0.1), QW_UI_PORT
 * (default 8080). In Docker, compose publishes it on 127.0.0.1 only.
 *
 * Env: QW_DEVICE, QW_SEGMENT_DIR, QW_RECEIPT_DIR, QW_WINDOW_SECONDS, QORE_REGISTRY (shown only).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectStatus, health, RECEIPT_NAME, type LocalStatus } from "./status.js";

const env = (k: string, d: string) => process.env[k]?.trim() || d;
const device = env("QW_DEVICE", "camera");
const segmentDir = env("QW_SEGMENT_DIR", `/data/${device}/segments`);
const receiptDir = env("QW_RECEIPT_DIR", `/data/${device}/receipts`);
const windowSeconds = Number(env("QW_WINDOW_SECONDS", "600"));
const registry = env("QORE_REGISTRY", "");
const host = env("QW_UI_HOST", "127.0.0.1");
const port = Number(env("QW_UI_PORT", "8080"));
const token = env("QW_UI_TOKEN", randomBytes(18).toString("base64url"));
const EXPLORER = "https://explore.qore.network";

export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function tokenOk(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

const mb = (n: number) => `${(n / 1e6).toFixed(0)} MB`;
const gb = (n?: number) => (n === undefined ? "unknown" : `${(n / 1e9).toFixed(1)} GB`);
const time = (s: number) => new Date(s * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";

export function page(s: LocalStatus, h: ReturnType<typeof health>, reg: string): string {
  const rows = s.latest.map((a) => `<tr>
    <td>${esc(time(a.windowStart))}</td><td>${esc(a.segments)}</td>
    <td>${a.txHash ? `<a href="${EXPLORER}/tx/${esc(a.txHash)}" rel="noreferrer" target="_blank">${esc(a.blockNumber ?? "tx")}</a>` : "-"}</td>
    <td>${a.warnings ? `<span class="warn">${esc(a.warnings)}</span>` : "0"}</td>
    <td>${esc(a.spec ?? "")}</td>
    <td><a href="/receipts/${encodeURIComponent(a.file)}" download>receipt</a></td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60"><title>QoreWitness: ${esc(s.device)}</title><style>
:root{--pine:#17483A;--ink:#13201C;--stone:#5A6661;--line:#DCE1DD;--bg:#F6F7F5;--ok:#1E7A50;--okbg:#E6F2EC;--bad:#B42318;--badbg:#FBEAE7;--sig:#E8663D}
@media (prefers-color-scheme:dark){:root{--ink:#E8EFEC;--stone:#A9B6B0;--line:#2A433C;--bg:#0F211C;--okbg:#173A2C;--badbg:#3A1D18}body{background:#0F211C}main{background:#152B25}}
body{margin:0;font:15px/1.5 system-ui,"IBM Plex Sans",sans-serif;color:var(--ink);background:var(--bg)}
header{background:var(--pine);color:#fff;padding:14px 16px;display:flex;gap:10px;align-items:center}
header i{width:10px;height:10px;border-radius:50%;background:var(--sig);display:inline-block}
main{max-width:960px;margin:16px auto;padding:16px;background:#fff;border:1px solid var(--line);border-radius:8px}
.health{padding:10px 12px;border-radius:6px;margin-bottom:16px}.ok{background:var(--okbg);color:var(--ok)}.warn{color:var(--sig)}.bad{background:var(--badbg);color:var(--bad)}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;margin-bottom:16px}
.facts div{border:1px solid var(--line);border-radius:6px;padding:8px}.facts b{display:block;font-size:12px;color:var(--stone);font-weight:500}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:6px;border-bottom:1px solid var(--line)}
.scroll{overflow-x:auto}a{color:var(--pine)}@media (prefers-color-scheme:dark){a{color:#7FC4AE}}small{color:var(--stone)}
</style></head><body><header><i></i><strong>QoreWitness</strong><span>${esc(s.device)}</span></header><main>
<div class="health ${h.level === "ok" ? "ok" : h.level === "bad" ? "bad" : "warn"}">${esc(h.text)}</div>
<div class="facts">
<div><b>Last window ended</b>${s.lastAnchorAgeSeconds === undefined ? "none yet" : `${esc(Math.round(s.lastAnchorAgeSeconds / 60))} min ago`}</div>
<div><b>Receipts</b>${esc(s.receipts)}</div>
<div><b>Waiting to anchor</b>${esc(s.pendingWindows)} window(s), ${esc(s.openSegments)} open segment(s)</div>
<div><b>Clips on disk</b>${esc(s.segmentFiles)} (${esc(mb(s.segmentBytes))})</div>
<div><b>Disk free</b>${esc(gb(s.diskFreeBytes))} of ${esc(gb(s.diskTotalBytes))}</div>
<div><b>Registry</b>${reg ? `<a href="${EXPLORER}/address/${esc(reg)}" rel="noreferrer" target="_blank">${esc(reg.slice(0, 10))}…</a>` : "not set"}</div>
</div>
<h2>Latest anchored windows</h2><div class="scroll"><table><thead><tr><th>Window start</th><th>Clips</th><th>Block</th><th>Warnings</th><th>Rules</th><th></th></tr></thead>
<tbody>${rows || `<tr><td colspan="6">No receipts yet.</td></tr>`}</tbody></table></div>
<p><small>Check any clip with its receipt in the public verifier: <a href="https://qorewitness.fnoufnou.com/verifier.html" rel="noreferrer" target="_blank">qorewitness.fnoufnou.com/verifier.html</a>. Your clips never leave this machine. This page refreshes every minute.</small></p>
</main></body></html>`;
}

function send(res: ServerResponse, code: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) {
  res.writeHead(code, {
    "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer", "x-frame-options": "DENY",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
    ...extra,
  });
  res.end(body);
}

export function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://local");
  if (req.method !== "GET") return send(res, 405, "text/plain", "method not allowed");
  const q = url.searchParams.get("token") ?? undefined;
  if (tokenOk(q, token)) {
    // Move the token from the address bar into a cookie.
    return send(res, 303, "text/plain", "", {
      location: url.pathname, "set-cookie": `qw_ui=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
    });
  }
  if (!tokenOk(cookie(req, "qw_ui"), token)) {
    return send(res, 401, "text/plain; charset=utf-8", "QoreWitness dashboard: open the link with ?token=... from the container log.");
  }
  const s = collectStatus({ device, receiptDir, segmentDir });
  if (url.pathname === "/") return send(res, 200, "text/html; charset=utf-8", page(s, health(s, windowSeconds), registry));
  if (url.pathname === "/api/status") return send(res, 200, "application/json", JSON.stringify({ ...s, health: health(s, windowSeconds) }));
  const m = /^\/receipts\/([^/]+)$/.exec(url.pathname);
  if (m) {
    const name = decodeURIComponent(m[1]);
    if (!RECEIPT_NAME.test(name) || !name.startsWith(`${device}-`)) return send(res, 404, "text/plain", "not found");
    try {
      return send(res, 200, "application/json", readFileSync(join(receiptDir, name)), { "content-disposition": `attachment; filename="${name}"` });
    } catch {
      return send(res, 404, "text/plain", "not found");
    }
  }
  return send(res, 404, "text/plain", "not found");
}

if (process.argv[1] && /server\.(ts|js)$/.test(process.argv[1])) {
  createServer(handler).listen(port, host, () => {
    const shown = host === "0.0.0.0" ? "localhost" : host;
    console.log(`${new Date().toISOString()} dashboard for ${device}: http://${shown}:${port}/?token=${token}`);
  });
}
