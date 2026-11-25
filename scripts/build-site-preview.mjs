#!/usr/bin/env node
// Builds the customer website pages (static HTML, no dependencies).
//
//   node scripts/build-site-preview.mjs          -> web/site-draft/*.html (noindex draft, not deployed, links to ../site/ for shared files)
//   node scripts/build-site-preview.mjs --live   -> web/site/*.html (indexable, REPLACES web/site/index.html), plus the
//     redirect stubs in web/site/preview/, sitemap.xml, robots.txt and verifier.html (copied from web/verifier/dist)
//
// Shared CSS and JS live in web/site/assets/. Fonts live in web/site/fonts/.
// Copy and facts are in this file. Edit here, then run the script again.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const live = process.argv.includes("--live");
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(repo, "web", "site");
const outDir = live ? root : join(repo, "web", "site-draft");
const UP = live ? "" : "../site/"; // prefix for files that live in web/site/ (verifier, demo, fonts, assets)
mkdirSync(outDir, { recursive: true });

const SITE = "https://qorewitness.fnoufnou.com";
const GH = "https://github.com/fnoufnou/qorewitness";
const GHDOC = (f) => `${GH}/blob/main/docs/${f}`;
const X = "https://x.com/fnoufnou";
const DISCORD = "https://discord.gg/qorechain";
// TODO lead: pin a release tag instead of main before launch.
const TAG = "v0.6.0-alpha.4"; // the release the install line runs; the "read the script" link points to the same tag
const INSTALL = `ssh -t USER@IP-ADDRESS "curl -fsSL https://raw.githubusercontent.com/fnoufnou/qorewitness/${TAG}/install.sh | bash -s -- --yes"`;
const VERIFIER_SHA = "01fb584fe02806b7335ebb44c0abc1fd0da48bc1387281707046e859a59bdae8";
const REGISTRY = "0xa1378D6558B32e1f8d37b68cf90e3C93839Da365";
// Sample record for QoreWitness Verify (24 Nov 2026): one clip of our test computer's stand-in camera
// (a test pattern with "QoreWitness test camera" and a burned-in clock in Amsterdam time, plus a test tone),
// window 08:00 to 08:10 CET.
// Server-only files: /sample-clip.mp4 and /sample-receipt.json. The old /demo-clip.mp4 links keep working.
const SAMPLE = { clip: "sample-clip.mp4", receipt: "sample-receipt.json", block: "10,653,907", sealed: "24 Nov 2026, 08:10 CET", recorded: "08:08 to 08:09 CET", within: "1 minute" };
const TESTS = 252; // automated tests (pnpm test), counted on 25 Nov 2026

/* ---------- icons and art ---------- */
const defs = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
<symbol id="logo" viewBox="0 0 64 64"><path d="M32 4.5H12Q7.5 4.5 7.5 9V29C7.5 44.5 17.5 55 32 60.5Z" fill="var(--lg-r,#17483A)" transform="matrix(-1 0 0 1 64 0)"/><path d="M32 4.5H12Q7.5 4.5 7.5 9V29C7.5 44.5 17.5 55 32 60.5Z" fill="var(--lg-l,#2F7D64)"/><path d="M15.5 23V16.5H22" fill="none" stroke="#FFFFFF" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.5 35V41.5H22" fill="none" stroke="#FFFFFF" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M42 41.5H48.5V35" fill="none" stroke="var(--lg-c,#D9EAE3)" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="46" cy="19" r="3.6" fill="var(--lg-d,#E8663D)"/><path d="M24.8 29.4L29.8 34.4L39.4 24.4" fill="none" stroke="#FFFFFF" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></symbol>
<symbol id="i-check-circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M7.5 12.3l3 3 6-6.3" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-x-circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></symbol>
<symbol id="i-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></symbol>
<symbol id="i-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></symbol>
<symbol id="i-image" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="8.5" cy="10" r="1.6"/><path d="M4 17l5-5 4 4 3-3 4 4"/></symbol>
<symbol id="i-finger" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6.5 18.5c1.2-1.8 1.8-4 1.8-6.5a3.7 3.7 0 0 1 7.4 0c0 1.2-.1 2.4-.4 3.5"/><path d="M12 12c0 3.5-.9 6.6-2.6 9"/><path d="M4.3 15.5c.5-1.1.7-2.3.7-3.5a7 7 0 0 1 12.6-4.2"/><path d="M19 11c.1.4.1.7.1 1 0 2.4-.4 4.6-1.2 6.6"/><path d="M15.2 18.8c-.3.9-.7 1.7-1.2 2.5"/></symbol>
<symbol id="i-layers" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/><path d="M3 17.5l9 5 9-5" opacity=".55"/></symbol>
<symbol id="i-sign" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l2 2M14.5 8.5l2 2"/></symbol>
<symbol id="i-chain" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="2.5" y="8" width="8" height="8" rx="2"/><rect x="13.5" y="8" width="8" height="8" rx="2"/><path d="M10.5 12h3"/></symbol>
<symbol id="i-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.4" fill="currentColor"/></symbol>
<symbol id="i-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></symbol>
<symbol id="i-scale" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M7 21h10M4 7h16"/><path d="M6.5 7L3.5 13a3 3 0 0 0 6 0z"/><path d="M17.5 7l-3 6a3 3 0 0 0 6 0z"/></symbol>
<symbol id="i-home" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3.5 11L12 4l8.5 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/></symbol>
<symbol id="i-doc" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/></symbol>
<symbol id="i-camera" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="11" rx="3"/><circle cx="12" cy="11.5" r="3"/><path d="M9 20.5h6M12 17v3.5"/></symbol>
<symbol id="i-box" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 12h4"/><circle cx="16.5" cy="12" r="1" fill="currentColor"/><path d="M7 20h10"/></symbol>
<symbol id="i-browser" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 9h18"/><path d="M7 6.8h.01M10 6.8h.01"/><path d="M8.5 14l2.5 2.5 4.5-4.5"/></symbol>
<symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 2.2l8.2 3.2v6.2c0 5.1-3.5 9.3-8.2 10.5-4.7-1.2-8.2-5.4-8.2-10.5V5.4z" fill="currentColor"/><path d="M12 2.2v19.9c-4.7-1.2-8.2-5.4-8.2-10.5V5.4z" fill="#fff" opacity=".14"/><path d="M8.1 12.1l2.7 2.7 5.1-5.3" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></symbol>
</defs></svg>`;
const ico = (id) => `<svg aria-hidden="true" focusable="false"><use href="#i-${id}"/></svg>`;

function sealPath(cx, cy, r, amp = 2.2, n = 16) {
  const pts = [];
  for (let i = 0; i <= 160; i++) {
    const t = (i / 160) * Math.PI * 2;
    const rr = r + amp * Math.sin(n * t);
    pts.push(`${(cx + rr * Math.cos(t)).toFixed(1)} ${(cy + rr * Math.sin(t)).toFixed(1)}`);
  }
  return `M${pts.join("L")}Z`;
}
/** A pine wax seal with the lens ring and the persimmon dot. */
function seal(cx, cy, r, o = {}) {
  const edge = o.bad ? "var(--bad)" : "var(--seal-edge)";
  const fill = o.bad ? "var(--bad-bg)" : "var(--seal)";
  const ring = o.bad ? "var(--bad)" : "#fff";
  return `<g>${o.pulse ? `<circle class="pulse" cx="${cx}" cy="${cy}" r="${r + 8}" fill="none" stroke="var(--signal)" stroke-width="3"/>` : ""}
<path d="${sealPath(cx, cy, r, r * 0.05, 16)}" fill="${fill}" stroke="${edge}" stroke-width="${Math.max(1.5, r * 0.05)}"/>
<circle cx="${cx}" cy="${cy}" r="${(r * 0.58).toFixed(1)}" fill="none" stroke="${ring}" stroke-width="${(r * 0.13).toFixed(1)}"/>
<circle cx="${cx}" cy="${cy}" r="${(r * 0.2).toFixed(1)}" fill="${ring}"/>
${o.bad ? `<path d="M${cx - r * 0.3} ${cy - r * 0.95} L${cx + r * 0.05} ${cy - r * 0.2} L${cx - r * 0.2} ${cy + r * 0.2} L${cx + r * 0.25} ${cy + r * 0.95}" fill="none" stroke="var(--bad)" stroke-width="${(r * 0.1).toFixed(1)}" stroke-linejoin="round"/>` : `<circle cx="${(cx + r * 0.74).toFixed(1)}" cy="${(cy - r * 0.74).toFixed(1)}" r="${(r * 0.17).toFixed(1)}" fill="var(--signal)" stroke="var(--bg)" stroke-width="${(r * 0.05).toFixed(1)}"/>`}</g>`;
}

const artSeal = `<svg viewBox="0 0 240 130" aria-hidden="true" focusable="false"><rect x="6" y="28" width="228" height="74" rx="6" fill="var(--strip)"/>${Array.from({ length: 9 }, (_, i) => `<rect x="${14 + i * 25}" y="33" width="10" height="6" rx="1.500" fill="var(--bg)"/><rect x="${14 + i * 25}" y="91" width="10" height="6" rx="1.500" fill="var(--bg)"/>`).join("")}<rect x="16" y="44" width="62" height="42" rx="4" fill="var(--frame)"/><rect x="88" y="44" width="62" height="42" rx="4" fill="var(--frame)"/><rect x="160" y="44" width="62" height="42" rx="4" fill="var(--frame)"/>${seal(119, 66, 30)}</svg>`;
const artKeep = `<svg viewBox="0 0 240 130" aria-hidden="true" focusable="false"><rect x="30" y="26" width="150" height="92" rx="8" fill="var(--bg)" stroke="var(--line)" stroke-width="2"/><path d="M30 34l75 52 75-52" fill="none" stroke="var(--line)" stroke-width="2"/>${seal(105, 80, 17)}<g transform="translate(176 54)"><circle r="30" fill="var(--bg)" stroke="var(--brand)" stroke-width="2.500"/><circle r="23" fill="none" stroke="var(--brand)" stroke-width="1" stroke-dasharray="3 3"/><text x="0" y="-3" text-anchor="middle" font-family="var(--mono)" font-size="10" fill="var(--fg)">02:20</text><text x="0" y="9" text-anchor="middle" font-family="var(--mono)" font-size="8" fill="var(--muted)">RECORD</text><path d="M-40 18c10 -6 18 6 28 0s18 6 28 0 18 6 28 0" fill="none" stroke="var(--signal)" stroke-width="2" stroke-linecap="round"/></g></svg>`;
const artProve = `<svg viewBox="0 0 240 130" aria-hidden="true" focusable="false"><rect x="10" y="22" width="96" height="86" rx="8" fill="none" stroke="var(--muted)" stroke-width="2" stroke-dasharray="6 5"/><path d="M58 44v28M46 60l12 12 12-12" fill="none" stroke="var(--brand)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><text x="58" y="94" text-anchor="middle" font-family="var(--mono)" font-size="9" fill="var(--muted)">DROP FILES</text><rect x="122" y="22" width="108" height="86" rx="8" fill="var(--bg)" stroke="var(--line)" stroke-width="2"/><path d="M122 30a8 8 0 0 1 8-8h92a8 8 0 0 1 8 8v26h-108z" fill="var(--ok-bg)"/><circle cx="141" cy="42" r="9" fill="var(--ok)"/><path d="M136.500 42.300l3 3 5.500-6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><rect x="156" y="35" width="62" height="5" rx="2.500" fill="var(--ok)"/><rect x="156" y="45" width="40" height="4" rx="2" fill="var(--muted)" opacity=".5"/>${[68, 80, 92].map((y) => `<circle cx="138" cy="${y}" r="3.500" fill="var(--ok)"/><rect x="148" y="${y - 2}" width="${y === 80 ? 54 : 70}" height="4" rx="2" fill="var(--muted)" opacity=".5"/>`).join("")}</svg>`;
const artTamper = `<svg viewBox="0 0 240 130" aria-hidden="true" focusable="false">${seal(120, 65, 46, { bad: true })}</svg>`;

/* ---------- hero composition ----------
 * Photo slots: web/site/assets/hero-frames.jpg (large frame), hero-frame-2.jpg and
 * hero-frame-3.jpg (small frames). They are img elements (width and height set). Until
 * the files load, a CSS gradient paints a night scene behind them.
 */
const shield = `<svg aria-hidden="true" focusable="false"><use href="#i-shield"/></svg>`;
const heroVisual = `<div class="hv" role="img" aria-label="Three frames from a home security camera, each with a seal badge. The main frame links to a verification report: Original. Recorded 22 Nov 2026, 02:14 CET. Sealed on the public ledger. Not modified since sealing.">
<div class="hv-frame f1"><img src="${UP}assets/hero-frames.jpg" width="1920" height="1072" alt="" fetchpriority="high" decoding="async"><span class="osd">CAM 1<span class="d"> · 22-11-2026</span> · 02:14:07</span><span class="rec"><i></i>REC</span></div>
<div class="hv-frame f2"><img src="${UP}assets/hero-frame-2.jpg" width="1280" height="714" alt="" loading="lazy" decoding="async"><span class="osd">CAM 2<span class="d"> · 02:14:12</span></span><span class="hv-badge sm">${shield}</span></div>
<div class="hv-frame f3"><img src="${UP}assets/hero-frame-3.jpg" width="1280" height="714" alt="" loading="lazy" decoding="async"><span class="osd">CAM 3<span class="d"> · 02:14:18</span></span><span class="hv-badge sm">${shield}</span></div>
<div class="hv-report">
<span class="hv-badge lg">${shield}</span>
<div class="hv-head"><b>Original</b><span>Checked with QoreWitness Verify</span></div>
<dl>
<div><dt>Recorded</dt><dd>22 Nov 2026, 02:14 CET</dd></div>
<div class="ok"><dt>Sealed on the public ledger</dt><dd>${ico("check")}</dd></div>
<div class="ok"><dt>Not modified since sealing</dt><dd>${ico("check")}</dd></div>
</dl>
<div class="hv-fp"><span>Fingerprint</span><code>3f9a 71c2 · · · 8d40 e04b</code></div>
</div>
</div>`;

/* ---------- shared parts ---------- */
const NAV = [
  ["how-it-works.html", "How it works"],
  ["get-started.html", "Get started"],
  ["cameras.html", "Cameras"],
  ["prove.html", "Prove a video"],
  ["plans.html", "Plans"],
  ["faq.html", "FAQ"],
];
// After a thin divider, in a muted colour: pages for builders and the contest jury.
const NAV2 = [
  ["developers.html", "Developers"],
  ["jury.html", "For the jury"],
];

// The only beta wording outside Trust, Developers, the jury page, Plans and one FAQ line.
const betaBar = `<aside class="beta-bar" aria-label="Beta notice"><div class="wrap"><p><b>QoreWitness is in beta.</b> It runs on the QoreChain test network, which can be reset, and you can use it free of charge while we build out the service. <a href="trust.html#beta">Learn more</a></p></div></aside>`;

function header(current) {
  const link = ([h, t], cls = "") => `<li${cls ? ` class="${cls}"` : ""}><a href="${h}"${h === current ? ' aria-current="page"' : ""}>${t}</a></li>`;
  return `<a class="skip" href="#main">Skip to content</a>
${betaBar}
<header class="site-header"><div class="wrap bar">
<a class="brand" href="index.html"><svg aria-hidden="true" focusable="false"><use href="#logo"/></svg>QoreWitness<span class="sr"> home</span></a>
<button class="menu-btn" type="button" aria-expanded="false" aria-controls="site-nav" hidden><span class="burger" aria-hidden="true"><i></i><i></i><i></i></span>Menu</button>
<nav class="nav" id="site-nav" aria-label="Main"><ul>${NAV.map((n) => link(n)).join("")}${NAV2.map((n, i) => link(n, i === 0 ? "sec first" : "sec")).join("")}<li class="nav-cta"><a class="btn primary" href="get-started.html">Set up your camera</a></li></ul></nav>
<a class="btn primary sm cta" href="get-started.html">Set up your camera</a>
</div></header>`;
}

/* ---------- section edges ----------
 * Decorative soft waves between sections, all in the style of the wave between "The app"
 * and "What you need". They are SVG symbols drawn in the colour of the next section
 * through currentColor, so they follow light and dark mode. Variants differ in direction,
 * amplitude and phase so a page never repeats the same edge twice in a row. The hero and
 * the footer get a second, faint line behind the wave for depth. All are aria-hidden.
 */
const WAVE_A = '<path fill="currentColor" opacity=".45" d="M0 30C180 6 360 6 560 22S920 44 1120 26 1360 8 1440 14V48H0Z"/><path fill="currentColor" d="M0 38C220 18 420 18 640 32S1000 48 1200 34 1380 22 1440 26V48H0Z"/>';
const WAVE_C = '<path fill="currentColor" opacity=".4" d="M0 20C260 42 520 42 760 26S1160 4 1440 22V48H0Z"/><path fill="currentColor" d="M0 32C200 46 460 48 700 36S1100 18 1440 32V48H0Z"/>';
const LINE = (d) => `<path fill="none" stroke="var(--wave-line)" stroke-width="1.5" stroke-linecap="round" opacity=".5" d="${d}"/>`;
const sym = (id, inner, flip = false) => `<symbol id="edge-${id}" viewBox="0 0 1440 48">${flip ? `<g transform="matrix(-1 0 0 1 1440 0)">${inner}</g>` : inner}</symbol>`;
const edgeDefs = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>${[
  sym("a", WAVE_A),
  sym("b", WAVE_A, true),
  sym("c", WAVE_C),
  sym("d", WAVE_C, true),
  sym("hero", LINE("M0 20C200 0 420 2 620 14S980 36 1180 20 1390 4 1440 8") + '<path fill="currentColor" opacity=".35" d="M0 26C200 8 400 8 600 20S980 44 1200 28 1380 14 1440 18V48H0Z"/><path fill="currentColor" d="M0 36C240 16 440 18 660 30S1020 46 1220 32 1390 22 1440 24V48H0Z"/>'),
  sym("foot", LINE("M0 14C220 34 440 32 660 20S1040 2 1240 18 1400 30 1440 26") + '<path fill="currentColor" opacity=".35" d="M0 22C220 40 420 38 660 26S1040 8 1240 24 1400 36 1440 32V48H0Z"/><path fill="currentColor" d="M0 34C200 46 460 46 700 36S1100 20 1440 34V48H0Z"/>'),
].join("")}</defs></svg>`;
let edgeCount = 0;
/** An edge at the bottom of a section. kind: wave (rotates through four variants), hero or foot. to: the next section (bg, alt, foot). */
const edge = (kind, to) => {
  const v = kind === "wave" ? "abcd"[edgeCount++ % 4] : kind;
  return `<div class="edge t-${to}" aria-hidden="true"><svg viewBox="0 0 1440 48" preserveAspectRatio="xMidYMax slice" focusable="false"><use href="#edge-${v}"/></svg></div>`;
};

const LICENSE = `${GH}/blob/main/LICENSE`;
const footer = `<footer class="site-footer">${edge("foot", "foot")}<div class="wrap">
<div class="cols">
<div><a class="brand" href="index.html"><svg aria-hidden="true" focusable="false"><use href="#logo"/></svg>QoreWitness</a>
<p>Your camera footage, sealed as it is recorded and ready to prove whenever you need it.</p>
<p><b>QoreWitness will never ask for your passwords or files.</b></p></div>
<nav aria-label="Product"><h2>Product</h2><ul><li><a href="how-it-works.html">How it works</a></li><li><a href="get-started.html">Set up your camera</a></li><li><a href="cameras.html">Cameras</a></li><li><a href="daily-use.html">Daily use</a></li><li><a href="prove.html">Prove a video</a></li><li><a href="plans.html">Plans</a></li></ul></nav>
<nav aria-label="Trust"><h2>Trust</h2><ul><li><a href="trust.html">Trust and limits</a></li><li><a href="faq.html">FAQ</a></li><li><a href="developers.html">Developers</a></li><li><a href="jury.html">For the jury</a></li></ul></nav>
<nav aria-label="Open"><h2>Open</h2><ul><li><a href="${UP}verifier.html">QoreWitness Verify</a></li><li><a href="${GH}">GitHub</a></li><li><a href="${X}">@fnoufnou on X</a></li><li><a href="${DISCORD}">QoreChain Discord</a></li></ul></nav>
</div>
<div class="legal"><p>© 2026 fnoufnou. QoreWitness is open source under the <a href="${LICENSE}">Apache License 2.0</a>.</p><p>QoreChain, TP-Link, Tapo and other names are trademarks of their respective owners. <a href="trust.html">Trust and limits</a></p></div>
</div></footer>`;

const PAGES = [];
function page({ file, title, desc, body, current }) {
  const robots = live ? "" : `<meta name="robots" content="noindex">\n`;
  const url = file === "index.html" ? `${SITE}/` : `${SITE}/${file}`;
  PAGES.push(file);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="description" content="${desc}">
${robots}<meta name="theme-color" content="#17483A">
<meta name="color-scheme" content="light dark">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="QoreWitness">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${SITE}/qorewitness-featured.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${SITE}/qorewitness-featured.png">
<link rel="icon" href="${UP}favicon.svg" type="image/svg+xml">
<link rel="preload" href="${UP}fonts/plex-sans.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${UP}assets/site.css">
<script>document.documentElement.classList.add("js")</script>
</head>
<body>
${defs}
${edgeDefs}
${header(current)}
<main id="main">
${body}
</main>
${footer}
<script src="${UP}assets/site.js" defer></script>
</body>
</html>
`;
  // Wide tables scroll sideways on small screens: give each one a name and a keyboard stop (site.js drops the stop when it fits).
  const named = html.replace(/<div class="tablewrap">(<table[\s\S]*?<\/table>)/g, (_, t) => {
    const cap = /<caption[^>]*>([^<]+)<\/caption>/.exec(t)?.[1];
    const cols = [...t.matchAll(/<th scope="col">([^<]*)<\/th>/g)].map((m) => m[1]).filter(Boolean).join(", ");
    return `<div class="tablewrap" role="region" aria-label="${cap ?? `Table: ${cols}`}" tabindex="0">${t}`;
  });
  writeFileSync(join(outDir, file), named);
  console.log("wrote", join(live ? "web/site" : "web/site-draft", file));
}

/* ---------- real app screens in device frames ----------
 * The images in assets/screens/ are screenshots of the real QoreWitness app
 * (src/web), rendered from a local ui server with the chain, the camera and the fee
 * sponsor mocked. Phone shots are 390 x 844 at 2x, desktop shots 1280 x 800 at 2x.
 */
const SCR = `${UP}assets/screens/`;
const ALT = {
  pair: "QoreWitness setup on a phone: Set up QoreWitness, with a field for the 6-digit pairing code and a Continue button.",
  password: "QoreWitness setup on a phone: Choose a password for QoreWitness, with a Show password option and a Save password button.",
  camera: "QoreWitness setup on a phone: Connect your camera. Two cameras found on the network, the brand TP-Link Tapo picked, the camera account filled in and a Test camera button.",
  picture: "QoreWitness setup on a phone: Is this your camera?, with a picture of a back garden from the camera and the buttons Yes, this is my camera and Try again.",
  progress: "QoreWitness setup on a phone: Connecting your camera, with a progress bar and the note that you can close the page.",
  done: "QoreWitness setup on a phone: Sealing started, with the dashboard address and an Open my dashboard button.",
  dashPhone: "QoreWitness dashboard on a phone: Sealing OK in green, four short facts and the latest seals, each with a Download button.",
  evidence: "QoreWitness dashboard on a phone: Save evidence, with a date, a start and an end time, and the buttons Check this time and Last hour.",
  dashDesk: "QoreWitness dashboard in a browser: Sealing OK in green, camera online, network fees covered in the free beta, and the latest seals with a Download button each.",
  verifyPhone: "QoreWitness Verify on a phone, after checking a sealed clip with its receipt: the green result Original, with what it proves and what it cannot prove.",
  verifyDesk: "QoreWitness Verify in a browser with a sealed clip and its receipt chosen, and the green result Original.",
  states: "Three status lines from the QoreWitness dashboard: green Sealing OK, orange Waiting for the first seal, and red No video from the camera, with what to do.",
};
const phone = (file, alt, cap = "", o = {}) => `<figure class="shot${o.cls ? ` ${o.cls}` : ""}"><div class="device phone"><img src="${SCR}${file}.webp" width="780" height="1688" alt="${alt}" loading="lazy" decoding="async"></div>${cap ? `<figcaption>${cap}</figcaption>` : ""}</figure>`;
const browser = (file, alt, address, cap = "", o = {}) => `<figure class="shot${o.cls ? ` ${o.cls}` : ""}"><div class="device browser"><div class="chrome" aria-hidden="true"><i></i><i></i><i></i><span>${address}</span></div><img src="${SCR}${file}.webp" width="${o.w ?? 2560}" height="${o.h ?? 1600}" alt="${alt}" loading="lazy" decoding="async"></div>${cap ? `<figcaption>${cap}</figcaption>` : ""}</figure>`;
/** A row of phone screens. On a phone it scrolls sideways, on a wide screen it is a grid. */
const screens = (label, items, lg = false) => `<div class="screens${lg ? " lg" : ""}" role="region" aria-label="${label}" tabindex="0"><ol>${items.map(([f, alt, cap]) => `<li>${phone(f, alt, cap)}</li>`).join("")}</ol></div>`;
/** The last lines the installer prints, as text in a terminal frame (from install.sh). */
const terminal = `<figure class="shot"><div class="device term"><div class="chrome" aria-hidden="true"><i></i><i></i><i></i><span>Terminal</span></div><pre tabindex="0" aria-label="The end of the installer output"><span class="dim">Starting QoreWitness</span>
<span class="dim"> ✔ Container qorewitness-agent  Started</span>
<span class="dim"> ✔ Container qorewitness-ui     Started</span>

<b>QoreWitness is ready. On your phone or laptop, open:</b>

<b class="hl">      http://192.168.1.42:8080</b>

<b class="hl">      Pairing code:  482 913</b>

Or click this link: http://192.168.1.42:8080/setup?token=…</pre></div></figure>`;
const help = (title, inner, id = "") => `<details class="help"${id ? ` id="${id}"` : ""}><summary>${title}</summary><div class="in">${inner}</div></details>`;
const copybox = (id, text, label = "Copy") => `<div class="copybox"><code id="${id}" tabindex="0">${text}</code><button class="btn" type="button" data-copy="${id}" aria-label="${label}: ${id === "install-cmd" ? "the install line" : "the text"}">${ico("copy")}<span>${label}</span></button></div>`;
const head = (eyebrow, h1, lead, meta = []) => `<div class="page-head"><div class="wrap narrow-wrap"><p class="eyebrow">${eyebrow}</p><h1>${h1}</h1><p class="lead">${lead}</p>${meta.length ? `<ul class="meta">${meta.map((m) => `<li>${m}</li>`).join("")}</ul>` : ""}</div>${edge("wave", "bg")}</div>`;
const closing = (h, p, href, label) => `<div class="band"><div class="wrap"><div><h2>${h}</h2><p>${p}</p></div><a class="btn primary" href="${href}">${label} ${ico("arrow")}</a></div></div>`;
const VERIFY = `<a href="${UP}verifier.html">QoreWitness Verify</a>`;
/** The result of QoreWitness Verify for the published sample record, in its own words. */
const cert = (tag) => `<div class="cert" role="group" aria-label="${tag} from QoreWitness Verify"><span class="tag">${tag}</span>
<div class="head">${ico("check-circle")}<div><b>Original</b><span>This video is unchanged since it was recorded on 24 Nov 2026, ${SAMPLE.recorded.replace(" CET", "")} (CET, your time). Sealed within ${SAMPLE.within}.</span></div></div>
<ul>
<li><span>${ico("check")}The file is exactly the one the camera's QoreWitness recorded, down to the last byte</span></li>
<li><span>${ico("check")}Its fingerprint is on the public ledger, signed by the camera</span></li>
</ul><div class="foot">Sample record, sealed in block ${SAMPLE.block}</div></div>`;
const techNames = (inner) => `<details class="tech"><summary><span>Technical names<small>The full technical detail is on the <span class="u">Developers</span> page.</small></span></summary><div class="in">${inner}<p class="small" style="margin:0"><a href="developers.html">Read the full technical detail for developers</a></p></div></details>`;
const pill = (kind, text) => `<span class="pill ${kind}"><i></i>${text}</span>`;

/* ---------- hardware facts (lead, 22 Nov) ---------- */
const hwTable = `<div class="tablewrap"><table class="stack"><caption class="sr">Minimum and recommended hardware</caption><thead><tr><th scope="col"><span class="sr">Part</span></th><th scope="col">Minimum</th><th scope="col">Recommended</th></tr></thead><tbody>
<tr><th scope="row">Processor</th><td data-label="Minimum">2 cores, 64-bit (x86-64 or ARM64)</td><td data-label="Recommended">4 cores</td></tr>
<tr><th scope="row">Memory</th><td data-label="Minimum">2 GB</td><td data-label="Recommended">4 GB</td></tr>
<tr><th scope="row">Storage</th><td data-label="Minimum">Enough for the days of video you want to keep</td><td data-label="Recommended">A 500 GB SSD for one or two cameras</td></tr>
<tr><th scope="row">Raspberry Pi</th><td data-label="Minimum">Raspberry Pi 4 (4 GB) with a USB SSD</td><td data-label="Recommended">Raspberry Pi 5 (4 or 8 GB) with a USB SSD</td></tr>
<tr><th scope="row">System</th><td colspan="2" data-label="Minimum and recommended">64-bit Linux with Docker, or any system that runs Docker</td></tr>
</tbody></table></div>`;

/* ---------- camera brand hints ---------- */
const BRANDS = [
  ["TP-Link Tapo (wired models, such as the C210)", `<div><ol class="plain"><li>In the Tapo app, tap your camera, then the gear icon.</li><li>Open <b>Advanced Settings</b>, then <b>Camera Account</b>, and agree to the notice.</li><li>Choose a name and a password of 6 to 32 characters each. Letters and digits work best.</li></ol><p>Stream address: <code>rtsp://NAME:PASSWORD@ADDRESS:554/stream1</code>. Tapo Care, a microSD card and a recorder such as QoreWitness can only run two at a time, so switch one off if all three are on.</p></div>`],
  ["Reolink (wired and PoE models)", `<div><p>In the Reolink app or desktop client, open the camera settings, then <b>Network</b>, <b>Advanced</b> and <b>Server Settings</b> (on some models <b>Port Settings</b>), and switch on <b>RTSP</b>. Use the camera's own login.</p><p>Stream address on most models: <code>rtsp://NAME:PASSWORD@ADDRESS:554/h264Preview_01_main</code>.</p></div>`],
  ["Hikvision and Annke", `<p>RTSP is usually on already. Open the camera in your browser and check <b>Configuration</b>, <b>Network</b>, <b>Advanced Settings</b>. To use ONVIF, switch it on under <b>Integration Protocol</b> and add an ONVIF user.</p><p>Stream address on most models: <code>rtsp://NAME:PASSWORD@ADDRESS:554/Streaming/Channels/101</code>.</p>`],
  ["Dahua and Amcrest", `<p>RTSP is usually on already. You can check it in the camera's web page under the network settings, where you can also switch on ONVIF.</p><p>Stream address on most models: <code>rtsp://NAME:PASSWORD@ADDRESS:554/cam/realmonitor?channel=1&amp;subtype=0</code>.</p>`],
  ["Ubiquiti UniFi Protect", `<p>In UniFi Protect, open the camera, go to its settings and switch on an <b>RTSP</b> stream under the advanced options. Protect then shows a ready-made stream link. Copy it and keep it for the setup.</p>`],
  ["Axis", `<p>Axis cameras offer RTSP as standard. Create a user for QoreWitness in the camera's web page, under the system or account settings.</p><p>Stream address on most models: <code>rtsp://NAME:PASSWORD@ADDRESS/axis-media/media.amp</code>.</p>`],
  ["Any other ONVIF camera", `<p>Switch on ONVIF in the camera settings and create an ONVIF user if the camera asks for one. To find the exact stream address, search for your model together with the words "RTSP URL".</p>`],
];
const brandHints = BRANDS.map(([b, inner]) => help(b, inner)).join("");

/* ---------- FAQ ---------- */
const FAQ = [
  ["Does my video leave my home?", `<p>No. Your recordings stay on your own computer at home. QoreWitness creates a digital fingerprint of your video stream and keeps that, and only that, on a public record. A fingerprint reveals nothing about what is in the picture or the sound.</p>`],
  ["Which cameras work?", `<p>Any camera that can share its video stream on your home network over RTSP or ONVIF, which many wired home cameras can. Battery cameras and cameras that only stream to their maker's cloud cannot, because they never offer that stream. See the <a href="cameras.html">camera list</a>, and learn how to check your own camera in two minutes.</p><p>We have no partnership with any camera maker.</p>`],
  ["What does QoreWitness run on?", `<p>On an always-on computer at home: a Raspberry Pi 4 or 5, a mini PC, a home server or a NAS. It runs anywhere Docker runs. See <a href="get-started.html#need">What you need</a> for the minimum and recommended hardware.</p>`],
  ["Do I need to know anything about crypto?", `<p>Not at all. QoreWitness uses a public ledger as an independent notary, and that is the only part it plays. You never buy, hold or trade anything: during the beta we cover the network fees for you, and after launch the Hands-off plan does the same.</p>`],
  ["What does it cost?", `<p>Nothing during the beta. QoreWitness is free, and we cover the network fees on the test network, so you need no wallet at all.</p><p>When QoreWitness launches on the QoreChain main network, the Free plan has no subscription, and the small network fees come from your own wallet. If you would rather not think about fees, you can choose Hands-off for USD 10 or EUR 9 per camera per month. See <a href="plans.html">Plans</a>, and rest assured that we will never charge you without asking first.</p>`],
  ["What if my internet goes down?", `<p>Your camera and QoreWitness keep recording. Footage from while the connection was down may have no seal, and the public record shows that gap openly, with its start and its length.</p><p>Nobody can fill the gap later with a backdated seal.</p>`],
  ["Will the police or a court accept it?", `<p>A seal gives your footage strong, independent support that anyone can check. A court decides for itself how much weight to give it, just as with other evidence, and QoreWitness is not an EU qualified time stamp service. For a specific case, ask a lawyer.</p>`],
  ["What if my QoreWitness computer breaks?", `<p>Your seals live on the public ledger, independent of your computer. During the beta, seals live on the QoreChain test network, which can be reset. <a href="trust.html#beta">What the beta means for you</a>. To prove a clip you also need the clip itself, so press <b>Save evidence</b> in the dashboard for anything that matters to you and keep that file somewhere safe.</p>`],
  ["Can QoreWitness show that the scene was real?", `<p>No. It proves that the file has not changed since it was sealed. A staged scene or a fake stream would be sealed in exactly the same way.</p>`],
  ["Can someone fake a clip from inside my home network?", `<p>It is hard, but possible for someone who already controls your QoreWitness computer or your camera, because they could feed it fake footage before it is sealed.</p><p>Keep the computer and the camera on a network you trust, and use strong passwords. There is more on <a href="trust.html">Trust and limits</a>.</p>`],
  ["Does QoreWitness record sound?", `<p>Yes, whenever your camera's microphone is switched on, QoreWitness keeps the sound together with the picture and seals both in the same fingerprint, so a clip with sound is just as easy to prove. Would you rather keep only the picture? Simply switch the microphone off in your camera's app and QoreWitness follows your choice.</p><p>Sound travels further than you might expect, so please point your camera at your own home and garden, let visitors know with a small sign that you record picture and sound, and read the advice of your national data protection authority on cameras at home (in the Netherlands, the <a href="https://www.autoriteitpersoonsgegevens.nl">Autoriteit Persoonsgegevens</a>).</p>`],
  ["Who can see my recordings?", `<p>Only you, on your own computer. A receipt shows fingerprints and times, and nothing of the picture or the sound.</p>`],
  ["How long are my recordings kept?", `<p>QoreWitness keeps about two weeks of video, depending on your disk, and your seals live on the public ledger, independent of your computer. During the beta, seals live on the QoreChain test network, which can be reset. <a href="trust.html#beta">What the beta means for you</a>. Press <b>Save evidence</b> for any clip you may need later, before it is cleared to make room.</p>`],
];
const faqItems = (list) => `<div class="faq">${list.map(([q, a]) => `<details><summary>${q}</summary><div class="in">${a}</div></details>`).join("")}</div>`;

/* ================= HOME ================= */
page({
  file: "index.html",
  current: "index.html",
  title: "QoreWitness: video evidence you can trust again",
  desc: "QoreWitness seals your home camera footage as it is recorded, so you can always prove it has not been tampered with. Your videos never leave your home.",
  body: `
<div class="hero"><div class="wrap">
<div>
<p class="eyebrow">Sealed video for home cameras</p>
<h1>Video evidence you can trust again.</h1>
<p class="lead">QoreWitness seals your camera footage as it is recorded, so you can always prove it has not been tampered with. It all happens locally, and your videos never leave your home.</p>
<div class="btns"><a class="btn primary" href="get-started.html">Set up your camera ${ico("arrow")}</a><a class="btn" href="how-it-works.html">See how it works</a></div>
<p class="fine">Works with cameras that offer an RTSP or ONVIF stream. <a href="cameras.html">Check yours</a>.</p>
</div>
${heroVisual}
</div>${edge("hero", "bg")}</div>

<section class="edged"><div class="wrap">
<div class="sec-head"><p class="eyebrow">Why it matters</p><h2>When any video can be faked, yours deserves proof.</h2>
<p>Until recently, video evidence was enough to prove what really happened. With AI video manipulation, that trust is eroding fast. QoreWitness restores it by pinning every video to the time it was recorded and proving that not a single pixel has changed since.</p></div>
<ul class="grid c3">
<li class="tile top"><div class="ic">${ico("scale")}</div><h3>Be believed</h3><p>After a break-in, a dispute or an accident, you can show an insurer, a lawyer or a neighbour that your footage is the untouched original.</p></li>
<li class="tile top"><div class="ic">${ico("lock")}</div><h3>Keep your privacy</h3><p>Your video stays at home. QoreWitness creates a digital fingerprint of your video stream and keeps that, and only that, on a public record.</p></li>
<li class="tile top"><div class="ic">${ico("eye")}</div><h3>Let anyone check</h3><p>Whoever receives your video can confirm the seal online with ${VERIFY}, in seconds, without an account and without having to take our word for it.</p></li>
</ul>
</div>${edge("wave", "alt")}</section>

<section class="alt edged" id="how"><div class="wrap">
<div class="sec-head"><p class="eyebrow">How it works</p><h2>Seal, keep, prove.</h2></div>
<ol class="grid c3" style="list-style:none;padding:0;margin:0">
<li class="tile"><div class="art">${artSeal}</div><h3>1. Seal</h3><p>As your camera records, QoreWitness builds a chain of digital fingerprints and stores them on a public ledger. Change a single pixel of the original video later and the seal breaks.</p></li>
<li class="tile"><div class="art">${artKeep}</div><h3>2. Keep</h3><p>Your recordings stay safely on your own computer at home, together with the seals that belong to them. Nothing changes in how you use your camera.</p></li>
<li class="tile"><div class="art">${artProve}</div><h3>3. Prove</h3><p>If you ever need to provide video evidence, just share the clip with its QoreWitness seal. Anyone can verify it online and see a clear green result.</p></li>
</ol>
<p class="small" style="margin-top:20px"><a href="how-it-works.html">Read how it works</a></p>
</div>${edge("wave", "bg")}</section>

<section class="edged" id="app"><div class="wrap">
<div class="sec-head"><p class="eyebrow">The app</p><h2>Simple from the very first screen.</h2>
<p>QoreWitness finds the cameras on your network, shows you a picture so you know you picked the right one, and then gets to work. After that, one glance at your dashboard tells you that all is well, and every recording is one tap away from a sealed copy.</p></div>
${screens("The QoreWitness app on a phone, three screens", [
  ["setup-camera", ALT.camera, "Pick your camera"],
  ["setup-picture", ALT.picture, "Confirm its picture"],
  ["dashboard-phone", ALT.dashPhone, "Check your dashboard"],
], true)}
<p class="small" style="margin-top:20px"><a href="get-started.html#s4">See every step of the setup</a></p>
</div>${edge("wave", "alt")}</section>

<section class="alt"><div class="wrap">
<div class="sec-head"><p class="eyebrow">What you need</p><h2>Your camera, a computer that stays on, and a browser.</h2>
<p>QoreWitness runs quietly on a small computer at home, and setting it up takes about an hour. You paste one line, and everything after that happens in your browser.</p></div>
<ul class="grid c3">
<li class="tile"><div class="ic">${ico("camera")}</div><h3>A compatible camera</h3><p>Any camera that shares an RTSP or ONVIF video stream on your home network. <a href="cameras.html">See the camera list</a>.</p></li>
<li class="tile"><div class="ic">${ico("box")}</div><h3>An always-on computer</h3><p>A Raspberry Pi 5 with a USB SSD, a mini PC, a home server or a NAS. It runs anywhere Docker runs.</p></li>
<li class="tile"><div class="ic">${ico("browser")}</div><h3>Any browser</h3><p>For the setup, for your dashboard, and for checking a video with QoreWitness Verify.</p></li>
</ul>
<div class="btns" style="margin-top:28px"><a class="btn primary" href="get-started.html">Set up your camera ${ico("arrow")}</a><a class="btn" href="get-started.html#need">Full hardware list</a></div>
</div></section>

<section id="open"><div class="wrap split">
<div class="sec-head"><p class="eyebrow">Built in the open</p><h2>Proof you can check, from people who show their work.</h2>
<p>QoreWitness is open source, and every seal can be checked without trusting us. Our own home camera has been sealing its footage around the clock since 9 November 2026. <a href="trust.html">See the facts and the limits</a>.</p></div>
<div class="panel"><h3>What a seal proves, and what it cannot</h3>
<ul class="limits">
<li>A seal proves when a video existed and that it has not changed since it was sealed. It cannot prove that the scene itself was real.</li>
<li>A court decides for itself how much weight to give it, as with any evidence.</li>
</ul></div>
</div></section>
${closing("Give your footage the proof it deserves.", "Setup takes about an hour, and from then on QoreWitness simply keeps going.", "get-started.html", "Set up your camera")}`,
});

/* ================= HOW IT WORKS ================= */
page({
  file: "how-it-works.html",
  current: "how-it-works.html",
  title: "How it works | QoreWitness",
  desc: "How QoreWitness seals your camera footage as it is recorded: fingerprint, bundle, seal and record, while your video stays at home.",
  body: `
${head("How it works", "Your camera, now a witness.", "As your camera records, QoreWitness quietly builds a chain of digital fingerprints and pins them to a public ledger. Here is what happens, in plain words.")}
<section class="edged"><div class="wrap narrow">
<h2>Your video stays at home.</h2>
<p style="margin-top:16px">Your recordings never leave your own computer. QoreWitness creates a digital fingerprint of your video stream and keeps that, and only that, on a public record, together with the time and a seal. A fingerprint cannot be turned back into a picture or a sound.</p>
<div class="callout"><b class="t">Think of a sealed letter</b>You press a wax seal on a letter, keep the letter somewhere safe, and the postmark shows when it was sent. Anyone can inspect the seal and the postmark. QoreWitness does the same for video, with a digital seal and a public ledger as the postmark.</div>
</div>${edge("wave", "alt")}</section>

<section class="alt edged"><div class="wrap">
<div class="sec-head"><p class="eyebrow">Four steps</p><h2>Fingerprint, bundle, seal, record.</h2>
<p>All of this runs by itself in the background, for as long as your camera records.</p></div>
<ol class="grid c4" style="list-style:none;padding:0;margin:0">
<li class="tile"><div class="ic">${ico("finger")}</div><div class="num">01</div><h3>Fingerprint</h3><p>QoreWitness cuts the video stream into short clips and gives each one a unique digital fingerprint. Change a single pixel and the fingerprint changes completely.</p></li>
<li class="tile"><div class="ic">${ico("layers")}</div><div class="num">02</div><h3>Bundle</h3><p>At regular intervals it bundles the fingerprints into one compact summary, and links each clip to the one before it, so no clip can be removed or slipped in unnoticed.</p></li>
<li class="tile"><div class="ic">${ico("sign")}</div><div class="num">03</div><h3>Seal</h3><p>Each camera gets its own digital seal, built to withstand the quantum computers of the future, and signs every summary with it.</p></li>
<li class="tile"><div class="ic">${ico("chain")}</div><div class="num">04</div><h3>Record</h3><p>The public ledger checks the seal before it accepts the summary and its time. A small receipt stays with your recordings at home.</p></li>
</ol>
</div>${edge("wave", "bg")}</section>

<section><div class="wrap">
<div class="sec-head"><p class="eyebrow">The picture</p><h2>What goes where.</h2></div>
<ol class="flow">
<li class="home"><span class="tag">Stays at home</span><h3>Your camera</h3><p>Any camera with an RTSP or ONVIF stream.</p></li>
<li class="home"><span class="tag">Stays at home</span><h3>Your computer</h3><p>Records the clips, creates the seals and keeps both safe.</p></li>
<li><h3>Public ledger</h3><p>Checks each seal and stores the summary with its time. It holds no video.</p></li>
<li><h3>QoreWitness Verify</h3><p>Takes your evidence file and repeats every check in the browser.</p></li>
</ol>
</div></section>

<section class="alt"><div class="wrap split">
<div><h2>What it cannot do</h2>
<ul class="limits" style="margin-top:16px">
<li>It cannot prove that the scene was real. A staged scene is sealed in exactly the same way.</li>
<li>It cannot see what happens to the video before it is sealed, so keep your camera and your QoreWitness computer safe.</li>
<li>It is not an EU qualified time stamp, and a court decides for itself how much weight to give it.</li>
</ul><p class="small"><a href="trust.html">Read Trust and limits</a></p></div>
<div>
${techNames(`<ul class="plain">
<li>Fingerprints: SHA-256 and SHA3-256, two independent hash functions.</li>
<li>The summary: a Merkle root of the fingerprints in one time window.</li>
<li>The seal: an ML-DSA-87 signature (NIST FIPS 204) made with the camera key. Common signatures such as ECDSA and RSA may break once large quantum computers exist.</li>
<li>The public ledger: the AnchorRegistry smart contract on QoreChain. It checks the signature on chain before it stores the summary.</li>
</ul>`)}
</div>
</div></section>
${closing("Ready to seal your footage?", "Setup takes about an hour, and you only do it once.", "get-started.html", "Set up your camera")}`,
});

/* ================= GET STARTED ================= */
const railItems = [
  ["need", "What you need"],
  ["s1", "Check your camera"],
  ["s2", "Prepare your camera"],
  ["s3", "Install QoreWitness"],
  ["s4", "Open the setup"],
  ["s5", "Done"],
];
const COMPOSE_URL = `https://raw.githubusercontent.com/fnoufnou/qorewitness/${TAG}/docker-compose.yml`;
const ROUTER_IP = `Find the IP address of that computer in your router app, in the list of connected devices. It looks like <code>192.168.1.42</code>.`;
/** One choice in "Where will QoreWitness run?". The radio buttons show one install path (CSS :has). */
const whereOpt = (id, title, sub) => `<label class="where-opt" for="w-${id}"><input type="radio" name="where" id="w-${id}" value="${id}"><span><b>${title}</b><small>${sub}</small></span></label>`;
const pathLinux = `<div class="path-panel" id="path-linux"><h4>Raspberry Pi or Linux computer</h4><ol class="plain path-steps">
<li><b>New Raspberry Pi?</b> Install <a href="https://www.raspberrypi.com/software/">Raspberry Pi Imager</a> on your laptop and choose <b>Raspberry Pi OS Lite (64-bit)</b>. In its settings, choose a user name and password, enter your Wi-Fi (or use a cable) and switch on <b>SSH</b>. Write the card or SSD, connect it to the Pi and start it. Skip this if your computer already runs Linux.</li>
<li>${ROUTER_IP}</li>
<li>Open a terminal on your laptop. On a Mac, press Cmd and Space, type <b>Terminal</b> and press Enter. On Windows, press the Windows key, type <b>PowerShell</b> and press Enter.</li>
<li>Paste this line. Replace <code>USER</code> with the user name of that computer and <code>IP-ADDRESS</code> with its IP address. Press Enter.
${copybox("install-cmd", INSTALL, "Copy line")}</li>
<li>The first time, your laptop asks whether it may trust the computer. Type <code>yes</code>, then enter that computer's password. At the end, the installer shows a <b>link</b> and a <b>pairing code</b>.
${terminal}</li>
</ol>
${help("Something not working?", `<ul class="plain"><li><b>Connection refused or timed out.</b> Check the IP address in your router app and that SSH is on.</li><li><b>Permission denied.</b> Check the user name and password of the computer.</li><li><b>Already working on that computer itself?</b> Paste only the part between the quotes.</li><li><b>Keep the pairing code to yourself.</b> Anyone with it can set up QoreWitness until you choose a password.</li><li>Want to read the script first? It is on <a href="${GH}/blob/${TAG}/install.sh">GitHub</a>, exactly the version the line runs. You can run the line again at any time.</li></ul>`)}
</div>`;
const composeSteps = (where) => `<li>Create a folder named <code>qorewitness</code> and save <a href="${COMPOSE_URL}">docker-compose.yml</a> in it.</li>
${where === "server" ? `<li>In that folder, create a file named <code>.env</code> with this line, so your laptop or phone can open the setup:
${copybox("env-server", "QW_UI_BIND=0.0.0.0:8080")}</li>
<li>Open a terminal on the server (on a NAS, connect over SSH), go to that folder and run:` : `<li>Open a terminal in that folder. On a Mac, use <b>Terminal</b>. On Windows, use <b>PowerShell</b>. Go to the folder and run:`}
${copybox(`compose-${where}`, "docker compose up -d\ndocker compose run --rm -T ui pair")}
The second line shows your pairing code.</li>`;
const pathServer = `<div class="path-panel" id="path-server"><h4>NAS or home server</h4><ol class="plain path-steps">
<li>Make sure Docker with Compose runs on it. On Synology, install <a href="https://www.synology.com/en-global/dsm/packages/ContainerManager">Container Manager</a> from the Package Center. On other systems, see <a href="https://docs.docker.com/engine/install/">Install Docker Engine</a>. On Proxmox, create a Debian container or virtual machine and choose <b>Raspberry Pi or Linux computer</b> above.</li>
<li>${ROUTER_IP}</li>
${composeSteps("server")}
<li>On your laptop or phone, open <code>http://IP-ADDRESS:8080/setup</code> with the server's IP address.</li>
</ol>
<p class="small">More detail: <a href="${GHDOC("INSTALL.md")}">INSTALL.md</a>.</p>
</div>`;
const pathDesktop = `<div class="path-panel" id="path-desktop"><h4>Windows or Mac</h4><ol class="plain path-steps">
<li>Install <a href="https://www.docker.com/products/docker-desktop/">Docker Desktop</a> and start it. Set the computer to never sleep, because QoreWitness only records while it is on.</li>
${composeSteps("desktop")}
<li>On the same computer, open <code>http://localhost:8080/setup</code>.</li>
</ol>
<p class="small">More detail: <a href="${GHDOC("INSTALL.md")}">INSTALL.md</a>.</p>
</div>`;
page({
  file: "get-started.html",
  current: "get-started.html",
  title: "Set up your camera | QoreWitness",
  desc: "Step by step: check that your camera is compatible, prepare it, install QoreWitness on an always-on computer and finish the setup in your browser.",
  body: `
${head("Get started", "Set up your camera.", "QoreWitness works with any camera that offers an RTSP or ONVIF video stream on your home network.")}
<section><div class="wrap">
<div class="guide">
<aside class="rail" aria-label="Steps"><h2>On this page</h2><ol>${railItems.map(([id, t]) => `<li${id === "need" ? ' class="nonum"' : ""}><a href="#${id}">${t}</a></li>`).join("")}</ol></aside>
<div>

<div id="need" class="need">
<h2>What you need</h2>
<ul class="checks" style="margin-top:16px">
<li>${ico("check")}<span><b>A compatible camera</b> that shares an RTSP or ONVIF stream.</span></li>
<li>${ico("check")}<span><b>A computer that stays on</b>, such as a Raspberry Pi, a mini PC, a home server or a NAS. A Windows or Mac computer works too.</span></li>
</ul>
${help("Hardware requirements", hwTable, "hardware")}
${help("How much storage?", `<p>A 2K camera writes about 15 to 20 GB a day, so two weeks of video for one camera needs roughly 200 to 300 GB. On a Raspberry Pi, use a USB SSD, because SD cards wear out quickly when they record video day and night.</p>`)}
<div class="callout"><b class="t">Aim your camera at your own property</b>If it films the street or a neighbour's home, privacy law may apply to you. A small sign helps. See <a href="trust.html#privacy">Trust and limits</a>.</div>
</div>

<ol class="steps" style="margin-top:44px">

<li class="step" id="s1"><h3>Check that your camera is compatible</h3><p class="time">Camera app or manual</p><div class="body">
<p>Look in your camera app, its settings or its manual for any of these words: <b>RTSP</b>, <b>ONVIF</b>, <b>camera account</b>, <b>local stream</b> or <b>NVR</b>. If you find one, your camera can very likely share its video with QoreWitness.</p>
<p>Not sure? Search the web or ask an AI assistant: "Does my [brand and model] support RTSP?"</p>
<p>Battery cameras and cameras that only stream to their maker's cloud do not offer that stream, so they cannot work. The <a href="cameras.html">camera list</a> shows what we know brand by brand, and you can <a href="cameras.html#check">check your own camera in two minutes</a> with the free VLC player.</p>
</div></li>

<li class="step" id="s2"><h3>Prepare your camera</h3><p class="time">Camera app or camera web page</p><div class="body">
<p>Switch on the camera's local stream and give it its own account name and password. QoreWitness uses that account to read the video on your home network. Pick your brand for the exact steps.</p>
${brandHints}
<p style="margin-top:20px">Two good habits for any camera: use a new password that you do not use anywhere else, and give the camera a fixed address in your router (often called a "DHCP reservation"), so QoreWitness always finds it.</p>
</div></li>

<li class="step" id="s3"><h3>Install QoreWitness</h3><p class="time">Pick where it runs</p><div class="body">
<div class="where">
<fieldset class="where-pick"><legend>Where will QoreWitness run?</legend>
${whereOpt("linux", "Raspberry Pi or Linux computer", "Debian, Ubuntu, Raspberry Pi OS")}
${whereOpt("server", "NAS or home server", "Synology, Unraid, TrueNAS, Proxmox")}
${whereOpt("desktop", "Windows or Mac", "With Docker Desktop")}
</fieldset>
<p class="where-hint small muted">Pick one to see its steps.</p>
${pathLinux}
${pathServer}
${pathDesktop}
</div>
</div></li>

<li class="step" id="s4"><h3>Open the setup in your browser</h3><p class="time">Browser on your laptop or phone</p><div class="body">
<p>Open the setup link from step 3 and type the pairing code. Choose a password for your dashboard, and QoreWitness looks for cameras on your network.</p>
<ol class="plain">
<li><b>Pick your camera</b> from the list, or type its address if it is not there.</li>
<li><b>Enter the camera account</b> name and password from step 2, tick that the camera films your own property, and press <b>Test camera</b>.</li>
<li><b>Is this your camera?</b> QoreWitness tests the picture and shows it. Press <b>Yes, this is my camera</b>.</li>
</ol>
<p>A progress bar then connects your camera to the public ledger. You can close the page while it works. During the beta we cover the network fees, so there is no wallet to set up and nothing to pay or top up.</p>
${screens("The setup in your browser, five screens", [
  ["setup-pair", ALT.pair, "1. Type the pairing code"],
  ["setup-password", ALT.password, "2. Choose a password"],
  ["setup-camera", ALT.camera, "3. Pick your camera"],
  ["setup-picture", ALT.picture, "4. Confirm its picture"],
  ["setup-progress", ALT.progress, "5. Let it connect"],
])}
${help("Something not working?", `<ul class="plain"><li><b>The camera refused the password.</b> Set up the camera account again with letters and digits only.</li><li><b>No camera answers.</b> Check the camera's address and that it is switched on and on the same network.</li><li><b>The camera is busy or sends no picture.</b> Close its live view in the camera app and try again. On Tapo cameras, Tapo Care, the microSD card and QoreWitness can only run two at a time.</li><li><b>The free beta is full.</b> The setup tells you and offers to use your own wallet instead. See <a href="plans.html">Plans</a>.</li><li><b>Forgot your dashboard password?</b> Run the install line from step 3 again with <code>--new-password</code> added after <code>--yes</code>. With Docker Compose, run <code>docker compose run --rm -T ui pair --new-password</code> in the <code>qorewitness</code> folder.</li></ul>`)}
</div></li>

<li class="step" id="s5"><h3>Done</h3><p class="time">Dashboard</p><div class="body">
<p>You see <b>Sealing started</b>, and your first seals arrive shortly after. Open your dashboard and bookmark it on your phone and laptop. Its status line turns green as soon as sealing runs.</p>
<div class="duo">${phone("setup-done", ALT.done, "Sealing started")}${browser("dashboard-desktop", ALT.dashDesk, "192.168.1.42:8080", "Your dashboard, here on a laptop")}</div>
<div class="callout ok"><b class="t">That's it.</b>Keep using your camera app for live view and alerts, just as before. <a href="daily-use.html">Daily use</a> explains the dashboard, and <a href="prove.html">Prove a video</a> shows how to share a sealed clip.</div>
</div></li>
</ol>
</div>
</div>
</div></section>
${closing("Not sure about your camera?", "Check the camera list, or test your camera's stream yourself in two minutes.", "cameras.html", "See the camera list")}`,
});

/* ================= CAMERAS ================= */
const camRow = (name, status, note, label = "Notes") => `<tr><th scope="row">${name}</th><td data-label="Status">${status}</td><td data-label="${label}">${note}</td></tr>`;
const RTSP = pill("info", "Works with RTSP");
page({
  file: "cameras.html",
  current: "cameras.html",
  title: "Cameras | QoreWitness",
  desc: "Which cameras work with QoreWitness: cameras we run ourselves, brands with a documented RTSP stream, cameras that cannot work, and how to check your own camera with VLC.",
  body: `
${head("Cameras", "Does your camera work with QoreWitness?", "If your camera can share a video stream on your home network over RTSP or ONVIF, QoreWitness can very likely seal it. Here is what we know, brand by brand, and how to check your own camera in two minutes.")}
<section><div class="wrap">
<div class="sec-head"><p class="eyebrow">How to read this list</p><h2>Honest statuses, nothing more.</h2>
<p>We only call a camera tested when we have run it with QoreWitness ourselves. Everything else is based on what the camera makers document, and we have no partnership with any of them.</p></div>
<ul class="grid c3 legend">
<li class="tile">${pill("ok", "Tested by us")}<p>We run this camera with QoreWitness ourselves.</p></li>
<li class="tile">${RTSP}<p>The maker documents a standard RTSP stream, which is what QoreWitness records. We have not tested these models ourselves.</p></li>
<li class="tile">${pill("no", "Not supported")}<p>The camera offers no stream on your home network, so QoreWitness cannot record it.</p></li>
</ul>

<h2 style="margin:56px 0 16px" id="tested">Tested by us</h2>
<div class="tablewrap"><table class="stack"><thead><tr><th scope="col">Camera</th><th scope="col">Status</th><th scope="col">What we found</th></tr></thead><tbody>
${camRow("LSC Smart Connect indoor camera (Action)", pill("ok", "Tested by us"), "Sealing in our own home around the clock since 9 November 2026. Its local stream is off by default: depending on the model and firmware it needs the ONVIF setting in the app or a community method, and the stream has no password, so keep it on a separate network. A fine camera for tinkerers, and not our pick for a first setup.", "What we found")}
${camRow("TP-Link Tapo C210", pill("warn", "Test planned"), "Next on our test bench. Its local stream uses the Camera Account in the Tapo app. We update this row with what we find after the test.", "What we found")}
</tbody></table></div>

<h2 style="margin:56px 0 16px" id="rtsp">Works with RTSP</h2>
<p>These brands document a standard RTSP stream for their wired and PoE cameras. The <a href="get-started.html#s2">setup guide</a> has short hints for each one.</p>
<div class="tablewrap"><table class="stack"><thead><tr><th scope="col">Brand</th><th scope="col">Status</th><th scope="col">How to switch on the stream</th></tr></thead><tbody>
${camRow("TP-Link Tapo (wired models)", RTSP, "Camera Account in the Tapo app. Battery models are not supported.", "How to switch on the stream")}
${camRow("Reolink (wired and PoE)", RTSP, "Switch on RTSP in the network settings of the app or client.", "How to switch on the stream")}
${camRow("Hikvision and Annke", RTSP, "Usually on already. ONVIF under Integration Protocol.", "How to switch on the stream")}
${camRow("Dahua and Amcrest", RTSP, "Usually on already. ONVIF in the network settings.", "How to switch on the stream")}
${camRow("Ubiquiti UniFi Protect", RTSP, "Switch on an RTSP stream in the camera settings and copy the link.", "How to switch on the stream")}
${camRow("Axis", RTSP, "On as standard. Create a user for QoreWitness.", "How to switch on the stream")}
${camRow("Other ONVIF cameras", RTSP, "Switch on ONVIF and create an ONVIF user.", "How to switch on the stream")}
</tbody></table></div>

<h2 style="margin:56px 0 16px" id="unsupported">Not supported</h2>
<p>Battery cameras sleep to save power, and cloud-only cameras send their video straight to the maker's servers. Neither offers a stream on your home network, so QoreWitness has nothing to record.</p>
<div class="tablewrap"><table class="stack"><thead><tr><th scope="col">Camera</th><th scope="col">Status</th><th scope="col">Why</th></tr></thead><tbody>
${camRow("Most Ring cameras and doorbells", pill("no", "Not supported"), "Cloud only, no local stream.", "Why")}
${camRow("Arlo", pill("no", "Not supported"), "Battery or cloud based on most models.", "Why")}
${camRow("Blink", pill("no", "Not supported"), "Battery and cloud only.", "Why")}
${camRow("Google Nest cameras", pill("no", "Not supported"), "Cloud only, no local stream.", "Why")}
${camRow("Tapo battery cameras and battery doorbells", pill("no", "Not supported"), "No stream while on battery. Some wired doorbells are the exception.", "Why")}
</tbody></table></div>
</div></section>

<section class="alt" id="check"><div class="wrap narrow">
<p class="eyebrow">Try it yourself</p>
<h2>How to check your camera in 2 minutes</h2>
<p style="margin-top:16px">The free VLC player opens the same kind of stream that QoreWitness records. If VLC shows your camera's picture, QoreWitness will very likely work with it too.</p>
<ol class="plain">
<li>Find your camera's address in the camera app or in your router, for example <code>192.168.1.20</code>.</li>
<li>Switch on the camera's stream and note its account name and password. The <a href="get-started.html#s2">brand hints</a> show where.</li>
<li>Install <a href="https://www.videolan.org/vlc/">VLC</a> on your computer and open it.</li>
<li>Choose <b>Media</b>, then <b>Open Network Stream</b> (on a Mac: <b>File</b>, then <b>Open Network</b>).</li>
<li>Type the stream address and press <b>Play</b>.</li>
</ol>
<p>For a Tapo camera, the address looks like this:</p>
${copybox("vlc-url", "rtsp://NAME:PASSWORD@192.168.1.20:554/stream1", "Copy")}
<p>Do you see your camera's picture? Then you are ready to <a href="get-started.html">set it up</a>.</p>
${help("No picture?", `<ul class="plain"><li>Check the address, the account name and the password. Letters and digits are the safest choice for both.</li><li>Check the stream path for your brand in the <a href="get-started.html#s2">brand hints</a>. Searching for your model with the words "RTSP URL" usually finds it.</li><li>Close the live view in the camera app, because some cameras allow only a few viewers at once.</li></ul>`)}
</div></section>
${closing("Camera ready?", "Install QoreWitness and finish the setup in your browser.", "get-started.html", "Set up your camera")}`,
});

/* ================= DAILY USE ================= */
page({
  file: "daily-use.html",
  current: "daily-use.html",
  title: "Daily use | QoreWitness",
  desc: "Living with QoreWitness: what the dashboard colours mean, how long recordings are kept, and what happens after a power cut.",
  body: `
${head("Daily use", "Set it up once, and it simply keeps going.", "Keep using your camera app for live view and alerts, just as you do today. QoreWitness works quietly in the background, and your dashboard tells you at a glance that all is well.")}
<section class="edged"><div class="wrap narrow">
<h2>Your dashboard</h2>
<p style="margin-top:16px">It shows one status line in a colour, and when something needs you, exactly one thing to do. Bookmark it on your phone and laptop. Its address is the one the installer showed, such as <code>http://192.168.1.42:8080</code>.</p>
<div class="tablewrap"><table class="stack"><thead><tr><th scope="col">Colour</th><th scope="col">It says</th><th scope="col">What to do</th></tr></thead><tbody>
<tr><td><b style="color:var(--ok)">Green</b></td><td data-label="It says">Sealing OK.</td><td data-label="What to do">Nothing at all.</td></tr>
<tr><td><b style="color:var(--warn)">Orange</b></td><td data-label="It says">Waiting for the first seal.</td><td data-label="What to do">Nothing. It arrives shortly after setup.</td></tr>
<tr><td><b style="color:var(--warn)">Orange</b></td><td data-label="It says">The disk is almost full.</td><td data-label="What to do">Keep video for fewer days, or connect a bigger disk.</td></tr>
<tr><td><b style="color:var(--bad)">Red</b></td><td data-label="It says">No video from the camera.</td><td data-label="What to do">Check the camera's power and Wi-Fi.</td></tr>
<tr><td><b style="color:var(--bad)">Red</b></td><td data-label="It says">Sealing stopped.</td><td data-label="What to do">Check that your QoreWitness computer is online, and restart it if the message stays.</td></tr>
</tbody></table></div>
<figure class="shot"><div class="device panel"><img src="${SCR}dashboard-states.webp" width="1856" height="494" alt="${ALT.states}" loading="lazy" decoding="async"></div><figcaption>The status line in its three colours, as the dashboard shows it.</figcaption></figure>
${help("Using your own wallet: fee messages", `<p>If you chose <b>Use my own wallet</b> in the setup, you pay the network fees yourself. When the dashboard says the fees are running out, add tokens to the address it shows. See <a href="plans.html">Plans</a>.</p>`)}
<p class="muted">Phone alerts are on our roadmap. For now, you see the status whenever you open the dashboard.</p>
<div class="duo narrow-duo">${phone("dashboard-phone", ALT.dashPhone, "Your dashboard on a phone")}<div class="stack"><h3>Bookmark it</h3><p>Add the dashboard to your phone's home screen and it opens like an app. Every row is a sealed part of your recording, with its own <b>Download</b> button for the day you need it.</p></div></div>
</div>${edge("wave", "alt")}</section>

<section class="alt"><div class="wrap narrow">
<h2>About two weeks of video, and seals that outlive your computer</h2>
<p style="margin-top:16px">QoreWitness keeps about two weeks of recordings, depending on your disk, and clears the oldest to make room. The seals stay on the public ledger. During the beta, seals live on the QoreChain test network, which can be reset. <a href="trust.html#beta">What the beta means for you</a>. A clip that has been cleared cannot be proven, so press <b>Save evidence</b> for anything you may need later. <a href="prove.html#owner">Prove a video</a> shows how.</p>
</div></section>

<section><div class="wrap narrow">
<h2>Power cuts and restarts</h2>
<ul class="plain" style="margin-top:16px">
<li><b>Your QoreWitness computer restarts.</b> Sealing picks up again by itself.</li>
<li><b>The camera loses power.</b> Nothing is recorded while it is off, and every earlier seal stays valid. The dashboard turns red until the camera is back.</li>
<li><b>The internet goes down.</b> Recording carries on. Footage from while the connection was down may have no seal, and the public record shows that gap openly.</li>
</ul>
</div></section>

<section class="alt"><div class="wrap narrow">
<h2>Pause or remove</h2>
<ul class="plain" style="margin-top:16px">
<li>To pause, switch off your QoreWitness computer. Your camera and its app keep working as usual.</li>
<li>To remove QoreWitness, see <a href="developers.html#run">Developers</a>.</li>
<li>Seals on the public record cannot be deleted. They hold only fingerprints and times.</li>
</ul>
${help("Advanced: back up your QoreWitness computer", `<p>If the computer breaks, you set QoreWitness up again with a new camera seal, and every earlier seal stays checkable on the public ledger (during the beta, until the test network is reset). To keep the same camera identity, copy the folder <code>~/qorewitness/data</code> to a USB stick and keep it safe. Anyone with these files can use your account, which is why QoreWitness never asks for them.</p>`)}
<div class="callout"><b class="t">Keep QoreWitness on your home network</b>Use a network you trust, and never open port 8080 to the internet in your router.</div>
</div></section>
${closing("Need to prove a clip?", "Press Save evidence, share the file, and let anyone check it with QoreWitness Verify.", "prove.html", "Prove a video")}`,
});

/* ================= PROVE ================= */
const emailTpl = `Subject: Video evidence with a QoreWitness seal

Hello,

Attached is a file from my home camera with the video and its seal.
QoreWitness sealed this footage as it was recorded.

To check it:
1. Open QoreWitness Verify: ${SITE}/verifier.html
2. Press "Choose files" and pick the evidence file, or drop it on the page.
3. A green "Original" confirms that the video has not been modified since it was sealed.

The check runs in your own browser, so you do not need to take my word for it, or anyone else's.

Please note that the video shows people, and handle it with care.`;
page({
  file: "prove.html",
  current: "prove.html",
  title: "Prove a video | QoreWitness",
  desc: "Share a clip with its QoreWitness seal, and anyone can confirm online, in seconds, that the video is the untouched original.",
  body: `
${head("Prove a video", "Share a video, and let anyone confirm it's the original.", "If you ever need to provide video evidence, just share the clip with its QoreWitness seal. Anyone can verify the seal and confirm the video is untouched, online, in seconds.")}
<section id="owner" class="edged"><div class="wrap">
<div class="split">
<div>
<p class="eyebrow">If you share a video</p><h2>Save your evidence.</h2>
<ol class="plain" style="margin-top:16px">
<li>Open your dashboard.</li>
<li>Press <b>Download</b> next to the time you need, or press <b>Save evidence</b> and pick a time range.</li>
<li>You get one evidence file with the video and its receipts. Send it to whoever needs it, such as an insurer or a lawyer.</li>
</ol>
<div class="pair">${phone("dashboard-phone", ALT.dashPhone, "Download next to a time")}${phone("evidence-phone", ALT.evidence, "Or pick a time range")}</div>
<p>Do this in good time, because QoreWitness keeps about two weeks of video.</p>
<div class="callout warn"><b class="t">Your video shows people</b>Share it only with those who need it, and keep it off public channels.</div>
${help("A message you can send with the file", `<div class="copybox light"><code id="mail-tpl">${emailTpl}</code><button class="btn" type="button" data-copy="mail-tpl">${ico("copy")}<span>Copy text</span></button></div>`)}
</div>
<div id="verify" class="stack"><p class="eyebrow">If you received a video</p><h2 style="margin-bottom:16px">Check it with QoreWitness Verify.</h2>
<p>Use our online verification service to check that a video was recorded when it claims to have been, and that it has not been modified since. You need no account and no software, and your file never leaves your computer.</p>
<ol class="plain">
<li>Open QoreWitness Verify.</li>
<li>Press <b>Choose files</b> and pick the evidence file, or simply drop it on the page.</li>
<li>Read the result. A green <b>Original</b> means the video has not been modified since it was sealed.</li>
</ol>
<div class="btns"><a class="btn primary" href="${UP}verifier.html">Open QoreWitness Verify ${ico("arrow")}</a></div>
${phone("verify-phone", ALT.verifyPhone, "A green Original in QoreWitness Verify", { cls: "solo" })}
</div>
</div>
</div>${edge("wave", "alt")}</section>

<section class="alt" id="sample"><div class="wrap">
<div class="split">
<div class="stack"><h2>What the result looks like</h2>
${cert("Example result")}
<div class="cert bad"><span class="tag">After one changed byte</span><div class="head">${ico("x-circle")}<div><b>Changed after sealing</b><span>This video does not match what was sealed. Do not rely on it.</span></div></div></div>
<p class="small muted">A button under the result prints it for your records.</p></div>
<div><h3 style="margin-bottom:10px">See it for yourself</h3>
<p>Download our sealed sample recording, a generated test pattern, together with its receipt, then choose both files in QoreWitness Verify or drop them on the page. Then use the button there to change a single byte and check again: the result turns red.</p>
<div class="btns"><a class="btn" href="${UP}${SAMPLE.clip}" download>Sample recording</a><a class="btn" href="${UP}${SAMPLE.receipt}" download>Its receipt</a></div>
<h3 style="margin:32px 0 10px">What a green result means</h3>
<ul class="checks"><li>${ico("check")}<span>The video existed at the time recorded on the public ledger.</span></li><li>${ico("check")}<span>It has not been modified since it was sealed.</span></li><li>${ico("check")}<span>One known camera made the seal.</span></li></ul>
<p class="small">An orange <b>Original, with notes</b> means the video is unchanged too, and the page explains the notes, for example a few minutes when the camera was off.</p>
<h3 style="margin:24px 0 10px">What it does not mean</h3>
<ul class="checks no"><li>${ico("x")}<span>That the scene was real. A staged scene is sealed in exactly the same way.</span></li><li>${ico("x")}<span>That a court will accept it. A court decides for itself how much weight to give it.</span></li></ul>
<p class="small"><a href="trust.html">Read Trust and limits</a></p></div>
</div>
<div class="art" style="max-width:220px;margin:32px 0 0">${artTamper}</div>
<p class="small muted">A red result is a broken seal. Nobody has to trust the sender or us, and the code is open for anyone to read.</p>
</div></section>`,
});

/* ================= PLANS ================= */
page({
  file: "plans.html",
  current: "plans.html",
  title: "Plans | QoreWitness",
  desc: "Free: runs on your own hardware, and during the beta we cover the network fees. Hands-off: USD 10 or EUR 9 per camera per month, available when QoreWitness launches on the QoreChain main network.",
  body: `
${head("Plans", "Free while we build. Hands-off when we launch.", "QoreWitness runs on your own hardware, and during the beta it is free for everyone, network fees included. You never need a wallet, tokens or a second thought to start sealing your footage today.")}
<section style="padding-top:40px"><div class="wrap">
<div class="plans">
<article class="plan feature" aria-labelledby="p-free" id="free">
<p class="plan-tag">Recommended</p>
<h2 id="p-free">Free</h2><p class="for">Runs on your own hardware, for every camera you own.</p>
<p class="price"><span class="amt">EUR 0</span> per camera per month</p>
<p class="free">${pill("ok", "Beta: we cover the network fees")}</p>
<ul class="checks" style="margin-top:8px"><li>${ico("check")}<span>Works straight after setup, with no wallet and no tokens to buy.</span></li><li>${ico("check")}<span>During the beta we pay the test-network fees for every seal.</span></li><li>${ico("check")}<span>QoreWitness Verify for everyone you share a video with.</span></li><li>${ico("check")}<span>On the main network, the Free plan pays the small network fees from your own wallet, or you switch to Hands-off.</span></li></ul>
<div class="push"><a class="btn primary" href="get-started.html">Set up your camera ${ico("arrow")}</a><p class="small muted" style="margin:12px 0 0">Already have a QoreChain wallet? Choose <b>Use my own wallet</b> under <b>Advanced</b> in the setup.</p></div>
</article>
<article class="plan soon" aria-labelledby="p-hands" aria-describedby="hands-note" id="hands-off">
<p class="soon-bar" id="hands-note">${ico("lock")}<span>Available when QoreWitness launches on the QoreChain main network</span></p>
<p class="plan-tag muted">Coming at launch</p>
<h2 id="p-hands">Hands-off</h2><p class="for">For everyone who wants the network fees taken care of for good.</p>
<p class="price"><span class="amt">USD 10</span> or <span class="amt alt">EUR 9</span> <span class="per">per camera per month</span></p>
<ul class="checks" style="margin-top:16px"><li>${ico("check")}<span>The same seals and the same proof as the Free plan.</span></li><li>${ico("check")}<span>Every network fee on the main network taken care of by us.</span></li><li>${ico("check")}<span>No wallet, no tokens and nothing to top up, ever.</span></li></ul>
<div class="push"><a class="btn notify" href="${X}" aria-describedby="hands-note">${ico("arrow")}<span>Get notified on X, @fnoufnou</span></a><p class="small muted" style="margin:12px 0 0">Until the launch, everyone uses the Free plan. We will announce Hands-off on X first.</p></div>
</article>
</div>
<div class="callout" style="margin-top:32px"><b class="t">Why is it free right now?</b>QoreWitness runs on the QoreChain test network during the beta, where the network fees are paid in test tokens that have no value. We cover them for you, so you can enjoy the full service while we build it out. <a href="trust.html#beta">What the beta means for you</a></div>
<p class="small muted" style="margin-top:24px">Questions about pricing? See the <a href="faq.html">FAQ</a>.</p>
</div></section>`,
});

/* ================= FAQ ================= */
page({
  file: "faq.html",
  current: "faq.html",
  title: "FAQ | QoreWitness",
  desc: "Answers to the questions people ask most about QoreWitness: privacy, cameras, hardware, cost, courts and what a seal can and cannot prove.",
  body: `
${head("FAQ", "Questions people ask.", "Clear answers to the questions we hear most. If yours is not here, we are happy to help on X or in the QoreChain Discord.")}
<section><div class="wrap narrow">${faqItems(FAQ)}
<div class="callout" style="margin-top:32px"><b class="t">Another question?</b>Message <a href="${X}">@fnoufnou on X</a> or write in the <a href="${DISCORD}">QoreChain Discord</a>.</div>
</div></section>
${closing("Ready to seal your footage?", "Setup takes about an hour, and you only do it once.", "get-started.html", "Set up your camera")}`,
});

/* ================= TRUST ================= */
page({
  file: "trust.html",
  current: "trust.html",
  title: "Trust and limits | QoreWitness",
  desc: "What QoreWitness proves and what it cannot, who could attack it, how it was reviewed, what the beta on the test network means, and what leaves your home.",
  body: `
${head("Trust and limits", "What it proves, and what it cannot.", "A proof is only as good as what goes into it, so here is the plain list. We publish what our own tests catch and what they miss.")}
<section><div class="wrap split">
<div><h2>What it proves</h2>
<ul class="checks" style="margin-top:16px">
<li>${ico("check")}<span>The file existed at the time of the ledger record. It is sealed within one 10-minute window of recording.</span></li>
<li>${ico("check")}<span>It has not changed since it was sealed.</span></li>
<li>${ico("check")}<span>The seal was made with the key of one known camera.</span></li>
<li>${ico("check")}<span>The clip sits in an unbroken recording. A removed, inserted or reordered clip shows, and a gap in recording shows with its start and length.</span></li>
<li>${ico("check")}<span>The time is bounded on both sides: the seal was made after a recent block and recorded before a later block.</span></li>
</ul></div>
<div><h2>What it cannot prove</h2>
<ul class="checks no" style="margin-top:16px">
<li>${ico("x")}<span>That the scene was real. A staged scene or a fake stream is sealed in the same way.</span></li>
<li>${ico("x")}<span>Who recorded it. It shows which camera key signed.</span></li>
<li>${ico("x")}<span>That nobody fed the QoreWitness computer fake footage before sealing. That computer is the trust boundary.</span></li>
<li>${ico("x")}<span>That a court accepts it. We are not an EU qualified time stamp provider, and a court weighs a seal like other evidence.</span></li>
</ul></div>
</div></section>

<section class="alt" id="beta"><div class="wrap narrow">
<p class="eyebrow">The beta</p>
<h2>What the beta on the test network means for you</h2>
<p style="margin-top:16px">QoreWitness runs on qorechain-diana, the QoreChain test network. The post-quantum checks it relies on are live there today and not yet on the QoreChain main network.</p>
<ul class="limits">
<li><b>The test network can be reset.</b> The QoreChain team says it will not reset before 15 Dec 2026. After that, a reset can remove every seal made during the beta.</li>
<li><b>Seals from the beta show how the method works.</b> They are not meant as evidence yet, because the test network can be reset. Keep the original files.</li>
<li><b>The free beta fees depend on us.</b> The service operator (fnoufnou) pays the network fees with test tokens that have no value. The service can stop, and you can then pay the fees from your own wallet.</li>
<li><b>No payment is collected during the beta.</b> The paid Hands-off plan only starts when QoreWitness launches on the main network. When the main network opens, seals would need to be made again there. We plan to tell you before that happens and to guide you through it.</li>
</ul>
</div></section>

<section id="facts"><div class="wrap">
<div class="sec-head"><p class="eyebrow">Facts you can check</p><h2>Only what we can show today.</h2>
<p>Each item links to its proof. You will find no logos, customer counts or reviews here, because we have none to show yet.</p></div>
<ul class="grid c2" style="list-style:none;padding:0;margin:0">
<li class="tile"><h3>Open source</h3><p>All code is open under Apache-2.0. <a href="${GH}">Read it on GitHub</a>.</p></li>
<li class="tile"><h3>Reviewed with the QCAI Contract Auditor</h3><p>Four automated review rounds on QoreChain, with the reports published. <a href="${GHDOC("AUDIT.md")}">Read the audit notes</a>.</p></li>
<li class="tile"><h3>Checked on chain</h3><p>The smart contract checks the ML-DSA-87 signature on QoreChain before it accepts a record. <a href="developers.html#pqc">See how</a>.</p></li>
<li class="tile"><h3>A live camera since 9 Nov 2026</h3><p>A real home camera has sealed its footage every 10 minutes on the test network since 9 Nov 2026, on registry v4 since 14 Nov.</p></li>
<li class="tile"><h3>QoreWitness Verify in one file</h3><p>The verification service runs in your browser. It is one HTML file with a published SHA-256 fingerprint. <a href="${UP}verifier.html">Open QoreWitness Verify</a>.</p></li>
<li class="tile"><h3>We publish what we miss</h3><p>Our own attack drills list what the system catches and what it does not. <a href="#threats">Read the results</a>.</p></li>
</ul>
</div></section>

<section class="alt" id="threats"><div class="wrap">
<div class="sec-head"><p class="eyebrow">Threat model, summary</p><h2>Who could attack it, and what happens.</h2>
<p>We ran these drills on the live system ourselves. No outside firm ran them. The full texts are in the <a href="${GHDOC("THREAT_MODEL.md")}">threat model</a> and the <a href="${GHDOC("CUSTODY_DRILL.md")}">custody drill</a>.</p></div>
<div class="tablewrap"><table><thead><tr><th scope="col">Attack</th><th scope="col">Result</th><th scope="col">Why</th></tr></thead><tbody>
<tr><td>Change one byte of a sealed clip</td><td><b>Detected</b></td><td>The file fingerprint is no longer in the receipt.</td></tr>
<tr><td>Remove or reorder a clip in the receipt</td><td><b>Detected</b></td><td>The chain of clips breaks.</td></tr>
<tr><td>Seal a second version of an old window</td><td><b>Refused</b></td><td>The contract refuses overlapping windows.</td></tr>
<tr><td>Swap in footage from another camera, re-encode, delete or add a clip before sealing</td><td><b>Flagged</b></td><td>The record shows a stream change, a gap or an overlap. In our drill, 4 of 5 such attacks were flagged.</td></tr>
<tr><td>Swap in footage that uses the camera's own settings, before sealing</td><td><b>Missed</b></td><td>The QoreWitness computer cannot tell. This is the trust boundary.</td></tr>
<tr><td>Steal the QoreWitness computer</td><td>Risk</td><td>It holds your camera key and, today, the keys of your account on the test network. Keep it safe. A mode that keeps the main key offline is planned.</td></tr>
<tr><td>An attacker with only the classic (ECDSA) key of the account</td><td><b>Failed</b></td><td>In a dry run of the Q-Day Drill, 13 attacks failed and 0 succeeded. Every change needs a fresh post-quantum signature.</td></tr>
</tbody></table></div>
</div></section>

<section><div class="wrap split">
<div><h2>How it was reviewed</h2>
<p style="margin-top:16px">We reviewed the smart contract in four rounds with the QCAI Contract Auditor on the QoreChain dashboard, from 12 to 17 Nov 2026. Each finding is mapped to a fix, a test or a reason, and the reports are published.</p>
<p>These are automated reviews. No accredited security firm has audited QoreWitness.</p>
<p><a href="${GHDOC("AUDIT.md")}">Read the audit notes</a></p></div>
<div><h2>Open source</h2>
<p style="margin-top:16px">All code is open under Apache-2.0. You can read it, run it and rebuild QoreWitness Verify yourself. It is one HTML file, and its SHA-256 fingerprint is published.</p>
<p><a href="${GH}">GitHub</a> · <a href="developers.html">Developers</a></p></div>
</div></section>

<section class="alt" id="privacy"><div class="wrap">
<div class="sec-head"><p class="eyebrow">Privacy</p><h2>What leaves your home.</h2>
<p>This is a summary and not legal advice. It reflects the GDPR (AVG) as we understand it.</p></div>
<div class="tablewrap"><table><thead><tr><th scope="col">Part</th><th scope="col">Data</th><th scope="col">Our rule</th></tr></thead><tbody>
<tr><td>Your QoreWitness computer</td><td>Video of people at and near your home. The camera address and camera password.</td><td>Video stays on your computer, and we never receive it. QoreWitness sends no usage data to us.</td></tr>
<tr><td>Public ledger</td><td>Account address, camera id, times and fingerprints.</td><td>A fixed rhythm. Fingerprints show no content. We use no names or addresses as labels.</td></tr>
<tr><td>Public ledger node</td><td>The node that QoreWitness talks to can see your IP address.</td><td>A known limit.</td></tr>
<tr><td>This website</td><td>Your IP address in server logs.</td><td>No trackers, and no email addresses collected.</td></tr>
</tbody></table></div>
<ul class="plain">
<li>Records on a public ledger cannot be deleted. Keep names and addresses out of camera labels.</li>
<li>A fingerprint of a video with people in it may count as personal data in some cases. Everything else stays off the chain.</li>
</ul>
<div class="callout warn"><b class="t">If your camera films the street or a neighbour</b>The household exemption likely does not apply then (CJEU, case C-212/13, Rynes). You are the controller of that video. Aim the camera at your own property, put up a sign, and read the guidance on home cameras from your data protection authority. In the Netherlands this is the <a href="https://www.autoriteitpersoonsgegevens.nl">Autoriteit Persoonsgegevens</a>.</div>
<p><b>QoreWitness will never ask for your passwords or files.</b></p>
</div></section>`,
});

/* ================= JURY ================= */
page({
  file: "jury.html",
  current: "jury.html",
  title: "For the jury | QoreWitness",
  desc: "QoreWitness for the QoreChain Developer Fest judges: what it is, how ML-DSA-87 is checked on chain, the live contracts, audits, drills, tests and where to find each proof.",
  body: `
${head("For the jury", "QoreWitness at a glance.", "Thank you for judging the QoreChain Developer Fest. QoreWitness is our entry in the Post-Quantum dApp category, under the alias fnoufnou. This page shows what it does, where QoreChain checks the post-quantum signature on chain, and how you can verify every claim yourself.", ["Post-Quantum dApp category", "Testnet: qorechain-diana, EVM chain ID 9800", "Open source, Apache-2.0"])}
<section class="edged"><div class="wrap split">
<div><p class="eyebrow">What it is</p><h2>Sealed video for home security cameras.</h2>
<p style="margin-top:16px">A small recorder at home cuts the camera stream into short clips and fingerprints each one with SHA-256 and SHA3-256. Every 10 minutes it builds a Merkle root, signs it with the camera's own ML-DSA-87 key and anchors it in the AnchorRegistry contract on QoreChain. The contract checks that signature with the <code>pqcVerify</code> precompile before it stores anything.</p>
<p>The owner keeps the video at home and gets a receipt per window. Anyone can check a clip with its receipt in QoreWitness Verify, a single HTML file that runs in the browser and reads the chain directly.</p>
<div class="btns" style="margin-top:20px"><a class="btn primary" href="${UP}verifier.html">Open QoreWitness Verify ${ico("arrow")}</a><a class="btn" href="${GH}">Source on GitHub</a></div></div>
<div>${browser("verify-desktop", ALT.verifyDesk, "qorewitness.fnoufnou.com/verifier.html", "The published sample record, checked against the live contract: Original.")}</div>
</div>${edge("wave", "alt")}</section>

<section class="alt edged" id="try"><div class="wrap narrow">
<p class="eyebrow">Try it yourself</p><h2>Four checks you can run in a few minutes.</h2>
<ol class="steps compact" style="margin-top:24px">
<li class="step"><h3>Check the sample record</h3><div class="body"><p>Download the <a href="${UP}${SAMPLE.clip}" download>sample clip</a> and its <a href="${UP}${SAMPLE.receipt}" download>receipt</a>, open ${VERIFY}, press <b>Choose files</b> and pick both, or drop them on the page. The result is a green <b>Original</b>, sealed within ${SAMPLE.within}, read from the chain in your own browser.</p><p class="small">QoreWitness Verify is one self-contained HTML file. Its SHA-256 is <code class="break">${VERIFIER_SHA}</code>. Rebuild it with <code>pnpm build:verifier</code> and compare.</p></div></li>
<li class="step"><h3>Break it on purpose</h3><div class="body"><p>Press <b>Try it: change one byte and check again</b>. The verifier flips one bit of the clip in memory and the result turns red.</p></div></li>
<li class="step"><h3>Find the anchor on chain</h3><div class="body"><p>Open the registry on the <a href="${"https://explore.qore.network"}/address/${REGISTRY}">testnet explorer</a> and look up the sample record in block ${SAMPLE.block} (${SAMPLE.sealed}).</p></div></li>
<li class="step"><h3>Run the tests</h3><div class="body"><p>Clone the repository and run <code>pnpm install --ignore-scripts</code> and <code>pnpm test</code>. The contract tests run against a mock of the precompiles, and the app tests use a mocked chain.</p></div></li>
</ol>
</div>${edge("wave", "bg")}</section>

<section><div class="wrap">
<div class="sec-head"><p class="eyebrow">Your criteria</p><h2>Where to find the proof for each one.</h2></div>
<div class="tablewrap"><table class="stack"><caption class="sr">Judging criteria and where to find the evidence</caption><thead><tr><th scope="col">Criterion</th><th scope="col">Where to see it</th></tr></thead><tbody>
<tr><th scope="row">Works as described</th><td data-label="Where to see it">One real home camera has anchored a window every 10 minutes on qorechain-diana since 9 Nov 2026, on registry v4 since 14 Nov. The <a href="${UP}verifier.html">verifier</a> checks any clip against the live contract. The <a href="get-started.html">setup guide</a> shows every screen of the app.</td></tr>
<tr><th scope="row">Real use of QoreChain</th><td data-label="Where to see it">AnchorRegistry v4 at <code>${REGISTRY}</code>, the hybrid (ECDSA plus ML-DSA-87) account flow with an EVM authorisation window, and the <code>pqcVerify</code> and <code>pqcKeyStatus</code> precompiles. See <a href="developers.html#contracts">contracts</a>.</td></tr>
<tr><th scope="row">PQC checked on chain</th><td data-label="Where to see it">Every state change in the registry needs a fresh ML-DSA-87 signature that the contract checks itself. The Q-Day Drill tried 13 attacks with only the ECDSA key, and none succeeded. See <a href="#pqc">below</a>.</td></tr>
<tr><th scope="row">Quality</th><td data-label="Where to see it">Four review rounds with the QCAI Contract Auditor, a threat model, a custody drill and a recovery drill, all published. See <a href="${GHDOC("AUDIT.md")}">AUDIT.md</a> and <a href="${GHDOC("THREAT_MODEL.md")}">THREAT_MODEL.md</a>.</td></tr>
<tr><th scope="row">User experience</th><td data-label="Where to see it">One line to install, then four short screens in the browser and a progress bar. No wallet, no keys and no jargon for the owner. See <a href="get-started.html#s4">the setup</a> and <a href="daily-use.html">daily use</a>.</td></tr>
</tbody></table></div>
</div></section>

<section class="alt" id="pqc"><div class="wrap split">
<div><p class="eyebrow">Post-quantum on chain</p><h2>The contract checks the signature itself.</h2>
<ul class="plain" style="margin-top:16px"><li><code>pqcVerify</code> at <code>0x…0A01</code> checks the ML-DSA-87 signature over every window root and every device change: register, rotate and revoke.</li><li><code>pqcKeyStatus</code> at <code>0x…0A02</code> tells the contract that the owner key is registered and that possession is proven.</li><li>Each window commits to the previous root of its camera, and the signed block hash bounds the time on both sides.</li><li>Anchors are immutable. There is no contract owner and no upgrade path.</li></ul></div>
<div class="panel"><h3>Chain-level protection</h3><p style="margin:0">Every EVM transaction on QoreChain needs a registered ML-DSA-87 key and an EVM authorisation window. The recorder opens a window that is scoped to the registry only. A stolen ECDSA key cannot anchor, register, revoke or rotate anything, even inside an open window.</p></div>
</div></section>

<section><div class="wrap">
<div class="sec-head"><p class="eyebrow">Evidence</p><h2>Contracts, audits, drills and tests.</h2></div>
<ul class="grid c2" style="list-style:none;padding:0;margin:0">
<li class="tile"><h3>Live contract</h3><p>Registry v4, deployed 14 Nov 2026: <code class="break">${REGISTRY}</code>. Earlier versions are listed on the <a href="developers.html#contracts">Developers</a> page.</p></li>
<li class="tile"><h3>Audit rounds</h3><p>Four rounds with the QCAI Contract Auditor from 12 to 17 Nov 2026, scores 82, 72, 78 and 85. These are automated reviews, and no accredited firm has audited QoreWitness. <a href="developers.html#audit">Details</a>.</p></li>
<li class="tile"><h3>Drills</h3><p>Q-Day Drill dry run: 13 attacks with only the ECDSA key, 0 succeeded. Custody drill: all 5 attacks after sealing rejected, 4 of 5 swaps before hashing flagged, 1 missed. Recovery drill: the receipt is rebuilt from public data.</p></li>
<li class="tile"><h3>Tests</h3><p>${TESTS} automated tests on 25 Nov 2026, for the contract, the recorder, the setup, the dashboard, the fee sponsor and the verifier. Run them with <code>pnpm test</code>.</p></li>
</ul>
<h3 style="margin:40px 0 10px">Known limits, stated openly</h3>
<ul class="limits">
<li>Testnet only. The PQC precompiles are not active on the QoreChain main network yet, so the public site presents QoreWitness as a beta.</li>
<li>The keys of the owner account sit on the recorder today. An agent-key mode is designed and a spike passed on the testnet, but relayed calls emit no EVM logs, so it waits until after the submission (<a href="${GHDOC("AGENT_KEY.md")}">notes</a>).</li>
<li>The Linux installer is tested end to end. Docker Compose on a NAS, Windows and macOS is documented and still has to be tested on each platform.</li>
<li>A seal proves that a file has not changed since it was sealed. It cannot prove that the scene was real.</li>
</ul>
<div class="btns" style="margin-top:28px"><a class="btn primary" href="developers.html">Full technical detail ${ico("arrow")}</a><a class="btn" href="${GHDOC("SPEC.md")}">Spec</a><a class="btn" href="${GHDOC("TESTNET_FINDINGS.md")}">Testnet findings</a><a class="btn" href="${GHDOC("CUSTODY_DRILL.md")}">Custody drill</a></div>
</div></section>`,
});

/* ================= DEVELOPERS ================= */
page({
  file: "developers.html",
  current: "developers.html",
  title: "Developers | QoreWitness",
  desc: "Architecture, contract addresses, post-quantum checks on chain, audit rounds and drills for QoreWitness on the QoreChain testnet qorechain-diana.",
  body: `
${head("Developers", "QoreWitness on QoreChain.", "Post-quantum evidence anchoring for home cameras, entered in the QoreChain Developer Fest (Post-Quantum dApp category) under the alias fnoufnou. It runs on the testnet only. Judges: start at <a href=\"jury.html\">For the jury</a>.", ["Open source, Apache-2.0", "Network: qorechain-diana (EVM chain ID 9800)"])}
<section><div class="wrap">
<div class="btns"><a class="btn primary" href="${GH}">GitHub ${ico("arrow")}</a><a class="btn" href="${GHDOC("SPEC.md")}">Spec</a><a class="btn" href="${GHDOC("AUDIT.md")}">Audit</a><a class="btn" href="${GHDOC("CUSTODY_DRILL.md")}">Custody drill</a><a class="btn" href="${GHDOC("THREAT_MODEL.md")}">Threat model</a><a class="btn" href="${UP}verifier.html">QoreWitness Verify</a></div>
</div></section>

<section class="alt"><div class="wrap">
<div class="sec-head"><p class="eyebrow">Architecture</p><h2>From camera to contract.</h2></div>
<pre class="pre" tabindex="0" aria-label="Architecture sketch">camera (RTSP) -> ffmpeg segments (60 s)
  -> agent: SHA-256 and SHA3-256 per segment
  -> window of 10 min -> Merkle root (SHA-256)
  -> ML-DSA-87 signature by the device key
  -> AnchorRegistry.anchor() on QoreChain  (pqcVerify on chain)
  -> receipt JSON next to the recordings

verifier (static page or CLI): clip + receipt
  -> file hash, Merkle path, verifyAnchor on chain,
     device key, ML-DSA-87 signature</pre>
<div class="tablewrap"><table><thead><tr><th scope="col">Key</th><th scope="col">Holder</th><th scope="col">Signs</th><th scope="col">Checked by</th></tr></thead><tbody>
<tr><td>Owner key (ML-DSA-87, registered on chain)</td><td>Owner account</td><td>Native transactions (hybrid), EVM window, register and revoke a device</td><td>Chain, and the contract via <code>pqcKeyStatus</code> and <code>pqcVerify</code></td></tr>
<tr><td>Device key (one per camera)</td><td>Agent next to the camera</td><td>Window roots, key rotation</td><td>Contract via <code>pqcVerify</code></td></tr>
</tbody></table></div>
<ul class="plain">
<li>Each window commits to the previous root of its camera. Each segment commits to the previous segment. Gaps are stored on chain.</li>
<li>The camera signs the hash of a recent block. The root was signed after that block and anchored before the anchor block.</li>
<li>Anchors are immutable. There is no contract owner and no upgrade path.</li>
</ul>
</div></section>

<section id="run"><div class="wrap narrow">
<p class="eyebrow">Run it yourself</p><h2>Install, update, back up, remove.</h2>
<ul class="plain" style="margin-top:16px">
<li><b>Install on the recorder computer itself:</b> <code>curl -fsSL https://raw.githubusercontent.com/fnoufnou/qorewitness/v0.6.0-alpha.4/install.sh | bash -s -- --yes</code>. Options: <code>--local-only</code>, <code>--new-password</code>, <code>--terminal</code> (setup with questions in the terminal), <code>--build</code>. See <a href="${GHDOC("INSTALL.md")}">INSTALL.md</a>.</li>
<li><b>Other platforms:</b> a NAS, a home server, Windows and macOS use the same <code>docker-compose.yml</code> (<a href="get-started.html#s3">guide</a>).</li>
<li><b>Other camera brands:</b> with <code>--terminal</code> you can give a full stream URL, for example <code>rtsp://user:password@192.168.1.20:554/stream</code>. Compatibility status per brand: <a href="cameras.html">cameras</a>. Research notes: <a href="${GHDOC("CAMERAS.md")}">CAMERAS.md</a>.</li>
<li><b>Update:</b> set the new version in <code>~/qorewitness/.env</code> (<code>QW_VERSION</code>), then <code>docker compose pull &amp;&amp; docker compose up -d</code>. The version is pinned, and QoreWitness never updates itself.</li>
<li><b>Back up:</b> copy <code>~/qorewitness/data</code>, at least <code>qorewitness.env</code> and <code>keys</code>. Anyone with these files can use the test account.</li>
<li><b>Remove:</b> <code>cd ~/qorewitness &amp;&amp; docker compose down</code>, then delete <code>~/qorewitness</code>.</li>
</ul>
</div></section>

<section id="contracts"><div class="wrap">
<div class="sec-head"><p class="eyebrow">Contracts</p><h2>Addresses on qorechain-diana.</h2><p>Explorer: <a href="https://explore.qore.network">explore.qore.network</a> (testnet).</p></div>
<div class="tablewrap"><table><thead><tr><th scope="col">What</th><th scope="col">Address</th></tr></thead><tbody>
<tr><td><b>Registry v4</b> (14 Nov, chained windows, time bound on both sides, live)</td><td class="mono"><code>${REGISTRY}</code></td></tr>
<tr><td>Registry v3 (12 Nov, audit fixes, Q-Day Drill)</td><td class="mono"><code>0x238A1D989c1f0561d4DD51d4B322C491A5cb1CD2</code></td></tr>
<tr><td>Registry v2 (9 to 12 Nov, devices, rotation, <code>verifyAnchor</code>)</td><td class="mono"><code>0x1854EeE2A659F4f39A05d5832cceC405E8045336</code></td></tr>
<tr><td>Registry v1 (9 Nov, anchors by account key)</td><td class="mono"><code>0xA73d4347b50C2A373533915d698Bf03a01c65aAF</code></td></tr>
<tr><td>Owner and agent account</td><td class="mono"><code>0xD6C6bDfBE567BcE731907789800205Df0B78ca52</code></td></tr>
</tbody></table></div>
<dl class="kv" style="margin-top:20px">
<dt>Sample record</dt><dd>Block ${SAMPLE.block} (${SAMPLE.sealed}), one 60-second clip recorded ${SAMPLE.recorded} by the test camera of our test computer: a test pattern with a burned-in clock and a test tone, both fingerprints (receipt v3), sealed within ${SAMPLE.within}. Files: <a href="${UP}${SAMPLE.clip}">clip</a> and <a href="${UP}${SAMPLE.receipt}">receipt</a>.</dd>
<dt>QoreWitness Verify SHA-256</dt><dd><code>${VERIFIER_SHA}</code><br><span class="small muted">Build it with <code>pnpm build:verifier</code> and compare.</span></dd>
<dt>Check a receipt in a terminal</dt><dd><code>pnpm tsx scripts/verify-receipt.ts ${SAMPLE.receipt} ${SAMPLE.clip}</code></dd>
<dt>Without our code</dt><dd><code>python3 tools/verify_receipt.py &lt;receipt&gt; &lt;file&gt;</code> (standard library only)</dd>
<dt>Run the tests</dt><dd><code>pnpm test</code> (${TESTS} automated tests on 25 Nov 2026)</dd>
</dl>
</div></section>

<section class="alt" id="pqc"><div class="wrap split">
<div><p class="eyebrow">Post-quantum on chain</p><h2>The contract checks the signature itself.</h2>
<p style="margin-top:16px">Two QoreChain precompiles do the work. Both are active on the testnet. They are not active on mainnet yet, so QoreWitness runs on the testnet only.</p>
<ul class="plain"><li><code>pqcVerify</code> at <code>0x…0A01</code> checks an ML-DSA-87 signature. Every state change in the registry needs a fresh signature.</li><li><code>pqcKeyStatus</code> at <code>0x…0A02</code> tells the contract if the owner key is registered and if possession is proven.</li></ul>
<p class="muted small">The audit notes map every call of a precompile to its tests.</p></div>
<div class="panel"><h3>Chain-level protection</h3><p style="margin:0">Every EVM transaction needs a registered ML-DSA-87 key and an EVM authorisation window. The agent opens a window that is scoped to the registry only. A stolen ECDSA key cannot anchor, register, revoke or rotate anything, even inside an open window.</p></div>
</div></section>

<section id="audit"><div class="wrap">
<div class="sec-head"><p class="eyebrow">Audit</p><h2>Four rounds with the QCAI Contract Auditor.</h2><p>Reviewed with an automated auditor. No firm has certified it. Each finding is mapped to a change, a test or a reason in the audit notes. The reports are copied to <code>docs/audit/</code>.</p></div>
<div class="tablewrap"><table><thead><tr><th scope="col">Stage</th><th scope="col">Date</th><th scope="col">Code</th><th scope="col">Setting</th><th scope="col">Score</th></tr></thead><tbody>
<tr><td>1</td><td>12 Nov 2026</td><td>registry v2</td><td>Ethereum (EVM/Solidity)</td><td>82</td></tr>
<tr><td>2</td><td>13 Nov 2026</td><td>registry v3</td><td>Ethereum (EVM/Solidity)</td><td>72</td></tr>
<tr><td>3</td><td>15 Nov 2026</td><td>registry v4</td><td>QoreChain (CosmWasm + PQC)</td><td>78</td></tr>
<tr><td>4</td><td>17 Nov 2026</td><td>registry v4, same input as stage 3</td><td>Ethereum (EVM/Solidity)</td><td>85</td></tr>
</tbody></table></div>
<p class="small muted">The QoreChain team advises the Ethereum setting for Solidity contracts. Stage 3 used another setting and flags Solidity as a mismatch. Compare stages 1, 2 and 4 with each other.</p>
</div></section>

<section class="alt"><div class="wrap">
<div class="sec-head"><p class="eyebrow">Drills</p><h2>We attack our own system and publish the result.</h2></div>
<ul class="grid c3">
<li class="tile"><h3>Q-Day Drill, dry run</h3><p>13 attacks with only the ECDSA key. 0 succeeded. See <a href="${GHDOC("TESTNET_FINDINGS.md")}">testnet findings</a>.</p></li>
<li class="tile"><h3>Custody drill</h3><p>10 attacks on the footage. All 5 attacks after sealing were rejected. 4 of 5 swaps before hashing were flagged. A swap with the camera's own settings was missed. See <a href="${GHDOC("CUSTODY_DRILL.md")}">the drill</a>.</p></li>
<li class="tile"><h3>Recovery drill</h3><p>The agent stops after the transaction is mined and before the receipt is written. After a restart, the receipt is rebuilt from public data and verifies (block 10,133,808).</p></li>
</ul>
<h3 style="margin:32px 0 10px">Known limits for the jury</h3>
<ul class="limits">
<li>Testnet only. The PQC precompiles are not active on mainnet yet. The public site presents this as a beta with one banner on every page.</li>
<li>The keys of the owner account sit on the recorder today. An agent-key mode is designed (<a href="${GHDOC("AGENT_KEY.md")}">notes</a>). A spike passed on the testnet. Relayed calls emit no EVM logs, so the mode waits.</li>
<li>Built: the installer, the setup in the browser, the dashboard with evidence export, QoreWitness Verify for the evidence file, and the sponsor service that pays the fees during the free beta. Planned: phone alerts, a ready-made Pi image and a Windows installer.</li>
<li>Tested end to end: the Linux installer. The Docker Compose route on NAS, Windows and macOS is documented, and we still have to test it on each platform.</li>
</ul>
</div></section>`,
});

/* ---------- go-live files ---------- */
if (live) {
  // Old shared preview links keep working: each /preview/<page>.html redirects to /<page>.html, and /preview/ to /.
  const prevDir = join(root, "preview");
  mkdirSync(prevDir, { recursive: true });
  const stub = (target, label) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QoreWitness has moved</title>
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0; url=${target}">
<link rel="canonical" href="${SITE}${target}">
</head>
<body>
<p>This page has moved. Go to <a href="${target}">${label}</a>.</p>
</body>
</html>
`;
  for (const f of PAGES) {
    const target = f === "index.html" ? "/" : `/${f}`;
    writeFileSync(join(prevDir, f), stub(target, f === "index.html" ? "the QoreWitness home page" : `${SITE.replace("https://", "")}${target}`));
  }
  // QoreWitness Verify: the file name stays verifier.html (built by scripts/build-verifier.mjs).
  const built = join(repo, "web", "verifier", "dist", "index.html");
  if (existsSync(built)) copyFileSync(built, join(root, "verifier.html"));
  else console.warn("web/verifier/dist/index.html is missing: run pnpm build:verifier first");
  const urls = ["", ...PAGES.filter((f) => f !== "index.html"), "verifier.html"];
  writeFileSync(join(root, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `<url><loc>${SITE}/${u}</loc></url>`).join("\n")}
</urlset>
`);
  writeFileSync(join(root, "robots.txt"), `User-agent: *
Allow: /
Disallow: /preview/
Disallow: /sponsor/

Sitemap: ${SITE}/sitemap.xml
`);
  console.log("wrote redirects, verifier.html, sitemap.xml, robots.txt");
}
