# AI usage

QoreWitness is built by one developer with Claude (Anthropic) as the coding assistant. This file records how AI was used, for the "Best AI-Native Build" award.

## Workflow

- The developer sets the goal, reviews every change and decides on design trade-offs.
- Claude researches the QoreChain docs, SDKs and Dev Fest rules, and writes a condensed developer reference.
- Claude writes contracts, TypeScript and tests. Every change runs through `pnpm test` and `pnpm typecheck` before commit.
- Claude probes the live testnet (precompile behaviour, return formats) with small scripts before it builds on an assumption. The results are in `docs/TESTNET_FINDINGS.md`.
- Security-relevant choices (immutable registry, monotonic windows, domain-separated messages, fail-closed precompile wrappers) are written down in the code comments and the README.

## Log

| Date | What AI did | What the developer did |
|---|---|---|
| 2026-11-08 | Research: QoreChain due diligence, Dev Fest rules, prior art on media timestamping, concept scoring | Chose the concept |
| 2026-11-09 | Developer reference from docs and npm. Live probes of `pqcVerify` and `pqcKeyStatus`. `AnchorRegistry`, `MerkleSha256`, `QorePqc`, mocks, 9 tests. Agent building blocks. | Review |
| 2026-11-09 (night) | `DeviceRegistry`, key rotation and `verifyAnchor` with 38 contract tests. Device key CLI, receipt v2, shared verify core, tamper demo. Deploy of registry v2 and live tests of every action on testnet. Agent bug fix (open window lost on restart). Q-Day Drill dry-run script and a throwaway drill account. Found that the SDK derives the ML-DSA key from the ECDSA key for seed-based accounts. | Set the task order and the rules. Added the SSH key. Rebuilt the repo history under the alias. Reviews the design choices. |
