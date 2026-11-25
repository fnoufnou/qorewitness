/**
 * The printable certificate inside the evidence ZIP. One page, plain words,
 * no web fonts, one print link. The browser's "Print" makes the PDF.
 * Brand: docs/BRAND.md (pine, signal dot).
 */
import { esc, LOGO_LIGHT } from "./html.js";

export const VERIFIER_URL = "https://qorewitness.fnoufnou.com/verifier.html";

export interface CertClip {
  file: string;
  startMs: number;
  durationMs: number;
  sha256: string;
  sha3: string;
  block?: string;
  tx?: string;
}

export interface CertData {
  camera: string;
  clips: CertClip[];
  /** Clips in the range that were left out because they failed the local check or could not be read. */
  leftOut: number;
  /** Minutes of the asked range with no clip. */
  uncoveredMinutes: number;
  /** Minutes east of UTC for display (browser time zone). 0 = UTC. */
  tzMinutes: number;
  createdAtMs: number;
  registry?: string;
  owner?: string;
  deviceId?: string;
  keyFingerprint?: string;
  chainId?: number;
}

const two = (n: number) => String(n).padStart(2, "0");

/** "21 Nov 2026 02:12:05 (UTC+01:00)" from unix ms and an offset in minutes. */
export function stamp(ms: number, tz: number, withSeconds = false): string {
  const d = new Date(ms + tz * 60000);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const hm = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}${withSeconds ? ":" + two(d.getUTCSeconds()) : ""}`;
  return `${d.getUTCDate()} ${mon} ${d.getUTCFullYear()} ${hm}`;
}
export const zone = (tz: number) => `UTC${tz < 0 ? "-" : "+"}${two(Math.floor(Math.abs(tz) / 60))}:${two(Math.abs(tz) % 60)}`;

export function certificateHtml(c: CertData): string {
  const first = Math.min(...c.clips.map((x) => x.startMs));
  const last = Math.max(...c.clips.map((x) => x.startMs + x.durationMs));
  const blocks = c.clips.map((x) => Number(x.block)).filter((n) => Number.isFinite(n));
  const sealed = blocks.length ? (Math.min(...blocks) === Math.max(...blocks) ? `block ${Math.min(...blocks)}` : `blocks ${Math.min(...blocks)} to ${Math.max(...blocks)}`) : "a block";
  const z = zone(c.tzMinutes);
  const rows = c.clips.map((x) => `<tr><td>${esc(x.file)}</td><td>${esc(stamp(x.startMs, c.tzMinutes, true))}</td><td>${esc(Math.round(x.durationMs / 1000))} s</td><td>${esc(x.block ?? "")}</td></tr>
<tr class="h"><td colspan="4">SHA-256 ${esc(x.sha256)}<br>SHA3-256 ${esc(x.sha3)}${x.tx ? `<br>Record ${esc(x.tx)}` : ""}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Certificate · ${esc(c.camera)} · QoreWitness</title>
<style>
:root{--pine:#17483A;--sig:#E8663D;--ink:#13201C;--stone:#5A6661;--line:#DCE1DD;--ok:#1E7A50;--okbg:#E6F2EC;--note:#F1F6F4}
*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--ink);font:15px/1.5 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif}
.page{max-width:46rem;margin:0 auto;padding:24px 20px}
header{display:flex;align-items:center;gap:10px;border-bottom:3px solid var(--pine);padding-bottom:10px}
.logo{width:34px;height:34px}header strong{font-size:20px}header span{margin-left:auto;font:500 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;border:1px solid var(--stone);border-radius:99px;padding:5px 8px;color:var(--stone)}
h1{font-size:26px;margin:18px 0 4px}h2{font-size:15px;margin:16px 0 4px}
.ok{background:var(--okbg);color:var(--ok);border-radius:8px;padding:10px 12px;font-weight:600;margin:12px 0}
dl{display:grid;grid-template-columns:9rem 1fr;gap:4px 12px;margin:10px 0}dt{color:var(--stone)}dd{margin:0;font-weight:500}
p{margin:0 0 8px}.two{display:grid;grid-template-columns:1fr 1fr;gap:14px}.two>div{background:var(--note);border-radius:8px;padding:10px 12px}.two h2{margin-top:0}
.fine{margin-top:18px;border-top:1px solid var(--line);padding-top:8px;font-size:10px;line-height:1.4;color:var(--stone);word-break:break-all}
.fine table{width:100%;border-collapse:collapse}.fine td{padding:1px 4px 1px 0;vertical-align:top}.fine tr.h td{font-family:ui-monospace,Menlo,monospace;font-size:8.5px;padding-bottom:4px}
a{color:#1F5C4B}.btn{display:inline-block;margin-top:14px;padding:9px 14px;background:var(--pine);color:#fff;border-radius:6px;text-decoration:none;font-weight:600}
@media (max-width:560px){.two{grid-template-columns:1fr}dl{grid-template-columns:1fr}}
@media print{.noprint{display:none}.page{padding:0;max-width:none}@page{size:A4;margin:14mm}.fine tr.h td{font-size:7.5px}}
</style></head><body><div class="page">
<header>${LOGO_LIGHT}<strong>QoreWitness</strong><span>Beta · QoreChain test network</span></header>
<h1>Evidence certificate</h1>
<p>This page belongs to an evidence file with the original video clips and their receipts.</p>
<div class="ok">${c.clips.length} clip${c.clips.length === 1 ? "" : "s"} checked against their receipts on the QoreWitness computer before this evidence file was made. All ${c.clips.length} match.</div>
<dl>
<dt>Camera</dt><dd>${esc(c.camera)}</dd>
<dt>Recording time</dt><dd>${esc(stamp(first, c.tzMinutes))} to ${esc(stamp(last, c.tzMinutes))} (${esc(z)})</dd>
<dt>Sealed in</dt><dd>QoreChain ${esc(sealed)}. Open the evidence file in QoreWitness Verify to see the exact seal time.</dd>
<dt>Certificate made</dt><dd>${esc(stamp(c.createdAtMs, c.tzMinutes))} (${esc(z)})</dd>
</dl>
${c.leftOut || c.uncoveredMinutes >= 1 ? `<p class="fine" style="border:0;margin:0 0 8px;font-size:13px;color:#8A4B0F">${c.leftOut ? `${esc(c.leftOut)} clip(s) in this range were left out because they could not be checked. ` : ""}${c.uncoveredMinutes >= 1 ? `About ${esc(Math.round(c.uncoveredMinutes))} minute(s) of the chosen time have no sealed clip.` : ""}</p>` : ""}
<div class="two">
<div><h2>What this proves</h2>
<p>The video files in this evidence file are exactly the ones the camera's QoreWitness recorded, down to the last byte.</p>
<p>They existed at the time of the seal. The seal is a signed fingerprint in a public record that nobody can edit later.</p></div>
<div><h2>What it cannot prove</h2>
<p>It does not prove who is in the video or that the scene was real.</p>
<p>It does not prove who owns the camera. The recording time comes from the clock of the QoreWitness computer. QoreWitness is in beta on the QoreChain test network, which can be reset, and a seal is not a legal timestamp.</p></div>
</div>
<h2>How to check it</h2>
<p>Open <a href="${VERIFIER_URL}">${VERIFIER_URL}</a> (QoreWitness Verify), press <b>Choose files</b> and pick this evidence file, or drop it on the page. The check runs in your browser. The video does not leave your device. See HOW-TO-CHECK.txt in the ZIP.</p>
<a class="btn noprint" href="#" onclick="window.print();return false">Print this page</a>
<div class="fine"><strong>Technical details.</strong> Chain ${esc(c.chainId ?? "")} (QoreChain test network). Registry ${esc(c.registry ?? "")}. Account ${esc(c.owner ?? "")}. Camera id ${esc(c.deviceId ?? "")}. Camera key fingerprint ${esc(c.keyFingerprint ?? "")}. Signature ML-DSA-87 over a Merkle root of SHA-256 links, file fingerprints SHA-256 and SHA3-256.
<table><thead><tr><td>File</td><td>Start</td><td>Length</td><td>Block</td></tr></thead><tbody>${rows}</tbody></table></div>
</div></body></html>`;
}
