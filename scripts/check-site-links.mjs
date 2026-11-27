#!/usr/bin/env node
// Checks the live site in web/site/: every internal link and asset on every page resolves to a file,
// every #anchor exists, and no live page has noindex.
//   node scripts/check-site-links.mjs
// Files that exist only on the server (see web/site/README.md) are allowed to be missing.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web", "site");
const SITE = "https://qorewitness.fnoufnou.com";
// Files that live on the server only (not in the repo). demo-* are the old sample links, kept working.
const SERVER_ONLY = new Set(["sample-clip.mp4", "sample-receipt.json", "demo-clip.mp4", "demo-receipt.json"]);
// Pages that are meant to be noindex: the redirect stubs for old shared links.
const NOINDEX_OK = (rel) => rel.startsWith("preview/");
const SKIP_DIRS = new Set(["assets", "fonts"]);

const pages = [];
(function walk(dir) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(n)) walk(p);
    } else if (n.endsWith(".html")) pages.push(p);
  }
})(root);

const problems = [];
const idsCache = new Map();
const idsOf = (file) => {
  if (!idsCache.has(file)) idsCache.set(file, new Set([...readFileSync(file, "utf8").matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])));
  return idsCache.get(file);
};

for (const page of pages) {
  const rel = relative(root, page);
  const html = readFileSync(page, "utf8");
  if (!NOINDEX_OK(rel) && /<meta[^>]+name="robots"[^>]*noindex/i.test(html)) problems.push(`${rel}: has noindex`);
  const base = /<base href="([^"]+)"/.exec(html)?.[1];
  const refs = [...html.replace(/<base [^>]*>/g, "").matchAll(/\b(?:href|src)="([^"]*)"/g)].map((m) => m[1]);
  refs.push(...[...html.matchAll(/content="\d+;\s*url=([^"]+)"/g)].map((m) => m[1]));
  refs.push(...[...html.matchAll(/url\(["']?([^)"']+)["']?\)/g)].map((m) => m[1]));
  for (let ref of new Set(refs)) {
    if (!ref || /^(mailto:|tel:|data:|javascript:)/.test(ref)) continue;
    if (/^https?:\/\//.test(ref)) {
      if (!ref.startsWith(SITE)) continue;
      ref = ref.slice(SITE.length) || "/";
    } else if (ref.startsWith("//")) continue;
    let [path, hash] = ref.split("#");
    path = path.split("?")[0];
    let file;
    if (path === "") file = page;
    else if (path.startsWith("/")) file = join(root, path);
    else file = resolve(base ? resolve(dirname(page), base) : dirname(page), path);
    if (!file.startsWith(root)) { problems.push(`${rel}: ${ref} leaves web/site`); continue; }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) {
      if (SERVER_ONLY.has(relative(root, file))) continue;
      problems.push(`${rel}: missing ${ref}`);
      continue;
    }
    if (hash && file.endsWith(".html") && !idsOf(file).has(hash)) problems.push(`${rel}: no #${hash} in ${relative(root, file)}`);
  }
  // live pages need a canonical link and the social image
  if (!NOINDEX_OK(rel) && !/rel="canonical"/.test(html)) problems.push(`${rel}: no canonical link`);
  if (!NOINDEX_OK(rel) && !html.includes(`og:image" content="${SITE}/qorewitness-featured.png"`)) problems.push(`${rel}: no og:image`);
}
for (const f of ["sitemap.xml", "robots.txt", "favicon.svg", "qorewitness-featured.png", "verifier.html"]) {
  if (!existsSync(join(root, f))) problems.push(`missing ${f}`);
}
console.log(`${pages.length} pages checked`);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("ok: all internal links and assets resolve, no live page has noindex");
