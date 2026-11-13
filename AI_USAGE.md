# AI usage

QoreWitness is an AI-native build. One developer (fnoufnou) leads the project as product owner, architect and operator. Claude (Anthropic) works as the engineering agent: it researches, writes code and tests, runs live checks and keeps the project tracker. This file records who did what, for the "Best AI-Native Build" award.

## Division of work

| Area | Developer (fnoufnou) | Claude |
|---|---|---|
| Product | Defined the problem: home camera footage as evidence that holds up years later. Chose the concept from a scored shortlist. Chose one focused entry in Post-Quantum dApp. Set the product bar: evidence that can be replayed in court with third-party tools, a public demo, an installer that others can use. Set the identity: enterprise grade, early alpha. | Researched the chain, the rules and prior art. Scored the concepts. Turned the product bar into tasks. |
| Architecture | Decides on every design trade-off that Claude puts forward: separate camera keys, immutable registry, scoped EVM window, revoke as a final step. Asked for versioned, reproducible receipts and for the comparison with OpenTimestamps. | Proposes designs with their trade-offs. Writes contracts, agent, verifiers and tests. |
| Infrastructure | Runs the home stack: Proxmox host, dev container, 100 GB evidence volume, camera network and the live LSC camera. Runs the domain and web hosting for the demo site. Manages SSH and deploy keys. | Builds and deploys over SSH with session keys that the developer grants and revokes. |
| Chain and event | Owns the wallets and the registered address. Registered for the fest, claims faucet funds, runs the project page and the Q-Day Drill registration. Puts the questions to the organisers and brings back their answers (rubric, audit process, reset policy). | Drafts the questions. Runs the testnet deploys, the QCAI audits and the drill dry run. Logs every finding. |
| Security and privacy | Set the rules: testnet only, no recovery phrases to the AI, keys only in ignored files, public work only under the alias. Rebuilt the repository history under the alias with a new deploy key. | Follows the rules. Flags risks, for example the SDK deriving the ML-DSA key from the ECDSA key. |
| Quality | Reviews every change and the daily review list. Accepts or rejects. | Runs `pnpm test` and `pnpm typecheck` before every commit. Probes the live testnet before it builds on an assumption. |
| Community | Posts the build-in-public updates and handles Discord. | Drafts the posts. Reads the channels (read only). |

## Workflow

1. The developer sets goals, priorities and rules, once or twice a day.
2. Claude turns them into tasks in the project tracker, builds, tests and deploys. Results and open decisions go into a short review list.
3. The developer reviews, decides and does the steps that need his accounts, hardware or identity.
4. Security-relevant choices are written down in the code comments, the README and `docs/`.

## Log

| Date | What the developer did | What Claude did |
|---|---|---|
| 2026-11-08 | Set the goal: a fest entry next to the validator plan. Chose QoreWitness from the shortlist. | Due diligence on QoreChain, Dev Fest rules, prior art on media timestamping, concept scoring. |
| 2026-11-09 | Chose one entry and the category. Registered for the fest (GitHub, X, QoreX testnet address). Claimed the faucet. Provided the home server, storage and cameras, and checked the camera models. Created the public repository. | Developer reference from docs and npm. Live probes of `pqcVerify` and `pqcKeyStatus`. `AnchorRegistry`, Merkle core, first tests. Agent, recorder and first live anchors. |
| 2026-11-09 (night) | Set the task order and the rules for unattended work. Rebuilt the repository history under the alias with a new deploy key. Granted SSH access. Reviewed the device-key design. | `DeviceRegistry`, key rotation, `verifyAnchor`, 38 tests. Receipt v2, shared verify core, tamper demo. Registry v2 deployed and every action tested live. Agent fix. Q-Day Drill dry run. |
| 2026-11-10 | Asked for court-replayable evidence (versions, independent re-verification, public explorer). Asked how QoreWitness compares to OpenTimestamps. Decided the demo domain and a full installer and UI scope. | Explained the design and the OpenTimestamps comparison. Added the submission readiness table and tasks T22 to T26. |
| 2026-11-11 | Put the open questions to the organisers on Discord and brought back the answers: rubric, two-stage audit, server account, reset policy, drill scope. Set the visual direction: enterprise grade, early alpha, no event branding. | Demo site, test-pattern clip, featured image and two identity rounds based on the developer's feedback. |
| 2026-11-12 | Set up the project page. Approved the audit run. | QCAI audit stage 1 (score 82). Fixed two findings, explained three. Registry v3 deployed, agent and demo moved to v3. `docs/AUDIT.md`. |
| 2026-11-13 | Rotated the SSH session keys. Reviewed the audit results. | QCAI audit stage 2 on v3. Drill device on v3. Week 1 build-in-public drafts. Audit experiments. |
