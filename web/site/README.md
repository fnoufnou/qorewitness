# Demo site

Static demo site for https://qorewitness.fnoufnou.com. Design rules: `docs/BRAND.md`.

Files on the server:

- `index.html` (this folder)
- `verifier.html`: copy of `web/verifier/dist/index.html` (`pnpm build:verifier`). Its SHA-256 is on the home page. Update the hash after every build.
- `favicon.svg`, `fonts/` (IBM Plex Sans and IBM Plex Mono, SIL Open Font License), `qorewitness-featured.png` (link preview image)
- `demo-clip.mp4` and `demo-receipt.json`

The demo clip is a generated test pattern (ffmpeg testsrc2, 20 s), anchored by device `demo-testpattern` on qorechain-diana, block 9,899,327. Verify it with:

```bash
pnpm tsx scripts/verify-receipt.ts demo-receipt.json demo-clip.mp4
```
