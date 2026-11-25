# Changelog

Newest first. Dates in UTC. Dependency updates follow the checks in the "Dependencies" section below.

## 0.6.0-alpha.4 (25 Nov 2026)

QoreWitness Verify trusts only our registries, one drop zone, times with the time zone, one name per thing in the app (evidence file, receipt, pairing code), CSP on Verify, installer temp file via mktemp. Install line pinned to this tag.

- QoreWitness Verify: the whole upload card is one drop zone, and the whole page accepts dropped files. "Choose files" takes any mix: an evidence file (ZIP), or a clip with its receipt. The clip-and-receipt fold is gone. Times show one date style with the zone ("24 Nov 2026, 08:08 to 08:09 (CET, your time)"), and the UTC time is under Technical details. The page has the beta banner, a skip link, the site footer and a Content-Security-Policy with the hash of its own script (security review 3, item 6). A single changed clip gets a plain red line. Rebuilt (reproducible), SHA-256 `01fb584fe02806b7335ebb44c0abc1fd0da48bc1387281707046e859a59bdae8` on the Developers and jury pages.
- Words: one name per thing on the site, in Verify, the app, the evidence file texts, README and `docs/INSTALL.md`: "evidence file" for the ZIP, "receipt" for the JSON, "pairing code". No "pilot", "box", "minutes after" or "the moment" left in user-visible text.
- Site (product owner's final polish list): the C210 row says "Test planned". Seals: every place that talks about how long seals last says that beta seals live on the QoreChain test network, which can be reset. The install step explains what to replace when the computer is not called qorewitness. The "read the script first" link points to the same tag as the install line (security review 3, item 4). Jury page: "QoreWitness at a glance", four short screens, the live camera on registry v4 since 14 Nov (checked on chain on 25 Nov), one self-contained HTML file. Prove: the example result uses the real Verify text, the orange line sits under "What a green result means", new Verify screenshots. Plans: "EUR 0 per camera per month" for Free. FAQ: clearer cost, fake-clip and sound answers (your national data protection authority). Footer: "Set up your camera". Hero card: "22 Nov 2026, 02:14 CET". Test count 252 on 25 Nov 2026.
- Installer: the Docker script goes to a `mktemp` file and runs with `</dev/null` (security review 3, item 5). `web/site/README.md` rewritten: no stale "must be served" note (item 3).
- Accessibility: axe-core on all 12 live pages, Verify included, at 320, 390, 768 and 1280 px, light and dark: 0 violations.

- Security (review 3): the verifier (QoreWitness Verify and `scripts/verify-receipt.ts`) accepts only the QoreWitness registries on qorechain-diana (v4, v3 and the first deployment). Before, a receipt could name any contract on the chain, and a fake contract could answer "anchored" with any block and time. Such a receipt now shows "Not confirmed". No change for real receipts. QoreWitness Verify SHA-256 `a25d483967e0bad97250c60a6e2f1495ac7d529f9aed06d11b177a67752f943f` (regression test in test/sec-review.test.ts).

## 0.6.0-alpha.3 (23 Nov 2026)

Sound in the clips, the piped installer fixed, QoreWitness Verify wording.

### 2026-11-23: sound, installer, Verify wording
- Recorder: keeps the camera's sound when the stream has it (`QW_AUDIO`, default 1). Video stays a byte copy, sound becomes AAC 32 kbit/s mono, because MP4 cannot hold the G.711 sound of many cameras. A camera without sound records video only. `QW_AUDIO=0` keeps the picture only. Hashing, receipts and the verifier are unchanged: the fingerprint covers the whole file. Tested on the test computer with a G.711 A-law stand-in: recorded (h264 + aac), sealed in block 10,602,114, evidence file verified, one changed byte found. A stream without sound still records. Product owner decision: team/audio-decision.md.
- Setup: one line under "My camera films my own property": "Clips keep sound when your camera's microphone is on. You can switch it off in your camera's app at any time." Site FAQ: "Does QoreWitness record sound?".
- Installer: with `curl ... | bash` it stopped after "Starting QoreWitness" without the address and the pairing code, because docker compose read the rest of the script from stdin. The body now runs in main() and docker gets </dev/null (regression test).
- QoreWitness Verify: heading "QoreWitness Verify", button "Try it: change one byte and check again", no file names in the result text (a changed clip is named by its recording time), no "demo" wording. New SHA-256 `47082d47f8ec9929fd9890418bcc9739685580620673676d3ced70a0c02f39a6`.
- Site: dashboard screenshots with consistent numbers (500 GB SSD, 412 GB free, 150 MB per seal, 14 days), test count 249, install lines pinned to v0.6.0-alpha.3. Live site regenerated, link check clean.
- Version 0.6.0-alpha.3 in package.json, docker-compose.yml (QW_VERSION default), install.sh, README and docs/INSTALL.md.


### 2026-11-22: site go-live build
- Site: all section edges are now the soft wave from "The app" to "What you need", in four variants (mirrored, other amplitude and phase), with a second faint line behind the wave on the hero and the footer. The skyline and chain links are gone. Light and dark mode, decorative only, same heights as before.
- Site: `node scripts/build-site-preview.mjs --live` writes the live pages to `web/site/`, copies QoreWitness Verify to `verifier.html`, writes `sitemap.xml` and `robots.txt` (disallows `/preview/` and `/sponsor/`) and turns every `/preview/<page>.html` into a noindex redirect to `/<page>.html`. Every page has a canonical link and Open Graph and Twitter card tags with the absolute `qorewitness-featured.png`. The plain build now writes a noindex draft to `web/site-draft/` (not deployed).
- Site: the old home page is kept as `web/site/legacy/index-2026-11-21.html` (noindex, not linked). `demo-clip.mp4` and `demo-receipt.json` stay on the server only.
- Verifier: description, canonical and social tags added. New SHA-256 `564408e4cf00c6e2abad06e1ab28a11eff8e19e28707e831d953912d74eec166`, updated on the site.
- Tooling: `scripts/check-site-links.mjs` checks every internal link, asset and anchor of every page, and that no live page has noindex.

## 0.6.0-alpha.2 (22 Nov 2026, launch-ready preview)

Beta wording everywhere, any camera (search, brand picker), Hands-off plan on the site, evidence wording from the first real run, quieter sponsor alerts. Install line pinned to this tag.

### 2026-11-22: calmer words after the first real run
- Setup: one text on the progress bar ("Connecting your camera…"), only the bar moves. "This takes a few minutes".
- Done page: also shows the address that the installer printed, when the browser used another one (for example qorewitness.local).
- Dashboard: each seal shows the real clip times (the first seal after setup can hold only a few minutes, and then says "2 minutes of video") and the file size before the download. A line advises to share the file with an upload or a link rather than by e-mail. Gap sign tooltip: "Part of the video is missing here, or the camera restarted".
- QoreWitness Verify: rounded durations ("About 6 minutes of video are missing before this clip"), plain words for a camera restart, and one calm line under an orange result: "The clips are original. Some minutes are missing, for example when the camera was off." New SHA-256 in the site and the preview.
- Site screenshots of the progress, done, dashboard and evidence screens re-taken from the app.
### 2026-11-22: sponsor alerts and beta wording
- Sponsor: `float_low` fires below 2 days of worst-case payouts for the live cameras (floor 15 test QOR). Before, it fired below one day of the global cap (90), so every 15-minute pass alerted at a healthy 58.8 test QOR (49 alerts in 10 hours).
- Sponsor: alerts for a lasting condition (`float_low`, `float_empty`, `float_high`, `hourly_wait`, `pass_failed`, `http_error`) go out at most once per 6 hours, then one `<kind>_recovered` line.
- Sponsor: the public note says "Beta on the QoreChain test network. Test tokens without value. No payment is collected." Plain messages say "Fees included". Field names unchanged.
- Tests: float threshold, alert rate limit and recovered line, no alerts at a healthy float, beta note (237 tests). Docs: `docs/SPONSOR.md`, `sponsor.env.example` (`SPONSOR_FLOAT_LOW_FLOOR_QOR`).

### 2026-11-22: verifier wording
- QoreWitness Verify: no "pilot" or "box" in its text. The result says the file is exactly what "the camera's QoreWitness" recorded and that QoreWitness is in beta on the QoreChain test network. "Sealed within 1 minute" is now singular. Rebuilt as one offline HTML file, SHA-256 `d894ee8cad7d6b68b5a6fc41ec93693a2f6111c2971108ed72571f2a33fa2100`, shown on the Developers and jury pages and in `web/site/index.html`. The Verify screenshots are taken again.

### 2026-11-22: site round 2 (real screens, plans, jury page, accessibility)
- Site: every screenshot placeholder is replaced by a real screen of the app, captured from the local ui server with the chain, camera, network search and fee sponsor mocked (phone 390 x 844 and desktop 1280 x 800 at 2x, WebP in `web/site/assets/screens/`), in CSS phone, browser and terminal frames. Camera app steps (Tapo, Reolink) use a neutral illustrated phone with the menu path as text. QoreWitness Verify is shown with a green Original for the published sample record, checked against the live testnet contract.
- Site: Plans are now Free (recommended: runs on your own hardware, and during the beta we cover the network fees) and Hands-off (USD 10 or EUR 9 per camera per month), with the banner "Available when QoreWitness launches on the QoreChain main network" and a "Get notified on X" link to @fnoufnou (no form, no email). EUR 4 is gone from the site and the FAQ.
- Site: new page `jury.html` for the Developer Fest judges (what it is, how ML-DSA-87 is checked on chain, live contract, audits, drills, tests, criteria map). Navigation: customer items, a thin divider, then "Developers" and "For the jury" in a muted colour. On phones a Menu button (keyboard and Escape support) replaces the scrolling strip. The "Technical names" fold-out points to the Developers page.
- Site: footer with "© 2026 fnoufnou", the Apache License 2.0 link, the trademark line and a link to Trust. The hero has its own background (soft gradient, light dot pattern) and a skyline edge. Section edges: skyline, soft wave and chain links, in light and dark mode. Motion respects `prefers-reduced-motion`.
- Site: WCAG 2.2 AA pass with axe-core at 320, 390, 768 and 1280 px in light and dark: 0 violations (before: region, scrollable-region-focusable, empty-table-header in every run). No horizontal scroll at 320 px.
- App: "Fees included" and pilot wording become "Free beta: we cover the network fees" (dashboard fee fact, status actions, sponsor messages, footer, evidence certificate). The "Sealing started" address no longer breaks mid-word on a phone. Installer: "QoreWitness is ready" in place of "Your QoreWitness box is ready". README, INSTALL, THREAT_MODEL and SPONSOR follow the beta wording.

### 2026-11-22: new logo (Sealed frame) and hero polish
- Brand: the new mark "Sealed frame" (pine shield, viewfinder corners, check, orange recording dot) replaces the lens-in-a-square mark on the site, the preview pages, the verifier, the app header, the certificate, the favicon and the featured image. The favicon is a simplified shield with a check and the dot. `docs/BRAND.md` describes the mark, its minimum size, clear space and the two-tone rule.
- Site: the hero photos are now `img` elements with width, height and loading attributes. A dark top gradient keeps the camera captions readable, the small frames keep their own seal badges and the report card no longer hides the third frame.

### 2026-11-22: site in the product voice, any camera, cameras page
- Site (preview): every page rewritten in a confident, warm product voice after the owner's feedback. One slim beta banner on every page is the only beta wording outside Trust, Developers, the plan price and one FAQ line. No "demo", "pilot" or "box" in the body copy. No sealing interval in marketing copy ("as it is recorded", "pinned to the time it was recorded").
- Site: "Set up your camera" for any RTSP or ONVIF camera: check compatibility, prepare the camera (hints for Tapo, Reolink, Hikvision/Annke, Dahua/Amcrest, UniFi Protect, Axis, generic ONVIF), install, open the setup, done. "What you need" with minimum and recommended hardware, storage guide, platforms, and a short Docker Compose guide (only the Linux installer is tested end to end).
- Site: new page `cameras.html` with honest statuses (Tested by us, Works with RTSP, Not supported) and a VLC check.
- Site: new hero composition with replaceable photo slots (`web/site/assets/hero-frames.jpg`, `hero-frame-2.jpg`, `hero-frame-3.jpg`), seal badges and a verification report card. A dark gradient placeholder shows until the photos exist.
- Site: Plans shows "EUR 4 per camera per month" with "Free while we're in beta", and Self-managed as a free second card. The verifier is named "QoreWitness Verify" everywhere.
- Site: tables stack as cards on phones. Trust has a new `#beta` section. Developers: test count and built features updated.
### 2026-11-22: any camera with a stream
- Setup: "Find my camera" runs when the camera screen opens. It checks ports 554, 8554 and 2020 on the home /24 and asks each camera for its ONVIF name (WS-Discovery Probe, multicast and directed). Docker's bridge network passes no multicast, so the directed Probes do the work: on the test computer both cameras on the network were found from the bridge network in about 4 seconds. The user picks a camera or types an address.
- Setup: brand picker (TP-Link Tapo, Reolink, Hikvision or Annke, Dahua or Amcrest, Ubiquiti UniFi Protect, Axis, Other camera). It fills the vendor's RTSP link, so the user types only the camera account. Other and UniFi: one field for the full rtsp:// link. Data in `src/web/cameras.ts`, shared with docs and site.
- Setup: errors in plain words for any brand (no answer, wrong name or password, no video at this link, busy, unsupported video format). H.264 and H.265 are recorded (segment copy tested for both). Other formats get "choose H.264 or H.265". The Tapo recording rule shows only for Tapo.
- Wizard and dashboard say "your camera" and "QoreWitness" in place of Tapo-only wording and "box".
- Docs: `docs/CAMERAS.md` compatibility table (Tested by us, Works with RTSP, Not supported), "check your camera with VLC", how the search works. `docs/INSTALL.md` step 1 for any camera, Tapo as the example.

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
