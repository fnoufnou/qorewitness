/**
 * Shared page frame for the dashboard and the browser setup, in the QoreWitness
 * brand (docs/BRAND.md): pine, the signal dot, IBM Plex. Mobile first.
 * One small inline script (copy button) is allowed by its CSP hash.
 */
import { createHash } from "node:crypto";

export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const LOGO = `<svg class="logo" viewBox="0 0 64 64" aria-hidden="true"><path d="M32 4.5H12Q7.5 4.5 7.5 9V29C7.5 44.5 17.5 55 32 60.5Z" fill="#246A54" transform="matrix(-1 0 0 1 64 0)"/><path d="M32 4.5H12Q7.5 4.5 7.5 9V29C7.5 44.5 17.5 55 32 60.5Z" fill="#4FA586"/><path d="M15.5 23V16.5H22" fill="none" stroke="#FFFFFF" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.5 35V41.5H22" fill="none" stroke="#FFFFFF" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M42 41.5H48.5V35" fill="none" stroke="#CFE5DC" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="46" cy="19" r="3.6" fill="#EE7046"/><path d="M24.8 29.4L29.8 34.4L39.4 24.4" fill="none" stroke="#FFFFFF" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
export const LOGO_LIGHT = `<svg class="logo" viewBox="0 0 64 64" aria-hidden="true"><path d="M32 4.5H12Q7.5 4.5 7.5 9V29C7.5 44.5 17.5 55 32 60.5Z" fill="#17483A" transform="matrix(-1 0 0 1 64 0)"/><path d="M32 4.5H12Q7.5 4.5 7.5 9V29C7.5 44.5 17.5 55 32 60.5Z" fill="#2F7D64"/><path d="M15.5 23V16.5H22" fill="none" stroke="#FFFFFF" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.5 35V41.5H22" fill="none" stroke="#FFFFFF" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M42 41.5H48.5V35" fill="none" stroke="#D9EAE3" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="46" cy="19" r="3.6" fill="#E8663D"/><path d="M24.8 29.4L29.8 34.4L39.4 24.4" fill="none" stroke="#FFFFFF" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/**
 * The one small script of the box pages (allowed by its CSP hash). Each part does
 * nothing when its elements are missing, and every page works without it.
 * - [data-copy]: copy button.  - [data-show]: show the password.
 * - time[data-local]: the time in the browser's own time zone.  - input[name=tz]: the zone offset.
 * - select[data-brand]: show the link field only for brands that need a full link, and only that brand's hint.
 *   A found camera with a known brand (ONVIF) sets the brand when it is picked.
 */
export const BOX_SCRIPT = `(function(){var q=function(s){return document.querySelectorAll(s)};
q("[data-copy]").forEach(function(b){b.addEventListener("click",function(){var t=document.getElementById(b.getAttribute("data-copy"));if(t&&navigator.clipboard)navigator.clipboard.writeText(t.textContent.trim()).then(function(){b.textContent="Copied";});});});
q("[data-show]").forEach(function(c){c.addEventListener("change",function(){var i=document.getElementById(c.getAttribute("data-show"));if(i)i.type=c.checked?"text":"password";});});
var d=function(x){return x.toLocaleDateString(undefined,{weekday:"short",day:"numeric",month:"short"})},h=function(x){return x.toLocaleTimeString(undefined,{hour:"2-digit",minute:"2-digit"})};
q("time[data-local]").forEach(function(t){var a=new Date(t.getAttribute("datetime")),e=t.getAttribute("data-end");if(isNaN(a))return;t.textContent=d(a)+", "+h(a)+(e?" to "+h(new Date(e)):"");});
q("input[name=tz]").forEach(function(i){i.value=String(-new Date().getTimezoneOffset());});
q("select[data-brand]").forEach(function(sel){var f=function(){var o=sel.options[sel.selectedIndex],full=o&&o.getAttribute("data-full")==="1";q("[data-linkfield]").forEach(function(e){e.hidden=!full;});q("[data-hint]").forEach(function(e){e.hidden=!!sel.value&&e.getAttribute("data-hint")!==sel.value;});};sel.addEventListener("change",f);f();q("input[name=found][data-brand]").forEach(function(r){r.addEventListener("change",function(){sel.value=r.getAttribute("data-brand");f();});});});})();`;
const BOX_HASH = `'sha256-${createHash("sha256").update(BOX_SCRIPT).digest("base64")}'`;

/** Fills the "Save evidence" form: the browser's time zone and the last hour as default. Runs without it too. */
export const EVIDENCE_SCRIPT = `(function(){var f=document.getElementById("evf");if(!f)return;var p=function(n){return String(n).padStart(2,"0")},t=new Date(),s=new Date(t.getTime()-36e5);f.elements.tz.value=String(-t.getTimezoneOffset());if(!f.elements.date.value){f.elements.date.value=s.getFullYear()+"-"+p(s.getMonth()+1)+"-"+p(s.getDate());f.elements.from.value=p(s.getHours())+":"+p(s.getMinutes());f.elements.to.value=p(t.getHours())+":"+p(t.getMinutes());}})();`;
const EVIDENCE_HASH = `'sha256-${createHash("sha256").update(EVIDENCE_SCRIPT).digest("base64")}'`;

export const CSP = `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; script-src ${BOX_HASH} ${EVIDENCE_HASH}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

const CSS = `
@font-face{font-family:"IBM Plex Sans";src:url(/assets/plex-sans.woff2) format("woff2");font-weight:100 700;font-display:swap}
@font-face{font-family:"IBM Plex Mono";src:url(/assets/plex-mono-400.woff2) format("woff2");font-weight:400;font-display:swap}
:root{--pine9:#0E2F26;--pine:#17483A;--pine7:#1F5C4B;--pine1:#E4EEEA;--pine05:#F1F6F4;--sig:#E8663D;--sigink:#B3451C;--ink:#13201C;--stone:#5A6661;--line:#DCE1DD;--bg:#F6F7F5;--card:#fff;
--ok:#1E7A50;--okbg:#E6F2EC;--warn:#8A4B0F;--warnbg:#FDF0E3;--bad:#B42318;--badbg:#FBEAE7;--link:#1F5C4B}
@media (prefers-color-scheme:dark){:root{--ink:#E8EFEC;--stone:#A9B6B0;--line:#2A433C;--bg:#0F211C;--card:#152B25;--pine05:#183229;--pine1:#1D3B32;--okbg:#173A2C;--ok:#7FD1A8;--warnbg:#3A2B17;--warn:#F2B279;--badbg:#3A1D18;--bad:#F29A8F;--link:#7FC4AE;--sigink:#F29A70}}
*{box-sizing:border-box}
body{margin:0;font:16px/1.55 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg)}
header{background:var(--pine);color:#fff;padding:12px 16px;display:flex;gap:10px;align-items:center}
header .logo{width:28px;height:28px}header strong{font-weight:600;font-size:17px}header .tag{margin-left:auto;font:500 11px/1 "IBM Plex Mono",monospace;letter-spacing:.08em;text-transform:uppercase;border:1px solid rgba(255,255,255,.4);border-radius:99px;padding:5px 8px}
main{max-width:44rem;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:20px 16px;margin-bottom:16px}
h1{font-size:24px;line-height:1.25;margin:0 0 8px;font-weight:600}h2{font-size:18px;margin:20px 0 8px;font-weight:600}
p{margin:0 0 12px}small,.muted{color:var(--stone)}a{color:var(--link)}
.eyebrow{font:500 12px/1 "IBM Plex Mono",monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--sigink);margin-bottom:10px}
label{display:block;font-weight:500;margin:14px 0 4px}
input[type=text],input[type=password],input[type=number],select{width:100%;font:inherit;padding:11px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink)}
input:focus,select:focus,button:focus,a:focus{outline:2px solid var(--sig);outline-offset:2px}
.check{display:flex;gap:10px;align-items:flex-start;font-weight:400;margin:16px 0}.check input{margin-top:5px;width:18px;height:18px}
.hint{font-size:14px;color:var(--stone);margin-top:4px}
button,.btn{display:inline-block;font:600 16px/1 "IBM Plex Sans",system-ui,sans-serif;padding:13px 18px;border-radius:8px;border:1px solid var(--pine);background:var(--pine);color:#fff;cursor:pointer;text-decoration:none;margin:12px 8px 0 0}
button:hover,.btn:hover{background:var(--pine9)}
button.secondary,.btn.secondary{background:var(--card);color:var(--ink);border-color:var(--line)}
.row{display:flex;flex-wrap:wrap;gap:0}
.status{display:flex;gap:12px;align-items:flex-start;border-radius:8px;padding:14px;margin-bottom:12px}
.status .dot{flex:none;width:14px;height:14px;border-radius:50%;margin-top:5px}
.status.ok{background:var(--okbg);color:var(--ok)}.status.ok .dot{background:var(--ok)}
.status.warn{background:var(--warnbg);color:var(--warn)}.status.warn .dot{background:var(--sig)}
.status.bad{background:var(--badbg);color:var(--bad)}.status.bad .dot{background:var(--bad)}
.status strong{display:block;font-size:17px}.status p{margin:4px 0 0;color:var(--ink)}
.steps{display:flex;gap:4px;margin:0 0 14px}.steps span{flex:1;height:4px;border-radius:2px;background:var(--line)}.steps span.on{background:var(--pine)}
progress{width:100%;height:14px;accent-color:var(--pine)}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:12px 0}
.facts div{border:1px solid var(--line);border-radius:8px;padding:10px;background:var(--card)}.facts b{display:block;font-size:13px;color:var(--stone);font-weight:500}
.mono{font-family:"IBM Plex Mono",ui-monospace,monospace;word-break:break-all}
.snap{width:100%;border-radius:8px;border:1px solid var(--line);margin:8px 0}
.plans{display:grid;gap:10px}.plan{display:block;border:1px solid var(--line);border-radius:8px;padding:14px;margin:0;font-weight:400;cursor:pointer}
.plan input{margin-right:8px}.plan strong{font-weight:600}
details{border-top:1px solid var(--line);margin-top:16px;padding-top:10px}summary{cursor:pointer;color:var(--stone);font-size:14px}
details pre{white-space:pre-wrap;font:13px/1.5 "IBM Plex Mono",monospace;background:var(--pine05);padding:10px;border-radius:6px;overflow-x:auto}
.error{background:var(--badbg);color:var(--bad);border-radius:8px;padding:12px;margin:12px 0}
.note{background:var(--pine05);border-radius:8px;padding:12px;margin:12px 0;font-size:15px}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line)}.scroll{overflow-x:auto}
footer{max-width:44rem;margin:0 auto;padding:8px 16px 32px;font-size:13px;color:var(--stone)}
`;

export interface LayoutOptions {
  title: string;
  body: string;
  refreshSeconds?: number;
  wide?: boolean;
  script?: boolean;
  evidence?: boolean;
  nav?: string;
}

export function layout(o: LayoutOptions): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${o.refreshSeconds ? `<meta http-equiv="refresh" content="${o.refreshSeconds}">` : ""}<title>${esc(o.title)} · QoreWitness</title>
<link rel="icon" href="/favicon.svg"><style>${CSS}${o.wide ? "main,footer{max-width:60rem}" : ""}</style></head><body>
<header>${LOGO}<strong>QoreWitness</strong>${o.nav ?? ""}<span class="tag" title="Beta on the QoreChain test network, which can be reset. Free while we build out the service.">Beta · test network</span></header>
<main>${o.body}</main>
<footer>Free beta: we cover the network fees on the QoreChain test network. QoreWitness never asks for your passwords or files.</footer>
<script>${BOX_SCRIPT}</script>${o.evidence ? `<script>${EVIDENCE_SCRIPT}</script>` : ""}</body></html>`;
}

export const hidden = (name: string, value: string) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
