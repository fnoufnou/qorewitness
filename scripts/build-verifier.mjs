// Bundles web/verifier into one self-contained HTML file: web/verifier/dist/index.html
// The page carries a Content-Security-Policy with the hash of its own script: no other
// script runs, and it talks only to the QoreChain test network RPC.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const out = await build({
  entryPoints: ["web/verifier/main.ts"], bundle: true, format: "esm", platform: "browser",
  target: "es2022", minify: true, write: false, legalComments: "none",
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const hash = createHash("sha256").update(js, "utf8").digest("base64");
const csp = `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src https://evm-testnet.qore.host; base-uri 'none'; form-action 'none'`;
const html = readFileSync("web/verifier/index.html", "utf8")
  .replace("<meta charset=\"utf-8\">", () => `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${csp}">`)
  .replace("<script>/*BUNDLE*/</script>", () => `<script type="module">${js}</script>`);
if (!html.includes("Content-Security-Policy")) throw new Error("CSP meta not inserted");
mkdirSync("web/verifier/dist", { recursive: true });
writeFileSync("web/verifier/dist/index.html", html);
console.log(`web/verifier/dist/index.html ${(html.length / 1024).toFixed(0)} KB, sha256 ${createHash("sha256").update(html).digest("hex")}`);
