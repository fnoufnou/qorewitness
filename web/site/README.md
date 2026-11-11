# Demo site

Static demo site for https://qorewitness.fnoufnou.com.

Files on the server: `index.html` (this folder), `verifier.html` (`pnpm build:verifier`), `demo-clip.mp4` and `demo-receipt.json`.

The demo clip is a generated test pattern (ffmpeg testsrc2, 20 s), anchored by device `demo-testpattern` on qorechain-diana, block 9,899,327. Verify it with:

```bash
pnpm tsx scripts/verify-receipt.ts demo-receipt.json demo-clip.mp4
```
