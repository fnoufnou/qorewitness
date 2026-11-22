# Changelog

Newest first. Dates in UTC. Dependency updates follow the checks in the "Dependencies" section below.

## 0.6.0-alpha.1 (22 Nov 2026, Customer Edition preview)

First build for non-technical owners: install with one paste, setup in the browser, Fees included by default, evidence download and a verifier that takes it. Tested end to end on a clean Debian box with a stand-in camera and the live sponsor (22 Nov).

### 2026-11-22: sponsor buffer, required key, no pause on the hourly limit
- Sponsor: below 10 test QOR, refills top the owner up to the 15 test QOR target (about 1.5 to 2 days of sealing), within the camera, owner and global day caps. Before, refills only paid back what was used, so after the start grant a box ran for about 9 hours when the sponsor stopped. Only a camera that sealed in the last 2 hours gets a refill.
- Sponsor: `devicePubkey` is required on enrol. The 120,000-block history scan for the key is gone (security review 2, item 3).
- Sponsor: a payout that would pass the hourly limit waits for a later pass. The automatic pause is kept only for a real anomaly: the hot wallet dropped more than the payouts and fees explain (security review 2, item 4).
- Tests: target top-up, sealing required, hourly wait without pause, float anomaly pause, required key (210 tests).
- Docs: `docs/SPONSOR.md`, `deploy/sponsor/sponsor.env.example` (`SPONSOR_PER_ANCHOR_QOR`, `SPONSOR_MIN_WINDOW_SECONDS` and the key lookup settings removed, `SPONSOR_FLOAT_SLACK_QOR` added).

### 2026-11-21: keep it simple (box setup, installer, dashboard)
- Setup in the browser: 3 screens and 1 progress bar. Password (one field, "Show password"), camera (address, camera account name and password, one tick), "Is this your camera?" with the picture, then one progress bar that starts by itself and ends at "Sealing started". The plan, keys, backup, funding and Ready/Start screens are gone. Keys and the owner account are made in the background. The camera name is always `camera-1`.
- Fees included is the default and sends no pilot code. When the pilot says no (full, paused), the progress bar says so in plain words and offers "Use my own wallet". Self-managed also sits under "Advanced" on the camera screen. Sponsor status asks with `?owner=`, because every box uses the same camera name.
- Done screen: the dashboard address in large text, "bookmark it", and one backup line.
- Dashboard: times in the browser's own time zone, a Download button per seal (one 10-minute evidence ZIP), "Pick another time" folded. No crypto words on the main view: blocks, registry, balance, keys and receipts sit under Details. "Fees low" became "Sealing pauses soon: fees are running out" with one action. The fee per seal is now 0.048 test QOR (measured).
- Installer: Docker install defaults to yes (Enter), `--yes` accepts all defaults. The end shows the dashboard address and the pairing code in large text. One paste from your own laptop: `ssh -t <user>@qorewitness.local "curl ... | bash -s -- --yes"`.
- Security (sec-review-1, finding 3): after `setup.done` the ui process locks itself and every read of `qorewitness.env` or `keys/` throws (`lockSecrets`, with tests). Invisible to the owner. The residual risk is in the threat model.
- Box footer: "QoreWitness never asks for your passwords or files."
- Docs: `docs/INSTALL.md` rewritten for the one-paste install, the short setup and Download per seal.
- Site: simplified preview copy after the PO walkthrough. Fees included is the default without a pilot code, Self-managed is folded. Install is one paste on your own computer. Setup is 3 screens. Prove is one evidence file and a green Original. Crypto words only in folded boxes, Trust and Developers.

### 2026-11-21: save evidence (dashboard) and ZIP verifier
- Dashboard: **Save evidence**. Pick a date and a time range (max 60 minutes, default last hour). The box checks each clip against its receipt (both fingerprints, size, chain link, Merkle path), tells you about gaps and clips not sealed yet, then streams one ZIP (stored entries, Node built-ins only, exact Content-Length, 2 GB cap): original clips, receipts, `certificate.html` and `HOW-TO-CHECK.txt`. Same session, CSRF and host rules as every dashboard route. Clip names from receipts must match `seg_*.mp4|ts`, links are never followed, and entry names are made by the box.
- Verifier: drop the ZIP. It unpacks in the browser (own reader for stored and deflate entries, refuses unsafe names, ZIP64, encryption and entries that inflate past their size), checks every clip with its receipt using the existing code, and shows one verdict first: green "Original", orange "Original, with notes" or "Check not finished", red "Changed after sealing" or "Not confirmed". Then what it proves and cannot prove, a print button and folded technical details. One clip plus receipt and the tamper demo still work. Still one offline HTML file (366 KB).
- Tests: ZIP round trip (writer to the verifier's reader, also with deflate), range selection, size cap, tampered clip (left out on the box, red in the verifier), path traversal, links, auth and CSRF.

### 2026-11-21: Fees included without a pilot code
- Sponsor: enrol needs no pilot code (a `pilotCode` field is accepted and ignored). Admission of a new camera: the camera signature, at most 12 live cameras, 2 per owner, one new camera per client IP per UTC day (memory only), and at most 6 start grants per UTC day. Otherwise the answer is `full` with a plain message. One start grant per camera. Pause flag, daily caps and refill caps unchanged.
- Sponsor: pilot codes removed (`services/sponsor/codes.ts`, the codes file and its setting). Simpler to run, nothing to hand out.
- Tests: enrol without a code, IP limit (also through HTTP with the box client), owner limit, pilot full, grants per day (202 tests).
- Docs: `docs/SPONSOR.md` (admission rules, residual risk of open enrolment, privacy without codes).

### 2026-11-21: sponsor start grant (Fees included without a faucet)
- Sponsor: enrol works before the camera is on chain. The box sends `devicePubkey`. The service checks the camera signature against it, needs an unused pilot code, binds code, owner, device id and key hash, and sends one start grant of 3 test QOR (setup uses about 0.25). When the camera shows up on chain under that owner with that key hash, it becomes active and refills start. Another key or a revoke: rejected. Not registered within 48 h: expired, the code stays used.
- Sponsor: answers use the status words of the box client (enrolled, pending, funded, active, full, invalid_code, used_code, paused, rejected). Refusals come with HTTP 403, 409 or 423, so the wizard shows the right text.
- Tests: start grant once, code reuse, key mismatch, expiry, pause, unknown grant result, and an end-to-end run of the box client (`src/web/sponsor.ts`) against the sponsor server with a mocked chain (178 tests).
- Docs: `docs/SPONSOR.md` (bootstrap path, status words, start grant costs), `docs/INSTALL.md` (no faucet with Fees included). `FEE_PER_ANCHOR_UQOR` set to 0.048 test QOR.
- Site: preview copy updated to the built installer, setup in the browser and dashboard (screen names and dashboard states from `docs/INSTALL.md`). Evidence ZIP export, ZIP verifier, phone alerts, Windows installer and ready-made Pi image are marked planned.

### 2026-11-21: the QoreWitness box (browser setup)
- Security: `camera.env` and every secret file are written with mode 600, also when an older version left 644. `record.sh` masks `user:pass@` in all ffmpeg output, with the same rule as `src/core/redact.ts`. The `ui` no longer loads `qorewitness.env`. `docker-compose.yml` pins `QW_VERSION` instead of `latest`.
- Docker: new `supervise recorder|agent` mode. Both wait for `data/setup.done`, read `camera.env` as data (never as shell code) and restart when it changes. Older terminal installs with receipts count as done.
- Compose: the `ui` publishes on `QW_UI_BIND` (default `127.0.0.1:8080`) and mounts `/data` read-write for the setup. No `env_file`, so compose needs no read access to the secrets. Default image `0.6.0-alpha.1`.
- Installer: pulls the GHCR image (`--build` builds from source), offers to install Docker after a yes, detects the LAN IP, a free port and a public IP, starts the box and prints the setup link and a 6-digit pairing code. `--terminal` keeps the old flow, `--new-password` resets the dashboard password, `--local-only` binds to 127.0.0.1.
- Setup steps in `src/setup/steps.ts`, shared by the terminal and the browser. Every step checks first and skips what exists. Chain access sits behind an interface, and every write checks EVM chain 9800 and qorechain-diana first.
- Browser setup (`src/web/wizard.ts`): pairing, password, camera with a Tapo C210 helper and a "Test camera" picture, plan (Fees included with a pilot code, or Self-managed), keys with a backup note, network fees, registration with a progress bar, done. Resumes after a closed browser or a restart.
- Auth (`src/web/auth.ts`): pairing token and code, scrypt password, signed sessions, CSRF per session, Host allowlist, same-origin POST, private clients only, failure limits.
- Pilot sponsor client (`src/web/sponsor.ts`): challenge, camera ML-DSA-87 signature over `qorewitness-sponsor-v1|9800|<registry>|<deviceId>|<owner>|<nonce>`, enroll and status. Only public data leaves the box.
- Dashboard: health in green, orange or red with one action per problem (camera offline, sealing stopped, fees low from the owner balance, first seal pending, disk almost full). Fonts from `web/site/fonts`.
- Docs: `docs/INSTALL.md` (Linux path, browser setup, Tapo C210 reference), README, threat model (A9, residual risks of the browser setup).
- Tests: auth, CSRF, Host check, secret masking, file modes, entrypoint supervise mode, installer with a fake docker, wizard state machine and a full HTTP walk with a mocked chain, camera and sponsor (139 tests).

### 2026-11-21: fees included (sponsor) and the customer website preview
- Sponsor service "Fees included" (`services/sponsor/`, testnet pilot): refills the test QOR that a pilot camera uses, sent to the customer's own owner account. Enrol needs a pilot code and a camera ML-DSA-87 signature over a single-use nonce, checked against the device key on registry v4. Pays only the on-chain owner, only for anchors seen on chain. Caps per camera, owner and day, max 12 cameras, pause file as kill switch, automatic pause on high outflow, refuses any chain but 9800. Deploy files in `deploy/sponsor/`, details in `docs/SPONSOR.md`. Not deployed yet (105 tests).
- Agent: hybrid bank send helpers moved from the Q-Day drill to `src/agent/bank.ts`. The drill and the sponsor share them.
- Docs: real cost per anchor is about 0.0457 test QOR (406,000 gas at 0.1125 uqor per gas), plus 0.1 test QOR per EVM window open (about 3.5 per day). Explorers show the maximum fee (about 0.104 QOR). `docs/TESTNET_FINDINGS.md`, `docs/AGENT_KEY.md` (a relayed anchor costs about 2.4 times a direct one) and README updated.
- Site: new customer website as noindex preview in `web/site/preview/` (home, how it works, Tapo C210 guide, daily use, prove a video, plans, FAQ, trust and limits, developers). Pilot badge on every page, light and dark mode, no external hosts. Built by `scripts/build-site-preview.mjs`. The live home page is unchanged.
- Site: the claims "quantum-safe encryption" and "chain of custody at the camera itself" are replaced in the new pages ("planned: share evidence privately", "chain of custody minutes after recording, on your own recorder").

## 0.5.0-alpha.1 (21 Nov 2026, first tester build)

### 2026-11-21
- Contracts: `QorePqc.keyStatus` reads `pqcKeyStatus` by position, so fields that the chain appends after `possessionProven` no longer turn the answer into "possession not proven". Team guidance of 21 Nov. Ships with the next registry deployment. Live registry v4 unchanged (76 tests).
- Docs: README states that QoreWitness targets qorechain-diana and that the PQC precompiles are not active on mainnet yet. `docs/AUDIT.md` records the team confirmation of `pqcKeyStatus`. Duplicate lines in the README contract rules removed.
- Release: first image for testers, built by GitHub Actions (amd64, arm64).
- Docs: relayed anchors emit no EVM logs (`docs/TESTNET_FINDINGS.md`). Agent-key mode stays an option after the tester release (`docs/AGENT_KEY.md`).
- Testnet v3.2.9: `probe:pqc` passes, the live agent anchors normally.

### 2026-11-20
- Owner key offline (T31): spike on testnet passed 8 of 8 checks. An agent key with an anchor-only spending rule anchored through `MsgExecuteEVM` without an EVM window, and other calls, value transfers and calls after revoke were refused. `AnchorClient.prepareAnchor` added.

### 2026-11-19
- Docs: `docs/THREAT_MODEL.md` published after review: five claims (continuous stream and two-sided time bound added), design goal, eIDAS explained.
- Dependencies: `@qorechain/sdk` and `@qorechain/evm` 0.12.0 to 0.14.0, now exact pins. See the table below.

### 2026-11-18
- Site and project page: plain-language rewrite for camera owners (receipt explained, limits in normal words, hopeful close). Demo facts updated: block 10,120,133, four audit rounds, crash recovery done.
- Q-Day Drill: normal transaction sent with plan B (fee 0.025 QOR), proof accepted.

### 2026-11-17
- Local dashboard, phase 1 (read only): health line, latest anchors with explorer links, receipt downloads, JSON status. Node's built-in http server, token in an HttpOnly cookie, strict headers, local port only. Not deployed yet (75 tests).
- Design note `docs/AGENT_KEY.md`: owner key offline with a linked agent key and a relayer (T31), from SDK 0.14.0.
- Drill: `self-send` command for the normal transaction, fee 0.025 QOR.
- QCAI stage 4 on registry v4 with the advised Ethereum setting: score 85. Every finding mapped to a test or a reason in `docs/AUDIT.md`. All four reports copied to `docs/audit/` with their dates.
- Tests: a revoked device id cannot be registered again, so its window chain never resets (69 tests).

### 2026-11-16
- Tests: three regression tests show that the registry fails closed when a PQC precompile answers nothing (68 tests).
- Docs: `docs/AUDIT.md` maps every `pqcVerify` and `pqcKeyStatus` call to what it protects and to its tests.
- Dependencies: `@qorechain/sdk` and `@qorechain/evm` 0.14.0 checked in a separate copy (same addresses and ML-DSA-87 keys, all tests pass). Not applied yet: freeze until the Q-Day Drill ends (19 Nov).

### 2026-11-15
- Second file hash: SHA3-256 bound into the segment link (spec/3). All verifiers require both hashes for "verified".
- Crash-safe receipts: a receipt lost after a crash is rebuilt from public chain data.
- Recorder input: RTSP, RTMP (pull and push), HLS and HTTP-FLV. Retention as a Docker service. Setup wizard defaults to registry v4. Image workflow for GHCR.
- QCAI audit stage 3 on registry v4.

### 2026-11-14
- Registry v4 `0xa1378D6558B32e1f8d37b68cf90e3C93839Da365`: chained windows, gaps on chain, lower time bound (reference block). Spec/2 and receipt v3.
- Custody drill: 10 attacks on the footage, results in `docs/CUSTODY_DRILL.md`.
- Docker installer and terminal setup wizard.

### 2026-11-12 to 2026-11-13
- Registry v3 `0x238A1D989c1f0561d4DD51d4B322C491A5cb1CD2` with QCAI stage 1 fixes (window length, proof length). QCAI stage 2.
- Court-replayable receipts: tool version, commit and spec in every receipt. `docs/SPEC.md` and a standard-library Python verifier.

### 2026-11-09 to 2026-11-11
- Registry v2 with camera keys, rotation and revocation. Receipt v2, browser verifier with tamper demo, demo site.
- First live anchors from a home camera on qorechain-diana.

## Dependencies

QoreChain packages are pinned to exact versions. Each update records here: the old and new version, what changed (from the release notes), and the checks that ran:

1. `pnpm test` and `pnpm typecheck`
2. `pnpm probe:pqc` against testnet
3. Key check: every account derives the same EVM address and ML-DSA-87 key as the key registered on chain
4. Recovery drill (`scripts/recovery-drill.ts`): one real anchor, a rebuilt receipt, the verifier
5. Two live windows after deploy

| Date | Package | From | To | Notes |
|---|---|---|---|---|
| 2026-11-16 | `@qorechain/sdk`, `@qorechain/evm` | 0.12.0 | 0.14.0 (checked, not applied) | 0.13.0 fixes ML-DSA derivation from a raw ECDSA key. Our accounts use mnemonics and are not affected. |
| 2026-11-19 | `@qorechain/sdk`, `@qorechain/evm` | 0.12.0 (range `^0.12.0`) | 0.14.0 (exact) | Released 11 and 12 Nov. The packages ship no changelog: source is the QoreChain team (derivation fix in 0.13.0) and the SDK type docs (authenticator lanes and possession proofs for chain v3.2.8). Checks: tests and typecheck (75), `probe:pqc` live (valid signatures accepted, tampered, short and wrong-message signatures refused), key check (same addresses and ML-DSA-87 keys for all three accounts), recovery drill on testnet, agent restarted and anchoring. |
