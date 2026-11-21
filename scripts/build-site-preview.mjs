#!/usr/bin/env node
// Builds the customer website pages (static HTML, no dependencies).
//
//   node scripts/build-site-preview.mjs          -> web/site/preview/*.html (noindex, links to ../ for shared files)
//   node scripts/build-site-preview.mjs --live   -> web/site/*.html (indexable, REPLACES web/site/index.html)
//
// Shared CSS and JS live in web/site/assets/. Fonts live in web/site/fonts/.
// Copy and facts are in this file. Edit here, then run the script again.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const live = process.argv.includes("--live");
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "site");
const outDir = live ? root : join(root, "preview");
const UP = live ? "" : "../"; // prefix for files that live in web/site/ (verifier, demo, fonts, assets)
mkdirSync(outDir, { recursive: true });

const SITE = "https://qorewitness.fnoufnou.com";
const GH = "https://github.com/fnoufnou/qorewitness";
const GHDOC = (f) => `${GH}/blob/main/docs/${f}`;
const X = "https://x.com/fnoufnou";
const DISCORD = "https://discord.gg/qorechain";
// TODO lead: pin a release tag instead of main before launch.
const INSTALL = 'ssh -t USER@qorewitness.local "curl -fsSL https://raw.githubusercontent.com/fnoufnou/qorewitness/main/install.sh | bash -s -- --yes"';
const VERIFIER_SHA = "a995b6e408847daa288aa41ec4e7d03e2ce85bd0088b77c297c9634c5b5eb623";
const REGISTRY = "0xa1378D6558B32e1f8d37b68cf90e3C93839Da365";

/* ---------- icons and art ---------- */
const defs = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
<symbol id="logo" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#17483A"/><circle cx="16" cy="16" r="8.5" fill="none" stroke="#fff" stroke-width="2.6"/><circle cx="16" cy="16" r="3" fill="#fff"/><circle cx="25.5" cy="6.5" r="3" fill="#E8663D"/></symbol>
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

function filmFrames(y, h, xs, w) {
  const f = "var(--frame)";
  const ink = "stroke=\"var(--frame-ink)\" stroke-width=\"3\" fill=\"none\" stroke-linecap=\"round\" stroke-linejoin=\"round\"";
  const [a, b, c] = xs;
  return `<rect x="${a}" y="${y}" width="${w}" height="${h}" rx="6" fill="${f}"/><rect x="${b}" y="${y}" width="${w}" height="${h}" rx="6" fill="${f}"/><rect x="${c}" y="${y}" width="${w}" height="${h}" rx="6" fill="${f}"/>
<g ${ink}><path d="M${a + 28} ${y + h - 20}V${y + 46}l${w / 2 - 28} -26 ${w / 2 - 28} 26V${y + h - 20}z"/><path d="M${a + w / 2 - 9} ${y + h - 20}v-22h18v22"/>
<path d="M${b + 14} ${y + h - 34}h${w - 28}M${b + 14} ${y + h - 20}h${w - 28}"/><rect x="${b + 28}" y="${y + 20}" width="${w - 56}" height="${h - 66}" rx="4"/>
<circle cx="${c + w - 38}" cy="${y + 32}" r="12"/><path d="M${c + 12} ${y + h - 18}l30 -34 24 22 18 -16 ${w - 100 > 0 ? 36 : 20} 28"/></g>`;
}

const heroArt = `<svg class="hero-art" viewBox="0 0 520 420" role="img" aria-labelledby="ha-t ha-d" xmlns="http://www.w3.org/2000/svg">
<title id="ha-t">A seal on a film strip and a green certificate card</title>
<desc id="ha-d">A film strip with three frames. A round pine seal is pressed on the middle frame. In front is a green card that says Original. It is labelled Demo clip.</desc>
<g transform="rotate(-5 260 100)">
  <rect x="-30" y="26" width="580" height="170" rx="10" fill="var(--strip)"/>
  ${Array.from({ length: 19 }, (_, i) => `<rect x="${-14 + i * 31}" y="34" width="16" height="10" rx="2" fill="var(--bg)"/><rect x="${-14 + i * 31}" y="178" width="16" height="10" rx="2" fill="var(--bg)"/>`).join("")}
  ${filmFrames(54, 114, [20, 190, 360], 140)}
  ${seal(262, 122, 50, { pulse: true })}
</g>
<g>
  <rect x="48" y="196" width="436" height="214" rx="12" fill="var(--bg)" stroke="var(--line)" stroke-width="1.5"/>
  <path d="M48 208a12 12 0 0 1 12-12h412a12 12 0 0 1 12 12v52H48z" fill="var(--ok-bg)"/>
  <circle cx="86" cy="228" r="16" fill="var(--ok)"/><path d="M78.500 228.500l5.500 5.500 10-11" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="114" y="226" font-family="var(--font)" font-size="20" font-weight="600" fill="var(--ok)">Original</text>
  <text x="114" y="247" font-family="var(--mono)" font-size="13.500" fill="var(--muted)">Demo clip. Not changed since sealing.</text>
  ${["Same file as when it was sealed", "Seal is valid", "Recorded on a public network"].map((t, i) => `<path d="M70 ${288 + i * 31}l5 5 9-10" fill="none" stroke="var(--ok)" stroke-width="2.600" stroke-linecap="round" stroke-linejoin="round"/><text x="98" y="${293 + i * 31}" font-family="var(--font)" font-size="17" fill="var(--fg)">${t}</text>`).join("")}
  <rect x="49" y="372" width="434" height="37" fill="var(--surface)"/><path d="M48 372h436" stroke="var(--line)"/>
  <text x="68" y="396" font-family="var(--mono)" font-size="14" fill="var(--muted)">Existed before 12 Nov 2026, 08:00</text>
</g></svg>`;

const artSeal = `<svg viewBox="0 0 240 130" aria-hidden="true" focusable="false"><rect x="6" y="28" width="228" height="74" rx="6" fill="var(--strip)"/>${Array.from({ length: 9 }, (_, i) => `<rect x="${14 + i * 25}" y="33" width="10" height="6" rx="1.500" fill="var(--bg)"/><rect x="${14 + i * 25}" y="91" width="10" height="6" rx="1.500" fill="var(--bg)"/>`).join("")}<rect x="16" y="44" width="62" height="42" rx="4" fill="var(--frame)"/><rect x="88" y="44" width="62" height="42" rx="4" fill="var(--frame)"/><rect x="160" y="44" width="62" height="42" rx="4" fill="var(--frame)"/>${seal(119, 66, 30)}</svg>`;
const artKeep = `<svg viewBox="0 0 240 130" aria-hidden="true" focusable="false"><rect x="30" y="26" width="150" height="92" rx="8" fill="var(--bg)" stroke="var(--line)" stroke-width="2"/><path d="M30 34l75 52 75-52" fill="none" stroke="var(--line)" stroke-width="2"/>${seal(105, 80, 17)}<g transform="translate(176 54)"><circle r="30" fill="var(--bg)" stroke="var(--brand)" stroke-width="2.500"/><circle r="23" fill="none" stroke="var(--brand)" stroke-width="1" stroke-dasharray="3 3"/><text x="0" y="-3" text-anchor="middle" font-family="var(--mono)" font-size="10" fill="var(--fg)">02:20</text><text x="0" y="9" text-anchor="middle" font-family="var(--mono)" font-size="8" fill="var(--muted)">RECORD</text><path d="M-40 18c10 -6 18 6 28 0s18 6 28 0 18 6 28 0" fill="none" stroke="var(--signal)" stroke-width="2" stroke-linecap="round"/></g></svg>`;
const artProve = `<svg viewBox="0 0 240 130" aria-hidden="true" focusable="false"><rect x="10" y="22" width="96" height="86" rx="8" fill="none" stroke="var(--muted)" stroke-width="2" stroke-dasharray="6 5"/><path d="M58 44v28M46 60l12 12 12-12" fill="none" stroke="var(--brand)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><text x="58" y="94" text-anchor="middle" font-family="var(--mono)" font-size="9" fill="var(--muted)">DROP FILES</text><rect x="122" y="22" width="108" height="86" rx="8" fill="var(--bg)" stroke="var(--line)" stroke-width="2"/><path d="M122 30a8 8 0 0 1 8-8h92a8 8 0 0 1 8 8v26h-108z" fill="var(--ok-bg)"/><circle cx="141" cy="42" r="9" fill="var(--ok)"/><path d="M136.500 42.300l3 3 5.500-6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><rect x="156" y="35" width="62" height="5" rx="2.500" fill="var(--ok)"/><rect x="156" y="45" width="40" height="4" rx="2" fill="var(--muted)" opacity=".5"/>${[68, 80, 92].map((y) => `<circle cx="138" cy="${y}" r="3.500" fill="var(--ok)"/><rect x="148" y="${y - 2}" width="${y === 80 ? 54 : 70}" height="4" rx="2" fill="var(--muted)" opacity=".5"/>`).join("")}</svg>`;
const artTamper = `<svg viewBox="0 0 240 130" aria-hidden="true" focusable="false">${seal(120, 65, 46, { bad: true })}</svg>`;

/* ---------- shared parts ---------- */
const NAV = [
  ["how-it-works.html", "How it works"],
  ["get-started.html", "Get started"],
  ["prove.html", "Prove a video"],
  ["plans.html", "Plans"],
  ["faq.html", "FAQ"],
];

function header(current) {
  return `<a class="skip" href="#main">Skip to content</a>
<header class="site-header"><div class="wrap bar">
<a class="brand" href="index.html" aria-label="QoreWitness home"><svg aria-hidden="true"><use href="#logo"/></svg>QoreWitness</a>
<span class="badge-pilot" title="QoreWitness runs on a test network. No payment is collected."><i></i>Testnet pilot</span>
<nav class="nav" aria-label="Main">${NAV.map(([h, t]) => `<a href="${h}"${h === current ? ' aria-current="page"' : ""}>${t}</a>`).join("")}</nav>
<a class="btn primary sm cta" href="prove.html#demo">Try the demo</a>
</div></header>`;
}

const footer = `<footer class="site-footer"><div class="wrap">
<div class="cols">
<div><a class="brand" href="index.html"><svg aria-hidden="true"><use href="#logo"/></svg>QoreWitness</a>
<p>Seal your camera footage. Prove later that nobody changed it.</p>
<p><b>QoreWitness will never ask for your passwords or files.</b></p></div>
<div><h2>Product</h2><ul><li><a href="how-it-works.html">How it works</a></li><li><a href="get-started.html">Get started</a></li><li><a href="daily-use.html">Daily use</a></li><li><a href="prove.html">Prove a video</a></li><li><a href="plans.html">Plans</a></li></ul></div>
<div><h2>Trust</h2><ul><li><a href="trust.html">Trust and limits</a></li><li><a href="faq.html">FAQ</a></li><li><a href="developers.html">For developers</a></li></ul></div>
<div><h2>Code</h2><ul><li><a href="${GH}">GitHub</a></li><li><a href="${UP}verifier.html">Verifier</a></li><li><a href="${X}">@fnoufnou on X</a></li><li><a href="${DISCORD}">QoreChain Discord</a></li></ul></div>
</div>
<div class="legal"><span>Testnet pilot. Both plans are free and no payment is collected. Records on the test network may be removed when it resets.</span><span>Open source under Apache-2.0. Built by fnoufnou. QoreWitness is not a TP-Link product and has no link with TP-Link. Tapo is a trademark of its owner.</span></div>
</div></footer>`;

function page({ file, title, desc, body, current }) {
  const robots = live ? "" : `<meta name="robots" content="noindex">\n`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="description" content="${desc}">
${robots}<meta name="theme-color" content="#17483A">
<meta name="color-scheme" content="light dark">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${SITE}/qorewitness-featured.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${UP}favicon.svg" type="image/svg+xml">
<link rel="preload" href="${UP}fonts/plex-sans.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${UP}assets/site.css">
</head>
<body>
${defs}
${header(current)}
<main id="main">
${body}
</main>
${footer}
<script src="${UP}assets/site.js" defer></script>
</body>
</html>
`;
  writeFileSync(join(outDir, file), html);
  console.log("wrote", join(live ? "web/site" : "web/site/preview", file));
}

const shot = (what) => `<figure class="shot"><div class="box" role="img" aria-label="Screenshot placeholder: ${what}">${ico("image")}<span>Screenshot: ${what}</span></div></figure>`;
const help = (title, inner) => `<details class="help"><summary>${title}</summary><div class="in">${inner}</div></details>`;
const copybox = (id, text, label = "Copy") => `<div class="copybox"><code id="${id}">${text}</code><button class="btn" type="button" data-copy="${id}" aria-label="${label} the text above">${ico("copy")}<span>${label}</span></button></div>`;
const head = (eyebrow, h1, lead, meta = []) => `<div class="page-head"><div class="wrap narrow-wrap"><p class="eyebrow">${eyebrow}</p><h1>${h1}</h1><p class="lead">${lead}</p>${meta.length ? `<ul class="meta">${meta.map((m) => `<li>${m}</li>`).join("")}</ul>` : ""}</div></div>`;
const closing = (h, p, href, label) => `<div class="band"><div class="wrap"><div><h2>${h}</h2><p>${p}</p></div><a class="btn primary" href="${href}">${label} ${ico("arrow")}</a></div></div>`;
const cert = (tag) => `<div class="cert" role="group" aria-label="Example result for the demo clip"><span class="tag">${tag}</span>
<div class="head">${ico("check-circle")}<div><b>Original</b><span>Not changed since it was sealed</span></div></div>
<ul>
<li><span>${ico("check")}Same file as when it was sealed</span></li>
<li><span>${ico("check")}Seal is valid</span></li>
<li><span>${ico("check")}Sealed 3 minutes after recording</span></li>
</ul><div class="foot">Existed before 12 Nov 2026, 08:00</div></div>`;

/* ---------- FAQ ---------- */
const FAQ = [
  ["Does my video leave my home?", `<p>No. Your video stays on your box at home. Only short fingerprints and times go to the public record. A fingerprint shows nothing about the picture or the sound.</p>`],
  ["What if my internet is down?", `<p>Recording goes on. Sealing needs the internet, so the minutes without a connection probably have no seal. The public record shows the gap with its start and length.</p><p>Nobody can fill the gap later with a backdated seal.</p>`],
  ["Is this crypto?", `<p>It uses a public record as a notary. You do not need to buy, hold or trade anything. During the pilot, the network fees are paid for you with test tokens that have no value.</p>`],
  ["What does it cost?", `<p>Free during the testnet pilot. No payment is collected.</p><p>Planned: about EUR 4 per camera per month (estimate). See <a href="plans.html">Plans</a>.</p>`],
  ["Will the police or a court accept it?", `<p>We cannot promise that. A court can accept a QoreWitness record, but it weighs it as ordinary evidence. We are not an EU qualified time stamp provider.</p><p>Pilot records show how the method works. They are not evidence yet. Ask a lawyer about your case.</p>`],
  ["Which cameras work?", `<p>We are testing the TP-Link Tapo C210 now. One other camera runs live today. We plan to publish a tested list and to grow it. We have no partnership with any camera maker.</p>`],
  ["What if I lose the box?", `<p>The seals on the public record stay. To prove a clip you also need the clip and its receipt. Press <b>Save evidence</b> in the dashboard for what matters to you, and keep that file somewhere else.</p>`],
  ["Can QoreWitness show that the scene was real?", `<p>No. It shows that the file did not change after it was sealed. A staged scene or a fake stream is sealed the same way as a real one.</p>`],
  ["Can someone fake a clip from inside my home network?", `<p>It is hard but not impossible. Someone who controls your box or your camera before sealing could feed it fake footage.</p><p>Keep the box and the camera on their own network. Use strong passwords. Read more on <a href="trust.html">Trust and limits</a>.</p>`],
  ["Who can see my clips?", `<p>Only you, on your box. A receipt shows fingerprints and times. It shows no picture and no sound.</p>`],
  ["How long are my clips kept?", `<p>The box deletes old clips after about 2 weeks. Receipts stay. Press <b>Save evidence</b> for any clip you may need before it is deleted.</p>`],
  ["What happens when the pilot ends?", `<p>The test network can be reset after 15 Dec 2026. A reset can remove pilot records.</p><p>When the main network opens, you would need to seal again. We plan to tell you before that happens and to guide you. We collect nothing from you until then.</p>`],
];
const faqItems = (list) => `<div class="faq">${list.map(([q, a]) => `<details><summary>${q}</summary><div class="in">${a}</div></details>`).join("")}</div>`;

/* ================= HOME ================= */
page({
  file: "index.html",
  current: "index.html",
  title: "QoreWitness: video evidence you can trust again",
  desc: "QoreWitness seals your home camera footage minutes after it is recorded. Later you can show anyone that the clip is the original. Testnet pilot, free to try.",
  body: `
<div class="hero"><div class="wrap">
<div>
<p class="eyebrow">Proof for home camera footage</p>
<h1>Video evidence you can trust again.</h1>
<p class="lead">QoreWitness seals your camera footage minutes after it is recorded. Later, you can show anyone that the clip is the original. Your video stays at home.</p>
<div class="btns"><a class="btn primary" href="get-started.html">Set up your Tapo C210 ${ico("arrow")}</a><a class="btn" href="prove.html#demo">Try the free demo</a></div>
<p class="fine">Testnet pilot. Free to try. No payment needed.</p>
</div>
${heroArt}
</div></div>

<section><div class="wrap">
<div class="sec-head"><p class="eyebrow">Why it matters</p><h2>Any video is easy to doubt now.</h2>
<p>After a break-in or an accident, people ask one question: did anyone change this video? A sealed clip can answer it.</p></div>
<ul class="grid c3">
<li class="tile top"><div class="ic">${ico("scale")}</div><h3>Be believed</h3><p>Show that your clip existed minutes after it was recorded and has not changed since.</p></li>
<li class="tile top"><div class="ic">${ico("lock")}</div><h3>Keep your privacy</h3><p>Your video stays at home. Only short fingerprints and times are kept on a public record.</p></li>
<li class="tile top"><div class="ic">${ico("eye")}</div><h3>Check it yourself</h3><p>Anyone can drop the file on a web page and see the result in their own browser. Nobody has to trust us.</p></li>
</ul>
</div></section>

<section class="alt" id="how"><div class="wrap">
<div class="sec-head"><p class="eyebrow">How it works</p><h2>Seal. Keep. Prove.</h2></div>
<ol class="grid c3" style="list-style:none;padding:0;margin:0">
<li class="tile"><div class="art">${artSeal}</div><h3>1. Seal</h3><p>Your camera records. Every 10 minutes, QoreWitness presses a digital seal on that footage. Change one pixel later and the seal no longer fits.</p></li>
<li class="tile"><div class="art">${artKeep}</div><h3>2. Keep</h3><p>The clips stay on your box at home. A small receipt file shows when the seal was recorded on the public record.</p></li>
<li class="tile"><div class="art">${artProve}</div><h3>3. Prove</h3><p>Press Save evidence. Send the one file. The other side drops it on a web page and sees a big green result.</p></li>
</ol>
<p class="small" style="margin-top:20px"><a href="how-it-works.html">Read how it works</a></p>
</div></section>

<section><div class="wrap">
<div class="sec-head"><p class="eyebrow">What you need</p><h2>A camera, a small box and a browser.</h2>
<p>Setup takes about one hour. You paste one line. The rest is clicks.</p></div>
<ul class="grid c3">
<li class="tile"><div class="ic">${ico("camera")}</div><h3>A TP-Link Tapo C210</h3><p>The camera we test first.</p></li>
<li class="tile"><div class="ic">${ico("box")}</div><h3>A small box that stays on</h3><p>A Raspberry Pi 5 with a USB SSD, or any always-on Linux computer.</p></li>
<li class="tile"><div class="ic">${ico("browser")}</div><h3>Any browser</h3><p>For setup, and for checking a clip.</p></li>
</ul>
<div class="btns" style="margin-top:28px"><a class="btn primary" href="get-started.html">Read the setup guide ${ico("arrow")}</a><a class="btn" href="plans.html">See the plans</a></div>
</div></section>

<section class="alt" id="status"><div class="wrap split">
<div class="sec-head"><p class="eyebrow">Status</p><h2>Early alpha, on a test network.</h2>
<p>Since 9 November 2026, a home camera has sealed its footage every 10 minutes. Open source. <a href="trust.html">See the facts and the limits</a>.</p></div>
<div class="panel"><span class="pill warn"><i></i>Testnet pilot</span>
<h3>Know the limits</h3>
<ul class="limits">
<li>It shows that a video has not changed since it was sealed. It cannot show that the scene was real.</li>
<li>A court weighs it as ordinary evidence.</li>
<li>Pilot records show how the method works. They are not evidence yet.</li>
</ul></div>
</div></section>
${closing("Seal your first clip today.", "It is free during the pilot. No payment is collected.", "get-started.html", "Start setup")}`,
});

/* ================= HOW IT WORKS ================= */
page({
  file: "how-it-works.html",
  current: "how-it-works.html",
  title: "How it works | QoreWitness",
  desc: "How QoreWitness seals camera footage: fingerprint, bundle, seal, record. Your video stays at home.",
  body: `
${head("How it works", "Your camera, now a witness.", "QoreWitness seals the video from your home camera within minutes of recording. Here is what happens, in plain words.")}
<section><div class="wrap narrow">
<h2>Your video stays at home.</h2>
<p style="margin-top:16px">The clips stay on your box. The public record gets only short fingerprints, the times and a seal. A fingerprint cannot show a picture or a sound.</p>
<div class="callout"><b class="t">Think of a letter</b>You press a wax seal on a letter. You keep the letter in a safe place. A postmark shows when it was sent. Anyone can look at the seal and the postmark. In QoreWitness the seal is digital. The postmark is the public record.</div>
</div></section>

<section class="alt"><div class="wrap">
<div class="sec-head"><p class="eyebrow">Four steps</p><h2>Fingerprint, bundle, seal, record.</h2>
<p>This runs on its own while your camera records.</p></div>
<ol class="grid c4" style="list-style:none;padding:0;margin:0">
<li class="tile"><div class="ic">${ico("finger")}</div><div class="num">01</div><h3>Fingerprint</h3><p>The box cuts the video into clips of one minute. Each clip gets a fingerprint. Change one byte and the fingerprint changes.</p></li>
<li class="tile"><div class="ic">${ico("layers")}</div><div class="num">02</div><h3>Bundle</h3><p>Every 10 minutes, the box bundles the fingerprints into one short summary. Each clip is also linked to the clip before it.</p></li>
<li class="tile"><div class="ic">${ico("sign")}</div><div class="num">03</div><h3>Seal</h3><p>Your camera has its own digital seal. It signs the summary. The seal is built to resist future quantum computers.</p></li>
<li class="tile"><div class="ic">${ico("chain")}</div><div class="num">04</div><h3>Record</h3><p>The public record checks the seal. If it fits, it stores the summary and the time. A receipt file stays with your clips.</p></li>
</ol>
</div></section>

<section><div class="wrap">
<div class="sec-head"><p class="eyebrow">The picture</p><h2>What goes where.</h2></div>
<ol class="flow">
<li class="home"><span class="tag">Stays at home</span><h3>Your camera</h3><p>A Tapo C210.</p></li>
<li class="home"><span class="tag">Stays at home</span><h3>Your box</h3><p>Records the clips. Makes the seal. Keeps clips and receipts.</p></li>
<li><h3>Public record</h3><p>Checks the seal. Stores the summary and the time. Holds no video.</p></li>
<li><h3>Any browser</h3><p>Takes your evidence file and repeats every check.</p></li>
</ol>
</div></section>

<section class="alt"><div class="wrap split">
<div><h2>What it cannot do</h2>
<ul class="limits" style="margin-top:16px">
<li>It cannot show that the scene was real. A staged scene is sealed the same way.</li>
<li>It cannot see what happens to the video before the box seals it. Keep the box and the camera safe.</li>
<li>It is not an EU qualified time stamp. A court weighs it as ordinary evidence.</li>
<li>On the testnet pilot, records may be removed when the network resets.</li>
</ul><p class="small"><a href="trust.html">Read Trust and limits</a></p></div>
<div>
<details><summary>Technical names</summary><div class="in">
<ul class="plain">
<li>Fingerprints: SHA-256 and SHA3-256, two independent functions.</li>
<li>The summary: a Merkle root of the fingerprints of a 10-minute window.</li>
<li>The seal: an ML-DSA-87 signature (NIST FIPS 204) by the camera key. Common signatures such as ECDSA and RSA may break when large quantum computers exist.</li>
<li>The public record: the AnchorRegistry smart contract on the QoreChain testnet. It checks the signature on chain before it stores the summary.</li>
</ul>
<p class="small" style="margin:0"><a href="developers.html">For developers</a></p></div></details>
</div>
</div></section>
${closing("Ready to seal your first clip?", "Setup takes about one hour. It is free during the pilot.", "get-started.html", "Get started")}`,
});

/* ================= GET STARTED ================= */
const railItems = [
  ["s1", "Make a camera account"],
  ["s2", "Find the camera address"],
  ["s3", "Prepare the box"],
  ["s4", "Paste one line"],
  ["s5", "Open the link"],
];
page({
  file: "get-started.html",
  current: "get-started.html",
  title: "Set up your Tapo C210 | QoreWitness",
  desc: "Step-by-step guide to seal the footage of a TP-Link Tapo C210 with QoreWitness. About one hour. Free during the testnet pilot.",
  body: `
${head("Get started", "Set up your Tapo C210.", "Five steps. You paste one line on your own computer. The rest is the Tapo app and your browser.", ["About 1 hour", "Free during the pilot"])}
<section><div class="wrap">
<div class="callout warn" style="margin-top:0"><b class="t">Guide status</b>We test this guide on a real C210 on 24 Nov 2026. Pictures come after that test. Last checked on a real camera: <b>not yet</b>.</div>
<div class="guide">
<aside class="rail" aria-label="Steps"><h2>Steps</h2><ol>${railItems.map(([id, t]) => `<li><a href="#${id}">${t}</a></li>`).join("")}</ol></aside>
<div>

<h2 style="margin-bottom:16px">What you need</h2>
<ul class="checks">
<li>${ico("check")}<span>A TP-Link Tapo C210, on your Wi-Fi, set up in the Tapo app.</span></li>
<li>${ico("check")}<span>A box that stays on: a Raspberry Pi 5 with a USB SSD, or any always-on Linux computer. Use 128 GB or more.</span></li>
<li>${ico("check")}<span>The camera, the box and your computer on the same home network.</span></li>
</ul>
<div class="callout"><b class="t">Aim the camera at your own property</b>If it films the street or a neighbour, privacy law may apply to you. Put up a sign. See <a href="trust.html#privacy">Trust and limits</a>.</div>

<ol class="steps" style="margin-top:36px">

<li class="step" id="s1"><h3>Make a camera account</h3><p class="time">3 minutes · Tapo app</p><div class="body">
<ol class="plain">
<li>Open the Tapo app and tap your camera.</li>
<li>Tap the gear icon (Settings).</li>
<li>Tap <b>Advanced Settings</b>, then <b>Camera Account</b>.</li>
<li>Agree to the notice.</li>
<li>Choose a user name and a password. Each has 6 to 32 characters.</li>
</ol>
<p>Use letters and digits only. Special characters can make the video fail. Write both down.</p>
${shot("the Tapo app screen Camera Account (hide the password)")}
</div></li>

<li class="step" id="s2"><h3>Find the camera address</h3><p class="time">2 minutes · Tapo app</p><div class="body">
<p>In the Tapo app, tap your camera, then the gear icon, then <b>Device Info</b>. Write down the <b>IP address</b>, for example <code>192.168.1.20</code>.</p>
${shot("the Tapo app Device Info screen with the IP address")}
${help("Tip: keep the address fixed", `<p>If your router gives the camera a new address, the box loses it. In your router, reserve the address for the camera. Search for your router model and "DHCP reservation".</p>`)}
</div></li>

<li class="step" id="s3"><h3>Prepare the box</h3><p class="time">15 minutes · Your computer</p><div class="body">
<p>For a Raspberry Pi 5:</p>
<ol class="plain">
<li>Install Raspberry Pi Imager and choose <b>Raspberry Pi OS Lite (64-bit)</b>.</li>
<li>In its settings, set the host name to <code>qorewitness</code>, choose a user name and password, enter your Wi-Fi (or use a cable) and turn on <b>SSH</b>.</li>
<li>Write the card, put it in the Pi and start it. Wait two minutes.</li>
</ol>
${shot("Raspberry Pi Imager with the settings for host name, user and SSH")}
${help("Another Linux computer", `<p>Use any 64-bit Debian or Ubuntu computer with internet access and a user with <code>sudo</code>. In step 4, paste only the part in quotes into its own terminal.</p>`)}
</div></li>

<li class="step" id="s4"><h3>Paste one line</h3><p class="time">10 minutes · Terminal on your computer</p><div class="body">
<p>Open a terminal on your own computer. On a Mac, open <b>Terminal</b>. On Windows, open <b>Terminal</b> or <b>PowerShell</b>.</p>
<p>Paste this line. Change <code>USER</code> to the user name you chose in step 3. Press Enter.</p>
${copybox("install-cmd", INSTALL, "Copy line")}
<p>The terminal asks once if you trust the box. Type <code>yes</code>. Then it asks for the password you chose in step 3. The installer does the rest. At the end it shows a <b>link</b> and a <b>code</b>.</p>
${shot("the terminal at the end of the install, with the link and the code")}
${help("Something wrong?", `<ul class="plain"><li><b>qorewitness.local not found.</b> Use the IP address of the box from your router app instead of <code>qorewitness.local</code>.</li><li><b>Permission denied.</b> Check the user name and password you chose in step 3.</li><li><b>Do not share the code.</b> Anyone with it can set up the box until you choose a password.</li><li>Want to read the script first? Open it on <a href="${GH}/blob/main/install.sh">GitHub</a>. You can run the line again at any time.</li></ul>`)}
</div></li>

<li class="step" id="s5"><h3>Open the link</h3><p class="time">15 minutes · Browser</p><div class="body">
<p>Open the link on your computer or phone and type the code. Three screens follow. Then a progress bar.</p>
<ol class="plain">
<li><b>Password.</b> Choose a password for the dashboard.</li>
<li><b>Camera.</b> Type the camera address from step 2 and the user name and password from step 1. Tick that the camera films your own property. Press <b>Test camera</b>.</li>
<li><b>Is this your camera?</b> You see a picture from your camera within 15 seconds. Press <b>Looks right</b>.</li>
</ol>
<p>A progress bar connects your camera. It takes a few minutes. You can close the page. Then you see <b>Sealing started</b>. The pilot pays the network fees. You do nothing.</p>
${shot("the screen Is this your camera? with a picture from the camera")}
<p>The first seal comes in about 10 to 15 minutes. Open the dashboard. The line turns green when sealing works. Save the dashboard address as a bookmark.</p>
${shot("the dashboard with the green line Sealing OK")}
<div class="callout ok"><b class="t">Done.</b>Keep using the Tapo app for live view and alerts. Read <a href="daily-use.html">Daily use</a>. To prove a clip, read <a href="prove.html">Prove a video</a>.</div>
${help("Something wrong?", `<ul class="plain"><li><b>The camera refused the password.</b> Make the camera account again with letters and digits only.</li><li><b>No camera answers.</b> Check the address in Device Info. Check that the camera is on.</li><li><b>The camera is busy, or sends no picture.</b> Close the live view in the Tapo app. Tapo Care, the microSD card and a recorder such as QoreWitness: only two of the three work at the same time. Turn one off.</li><li><b>The pilot is full.</b> The page says so and offers the other plan. See <a href="plans.html">Plans</a>.</li><li><b>You forgot the password.</b> Run the line in step 4 again with <code>--new-password</code> added after <code>--yes</code>.</li></ul>`)}
</div></li>
</ol>
</div>
</div>
</div></section>`,
});

/* ================= DAILY USE ================= */
page({
  file: "daily-use.html",
  current: "daily-use.html",
  title: "Daily use | QoreWitness",
  desc: "What changes in your day when QoreWitness runs: nothing. What the dashboard colours mean, how long clips are kept, and what to do after a power cut.",
  body: `
${head("Daily use", "Nothing changes in your day.", "Keep using the Tapo app for live view and alerts. QoreWitness works in the background. Open the dashboard once in a while.")}
<section><div class="wrap narrow">
<h2>The dashboard</h2>
<p style="margin-top:16px">It shows one line in a colour and one thing to do. Bookmark its address on your phone and laptop. On a Pi named <code>qorewitness</code> it often is <code>http://qorewitness.local:8080</code>.</p>
<div class="tablewrap"><table><thead><tr><th>Colour</th><th>It says</th><th>What to do</th></tr></thead><tbody>
<tr><td><b style="color:var(--ok)">Green</b></td><td>Sealing OK. Last seal 4 minutes ago.</td><td>Nothing.</td></tr>
<tr><td><b style="color:var(--warn)">Orange</b></td><td>Waiting for the first seal.</td><td>Nothing. It comes 10 to 15 minutes after setup.</td></tr>
<tr><td><b style="color:var(--warn)">Orange</b></td><td>Network fees low.</td><td>Nothing. The pilot tops up.</td></tr>
<tr><td><b style="color:var(--warn)">Orange</b></td><td>The disk is almost full.</td><td>Keep video for fewer days, or connect a bigger disk.</td></tr>
<tr><td><b style="color:var(--bad)">Red</b></td><td>No video from the camera.</td><td>Check the power and Wi-Fi of the camera.</td></tr>
<tr><td><b style="color:var(--bad)">Red</b></td><td>Sealing stopped 40 minutes ago.</td><td>Check the internet of the box. Restart the box if this stays.</td></tr>
</tbody></table></div>
${shot("the dashboard in green, orange and red state")}
${help("Self-managed plan: fee messages", `<p>With Self-managed you add free test tokens yourself. If the line says the network fees are low or ran out, add test QOR to the address shown. See <a href="plans.html">Plans</a>.</p>`)}
<p class="muted">Phone alerts are planned. Today you see these states when you open the dashboard.</p>
</div></section>

<section class="alt"><div class="wrap narrow">
<h2>Clips are kept for about 2 weeks</h2>
<p style="margin-top:16px">The box deletes old video after about 2 weeks. Receipts stay. A clip that is gone cannot be proven. <b>Press Save evidence</b> for any clip you may need. See <a href="prove.html#owner">Prove a video</a>.</p>
</div></section>

<section><div class="wrap narrow">
<h2>Power cuts and restarts</h2>
<ul class="plain" style="margin-top:16px">
<li><b>The box restarts.</b> Sealing starts again by itself.</li>
<li><b>The camera loses power.</b> No video is recorded while it is off. Earlier seals stay valid. The dashboard turns red until the camera is back.</li>
<li><b>The internet is down.</b> Recording goes on. The minutes without a connection probably have no seal. The public record shows the gap.</li>
</ul>
</div></section>

<section class="alt"><div class="wrap narrow">
<h2>Pause or remove</h2>
<ul class="plain" style="margin-top:16px">
<li>To pause, unplug the box. Your camera and the Tapo app keep working.</li>
<li>To remove QoreWitness, see <a href="developers.html#run">For developers</a>.</li>
<li>Records on the public record cannot be deleted. They hold only fingerprints and times.</li>
</ul>
${help("Advanced: back up the box", `<p>If the box breaks, you set it up again with a new camera. Seals made before stay checkable. To keep the same camera identity, copy the folder <code>~/qorewitness/data</code> to a USB stick. Anyone with these files can use your test account. QoreWitness never asks for them.</p>`)}
<div class="callout"><b class="t">Keep the box on your home network</b>Use a network you trust. Never forward port 8080 on your router.</div>
</div></section>
${closing("Need proof of a clip?", "Press Save evidence, send the file, and let the other side check it in a browser.", "prove.html", "Prove a video")}`,
});

/* ================= PROVE ================= */
const emailTpl = `Subject: Video evidence with proof of origin

Hello,

Attached is a file from my home camera. It holds the video and its proof.
The footage was sealed by QoreWitness minutes after recording.

To check it:
1. Open ${SITE}/verifier.html
2. Drop the file on the page.
3. The page shows a big green "Original" if the video has not changed since it was sealed.

You do not need to trust me or QoreWitness. The page repeats every check in your own browser.

Note: the video shows people. Please handle it with care.`;
page({
  file: "prove.html",
  current: "prove.html",
  title: "Prove a video | QoreWitness",
  desc: "How to prove that a video did not change: press Save evidence, send the one file, and let the receiver see a big green Original in a browser.",
  body: `
${head("Prove a video", "Show that a clip is the original.", "The owner sends one file. The receiver drops it on a web page and reads the result.")}
<section id="owner"><div class="wrap">
<div class="split">
<div>
<p class="eyebrow">For the owner</p><h2>Save evidence.</h2>
<ol class="plain" style="margin-top:16px">
<li>Open your dashboard.</li>
<li>Press <b>Download</b> next to the time you need. Or press <b>Save evidence</b> and pick a time range.</li>
<li>You get one file. Send it to the receiver, for example an insurer or a lawyer.</li>
</ol>
${shot("the dashboard with the Download button next to a time, and the Save evidence button")}
<p>Do this soon. The box deletes video after about 2 weeks.</p>
<div class="callout warn"><b class="t">Your video shows people</b>Send it only to people who need it. Do not post it in public.</div>
${help("Text you can send with the file", `<div class="copybox light"><code id="mail-tpl">${emailTpl}</code><button class="btn" type="button" data-copy="mail-tpl">${ico("copy")}<span>Copy text</span></button></div>`)}
</div>
<div id="demo" class="stack"><p class="eyebrow">For the receiver</p><h2 style="margin-bottom:16px">Check a video now.</h2>
<p>You received a file. You need no account and no software. Your file stays on your computer.</p>
<ol class="plain">
<li>Open the verifier.</li>
<li>Drop the file on the page.</li>
<li>Read the result. A big green <b>Original</b> means the video has not changed since it was sealed.</li>
</ol>
<div class="btns"><a class="btn primary" href="${UP}verifier.html">Open the verifier ${ico("arrow")}</a></div>
</div>
</div>
</div></section>

<section class="alt"><div class="wrap">
<div class="split">
<div class="stack"><h2>What the result looks like</h2>
${cert("Example result · demo clip")}
<div class="cert bad"><span class="tag">Example result · video changed</span><div class="head">${ico("x-circle")}<div><b>Changed after sealing</b><span>This file does not match its receipt</span></div></div></div>
<p class="small muted">An orange result means unchanged, with notes. The page says what the notes are. A button prints the result.</p></div>
<div><h3 style="margin-bottom:10px">Try it with the demo clip</h3>
<p>The demo clip is a generated test pattern. Download both files and drop them on the verifier. Then use its button to change one byte and check again. The result turns red.</p>
<div class="btns"><a class="btn" href="${UP}demo-clip.mp4" download>Demo clip</a><a class="btn" href="${UP}demo-receipt.json" download>Demo receipt</a></div>
<h3 style="margin:32px 0 10px">What a green result means</h3>
<ul class="checks"><li>${ico("check")}<span>The file existed at the time of the public record.</span></li><li>${ico("check")}<span>It has not changed since it was sealed.</span></li><li>${ico("check")}<span>One known camera made the seal.</span></li></ul>
<h3 style="margin:24px 0 10px">What it does not mean</h3>
<ul class="checks no"><li>${ico("x")}<span>That the scene was real. A staged scene is sealed the same way.</span></li><li>${ico("x")}<span>That a court will accept it. A court weighs it as ordinary evidence.</span></li></ul>
<p class="small"><a href="trust.html">Read Trust and limits</a></p></div>
</div>
<div class="art" style="max-width:220px;margin:32px 0 0">${artTamper}</div>
<p class="small muted">A red result is a cracked seal. Nobody has to trust the owner or us. The code is open.</p>
</div></section>`,
});

/* ================= PLANS ================= */
page({
  file: "plans.html",
  current: "plans.html",
  title: "Plans | QoreWitness",
  desc: "Fees included is the default plan. Testnet pilot: both plans are free. No payment is collected.",
  body: `
${head("Plans", "Fees included. Nothing to manage.", "Same seal. Same proof page. We look after the network fees for you.")}
<section style="padding-top:32px"><div class="wrap">
<div class="banner" role="note"><b>Testnet pilot: both plans are free. No payment is collected.</b> We ask for no card.</div>
<div class="plans" style="grid-template-columns:minmax(0,1fr)">
<article class="plan feature" aria-labelledby="p-fees" id="fees">
<h2 id="p-fees">Fees included</h2><p class="for">For people who want it to just work.</p>
<p class="price">Free during the pilot.<small>Planned: about EUR 4 per camera per month (estimate). The price can change. One plan per camera.</small></p>
<ul class="plain" style="margin-top:16px"><li>Everything works after the setup. You do nothing about fees.</li><li>The pilot lets the first cameras in, up to a limit. The setup tells you if the pilot is full.</li><li>No wallet to set up and no tokens to buy.</li></ul>
<div class="push"><a class="btn primary" href="get-started.html">Get started ${ico("arrow")}</a></div>
</article>
${help("Self-managed: for people with their own wallet", `<p><b>Free software. Always.</b> You hold your own account and pay the network fees yourself, with your own QoreChain wallet.</p><ul class="plain"><li>During the pilot, you get free test tokens from the faucet. About 0.1 test token per seal.</li><li>Later, you buy tokens for the fees.</li><li>If you lose your keys and have no backup, nobody can recover them for you.</li></ul><p>You choose this plan in the setup when you want it. It makes the same proof.</p>`)}
</div>
<p class="small muted">Plans and prices can change before the main network opens. We will ask before we charge anything. If we stop the pilot, you can switch to Self-managed.</p>
</div></section>`,
});

/* ================= FAQ ================= */
page({
  file: "faq.html",
  current: "faq.html",
  title: "FAQ | QoreWitness",
  desc: "Answers to the twelve most common questions about QoreWitness: privacy, cost, cameras, courts, and what happens when the pilot ends.",
  body: `
${head("FAQ", "Questions people ask.", "Short, honest answers. If your question is not here, ask on X or in the QoreChain Discord.")}
<section><div class="wrap narrow">${faqItems(FAQ)}
<div class="callout" style="margin-top:32px"><b class="t">Another question?</b>Message <a href="${X}">@fnoufnou on X</a> or write in the <a href="${DISCORD}">QoreChain Discord</a>.</div>
</div></section>
${closing("Ready to try it?", "Free during the testnet pilot.", "get-started.html", "Get started")}`,
});

/* ================= TRUST ================= */
page({
  file: "trust.html",
  current: "trust.html",
  title: "Trust and limits | QoreWitness",
  desc: "What QoreWitness proves, what it cannot prove, who could attack it, how it was reviewed, and what happens if the test network resets.",
  body: `
${head("Trust and limits", "What it proves, and what it cannot.", "A proof is only as good as what goes into it. Here is the plain list. We publish what we catch and what we miss.")}
<section><div class="wrap split">
<div><h2>What it proves</h2>
<ul class="checks" style="margin-top:16px">
<li>${ico("check")}<span>This file existed at the time of the network record. It was sealed within minutes of recording.</span></li>
<li>${ico("check")}<span>It has not changed since it was sealed.</span></li>
<li>${ico("check")}<span>The seal was made with the key of one known camera.</span></li>
<li>${ico("check")}<span>The clip sits in an unbroken recording. A removed, inserted or re-ordered clip shows. A gap in recording shows with its start and length.</span></li>
<li>${ico("check")}<span>The time is bounded on both sides. The seal was made after a recent block and recorded before a later block.</span></li>
</ul></div>
<div><h2>What it cannot prove</h2>
<ul class="checks no" style="margin-top:16px">
<li>${ico("x")}<span>That the scene was real. A staged scene or a fake stream is sealed the same way.</span></li>
<li>${ico("x")}<span>Who recorded it. It shows which camera key signed.</span></li>
<li>${ico("x")}<span>That nobody fed the box fake footage before sealing. The box is the trust boundary.</span></li>
<li>${ico("x")}<span>That a court accepts it. We are not an EU qualified time stamp provider. A court weighs it as ordinary evidence.</span></li>
</ul></div>
</div></section>

<section id="facts"><div class="wrap">
<div class="sec-head"><p class="eyebrow">Facts you can check</p><h2>Only what we can show today.</h2>
<p>Each item links to its proof. We show no logos, no customer counts and no reviews, because we have none.</p></div>
<ul class="grid c2" style="list-style:none;padding:0;margin:0">
<li class="tile"><h3>Open source</h3><p>All code is open under Apache-2.0. <a href="${GH}">Read it on GitHub</a>.</p></li>
<li class="tile"><h3>Reviewed with the QCAI Contract Auditor</h3><p>Four review rounds on QoreChain. The reports are published. <a href="${GHDOC("AUDIT.md")}">Read the audit notes</a>.</p></li>
<li class="tile"><h3>Checked on chain</h3><p>The smart contract checks the ML-DSA-87 signature on QoreChain before it accepts a record. <a href="developers.html#pqc">See how</a>.</p></li>
<li class="tile"><h3>A live pilot camera</h3><p>A real home camera has sealed its footage every 10 minutes on the testnet since 9 Nov 2026.</p></li>
<li class="tile"><h3>A verifier in one file</h3><p>The verifier runs in your browser. It is one HTML file with a published fingerprint (SHA-256). <a href="${UP}verifier.html">Open the verifier</a>.</p></li>
<li class="tile"><h3>We publish what we miss</h3><p>Our own attack drills list what the system catches and what it does not. <a href="#threats">Read the results</a>.</p></li>
</ul>
</div></section>

<section class="alt" id="threats"><div class="wrap">
<div class="sec-head"><p class="eyebrow">Threat model, summary</p><h2>Who could attack it, and what happens.</h2>
<p>We ran drills on the live system. Results are from our own tests. No outside firm ran them. Read the full texts: <a href="${GHDOC("THREAT_MODEL.md")}">threat model</a> and <a href="${GHDOC("CUSTODY_DRILL.md")}">custody drill</a>.</p></div>
<div class="tablewrap"><table><thead><tr><th>Attack</th><th>Result</th><th>Why</th></tr></thead><tbody>
<tr><td>Change one byte of a sealed clip</td><td><b>Detected</b></td><td>The file fingerprint is no longer in the receipt.</td></tr>
<tr><td>Remove or re-order a clip in the receipt</td><td><b>Detected</b></td><td>The chain of clips breaks.</td></tr>
<tr><td>Seal a second version of an old window</td><td><b>Refused</b></td><td>The contract refuses overlapping windows.</td></tr>
<tr><td>Swap in footage from another camera, re-encode, delete or add a clip before sealing</td><td><b>Flagged</b></td><td>The record shows a stream change, a gap or an overlap. In our drill, 4 of 5 such attacks were flagged.</td></tr>
<tr><td>Swap in footage that uses the camera's own settings, before sealing</td><td><b>Missed</b></td><td>The box cannot tell. This is the trust boundary.</td></tr>
<tr><td>Steal the box</td><td>Risk</td><td>The box holds your camera key and, today, the keys of your test account. Keep the box safe. A mode that keeps the main key offline is planned.</td></tr>
<tr><td>An attacker with only the classic (ECDSA) key of the account</td><td><b>Failed</b></td><td>In a dry run of the Q-Day Drill, 13 attacks failed and 0 succeeded. Every change needs a fresh post-quantum signature.</td></tr>
</tbody></table></div>
</div></section>

<section><div class="wrap split">
<div><h2>How it was reviewed</h2>
<p style="margin-top:16px">We reviewed the smart contract in four rounds with the QCAI Contract Auditor on the QoreChain dashboard, from 12 to 17 Nov 2026. Each finding is mapped to a fix, a test or a reason. The reports are published.</p>
<p>These are automated reviews. No accredited security firm has audited QoreWitness.</p>
<p><a href="${GHDOC("AUDIT.md")}">Read the audit notes</a></p></div>
<div><h2>Open source</h2>
<p style="margin-top:16px">All code is open under Apache-2.0. You can read it, run it and rebuild the verifier. The verifier is one HTML file. Its fingerprint (SHA-256) is published.</p>
<p><a href="${GH}">GitHub</a> · <a href="developers.html">For developers</a></p></div>
</div></section>

<section class="alt"><div class="wrap narrow">
<h2>Testnet pilot: what can go wrong</h2>
<ul class="limits" style="margin-top:16px">
<li><b>The test network can reset.</b> The QoreChain team says it will not reset before 15 Dec 2026. After that, a reset can remove every pilot record.</li>
<li><b>Pilot records are not evidence yet.</b> They show how the method works.</li>
<li><b>Fees included depends on us.</b> The pilot operator (fnoufnou) pays the fees with test tokens. The service can stop. You can then switch to Self-managed.</li>
<li><b>The main network is not live for this yet.</b> The post-quantum checks run on the testnet today. When the main network opens, you would need to seal again.</li>
</ul>
</div></section>

<section id="privacy"><div class="wrap">
<div class="sec-head"><p class="eyebrow">Privacy</p><h2>What leaves your home.</h2>
<p>This is a summary and not legal advice. It reflects the GDPR (AVG) as we understand it.</p></div>
<div class="tablewrap"><table><thead><tr><th>Part</th><th>Data</th><th>Our rule</th></tr></thead><tbody>
<tr><td>Your box</td><td>Video of people at and near your home. Camera address and camera password.</td><td>Video stays on the box. We never receive it. The box sends no usage data to us.</td></tr>
<tr><td>Public network</td><td>Account address, camera id, times and fingerprints.</td><td>Fixed rhythm. Fingerprints show no content. We use no names or addresses as labels.</td></tr>
<tr><td>Public network node</td><td>The IP address of your box can be seen by the node it talks to.</td><td>Known limit.</td></tr>
<tr><td>This website</td><td>Your IP address in server logs.</td><td>No trackers. No email is collected in the pilot.</td></tr>
</tbody></table></div>
<ul class="plain">
<li>Records on a public network cannot be deleted. Keep names and addresses out of camera labels.</li>
<li>A fingerprint of a video with people in it may count as personal data in some cases. We keep everything else off the chain.</li>
</ul>
<div class="callout warn"><b class="t">If your camera films the street or a neighbour</b>The household exemption likely does not apply then (CJEU, case C-212/13, Rynes). You are the controller of that video. Aim the camera at your own property. Put up a sign. Read the guidance on home cameras from your data protection authority. In the Netherlands this is the <a href="https://www.autoriteitpersoonsgegevens.nl">Autoriteit Persoonsgegevens</a>.</div>
<p><b>QoreWitness will never ask for your passwords or files.</b></p>
</div></section>`,
});

/* ================= DEVELOPERS ================= */
page({
  file: "developers.html",
  current: "developers.html",
  title: "For developers | QoreWitness",
  desc: "Architecture, contract addresses, post-quantum checks on chain, audit rounds and drills for QoreWitness on the QoreChain testnet qorechain-diana.",
  body: `
${head("For developers and the jury", "QoreWitness on QoreChain.", "Post-quantum evidence anchoring for home cameras. Entered in the QoreChain Developer Fest, Post-Quantum dApp category, under the alias fnoufnou. Testnet only.", ["Open source, Apache-2.0", "Network: qorechain-diana (EVM chain ID 9800)"])}
<section><div class="wrap">
<div class="btns"><a class="btn primary" href="${GH}">GitHub ${ico("arrow")}</a><a class="btn" href="${GHDOC("SPEC.md")}">Spec</a><a class="btn" href="${GHDOC("AUDIT.md")}">Audit</a><a class="btn" href="${GHDOC("CUSTODY_DRILL.md")}">Custody drill</a><a class="btn" href="${GHDOC("THREAT_MODEL.md")}">Threat model</a><a class="btn" href="${UP}verifier.html">Verifier</a></div>
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
<div class="tablewrap"><table><thead><tr><th>Key</th><th>Holder</th><th>Signs</th><th>Checked by</th></tr></thead><tbody>
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
<li><b>Install on the box itself:</b> <code>curl -fsSL https://raw.githubusercontent.com/fnoufnou/qorewitness/main/install.sh | bash -s -- --yes</code>. Options: <code>--local-only</code>, <code>--new-password</code>, <code>--terminal</code> (setup with questions in the terminal), <code>--build</code>. See <a href="${GHDOC("INSTALL.md")}">INSTALL.md</a>.</li>
<li><b>Other camera brands:</b> with <code>--terminal</code> you can give a full stream URL, for example <code>rtsp://user:password@192.168.1.20:554/stream</code>. The product is built and tested for the Tapo C210. See <a href="${GHDOC("CAMERAS.md")}">CAMERAS.md</a>.</li>
<li><b>Update:</b> set the new version in <code>~/qorewitness/.env</code> (<code>QW_VERSION</code>), then <code>docker compose pull &amp;&amp; docker compose up -d</code>. The version is pinned and QoreWitness never updates itself.</li>
<li><b>Back up:</b> copy <code>~/qorewitness/data</code>, at least <code>qorewitness.env</code> and <code>keys</code>. Anyone with these files can use the test account.</li>
<li><b>Remove:</b> <code>cd ~/qorewitness &amp;&amp; docker compose down</code>, then delete <code>~/qorewitness</code>.</li>
</ul>
</div></section>

<section id="contracts"><div class="wrap">
<div class="sec-head"><p class="eyebrow">Contracts</p><h2>Addresses on qorechain-diana.</h2><p>Explorer: <a href="https://explore.qore.network">explore.qore.network</a> (testnet).</p></div>
<div class="tablewrap"><table><thead><tr><th>What</th><th>Address</th></tr></thead><tbody>
<tr><td><b>Registry v4</b> (14 Nov, chained windows, time bound on both sides, live)</td><td class="mono"><code>${REGISTRY}</code></td></tr>
<tr><td>Registry v3 (12 Nov, audit fixes, Q-Day Drill)</td><td class="mono"><code>0x238A1D989c1f0561d4DD51d4B322C491A5cb1CD2</code></td></tr>
<tr><td>Registry v2 (9 to 12 Nov, devices, rotation, <code>verifyAnchor</code>)</td><td class="mono"><code>0x1854EeE2A659F4f39A05d5832cceC405E8045336</code></td></tr>
<tr><td>Registry v1 (9 Nov, anchors by account key)</td><td class="mono"><code>0xA73d4347b50C2A373533915d698Bf03a01c65aAF</code></td></tr>
<tr><td>Owner and agent account</td><td class="mono"><code>0xD6C6bDfBE567BcE731907789800205Df0B78ca52</code></td></tr>
</tbody></table></div>
<dl class="kv" style="margin-top:20px">
<dt>Demo record</dt><dd>Block 10,120,133, camera <code>demo-testpattern</code>, a generated test pattern with both fingerprints (receipt v3).</dd>
<dt>Verifier SHA-256</dt><dd><code>${VERIFIER_SHA}</code><br><span class="small muted">Build it with <code>pnpm build:verifier</code> and compare.</span></dd>
<dt>Check a receipt in a terminal</dt><dd><code>pnpm tsx scripts/verify-receipt.ts demo-receipt.json demo-clip.mp4</code></dd>
<dt>Without our code</dt><dd><code>python3 tools/verify_receipt.py &lt;receipt&gt; &lt;file&gt;</code> (standard library only)</dd>
<dt>Run the tests</dt><dd><code>pnpm test</code> (76 automated tests on 21 Nov 2026)</dd>
</dl>
</div></section>

<section class="alt" id="pqc"><div class="wrap split">
<div><p class="eyebrow">Post-quantum on chain</p><h2>The contract checks the signature itself.</h2>
<p style="margin-top:16px">Two QoreChain precompiles do the work. Both are active on the testnet. They are not active on mainnet yet, so QoreWitness runs on the testnet only.</p>
<ul class="plain"><li><code>pqcVerify</code> at <code>0x…0A01</code> checks an ML-DSA-87 signature. Every state change in the registry needs a fresh signature.</li><li><code>pqcKeyStatus</code> at <code>0x…0A02</code> tells the contract if the owner key is registered and if possession is proven.</li></ul>
<p class="muted small">The audit notes map every call of a precompile to its tests.</p></div>
<div class="panel"><h3>Chain-level protection</h3><p style="margin:0">Every EVM transaction needs a registered ML-DSA-87 key and an EVM authorisation window. The agent opens a window that is scoped to the registry only. A stolen ECDSA key cannot anchor, register, revoke or rotate anything, even inside an open window.</p></div>
</div></section>

<section><div class="wrap">
<div class="sec-head"><p class="eyebrow">Audit</p><h2>Four rounds with the QCAI Contract Auditor.</h2><p>Reviewed with an automated auditor. No firm has certified it. Each finding is mapped to a change, a test or a reason in the audit notes. The reports are copied to <code>docs/audit/</code>.</p></div>
<div class="tablewrap"><table><thead><tr><th>Stage</th><th>Date</th><th>Code</th><th>Setting</th><th>Score</th></tr></thead><tbody>
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
<li>Testnet only. The PQC precompiles are not active on mainnet yet.</li>
<li>The keys of the owner account sit on the recorder today. An agent-key mode is designed (<a href="${GHDOC("AGENT_KEY.md")}">notes</a>). A spike passed on the testnet. Relayed calls emit no EVM logs, so the mode waits.</li>
<li>The installer, the setup in the browser, the dashboard and the pilot top-up service are built. The evidence ZIP export, phone alerts, a Windows installer and a ready-made Pi image are planned.</li>
</ul>
</div></section>`,
});
