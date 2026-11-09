// Bundles web/verifier into one self-contained HTML file: web/verifier/dist/index.html
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const out = await build({
  entryPoints: ["web/verifier/main.ts"], bundle: true, format: "esm", platform: "browser",
  target: "es2022", minify: true, write: false, legalComments: "none",
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = readFileSync("web/verifier/index.html", "utf8").replace("<script>/*BUNDLE*/</script>", `<script type="module">${js}</script>`);
mkdirSync("web/verifier/dist", { recursive: true });
writeFileSync("web/verifier/dist/index.html", html);
console.log(`web/verifier/dist/index.html ${(html.length / 1024).toFixed(0)} KB`);
