# QoreWitness

Post-quantum evidence anchor for camera footage on QoreChain.

QoreWitness proves that a video segment existed before a known time. It hashes each recording segment with two independent functions (SHA-256 and SHA3-256), builds a SHA-256 Merkle tree per time window, signs the root with the camera's own ML-DSA-87 key and stores it in the `AnchorRegistry` contract on QoreChain. The contract checks the ML-DSA signature on chain. The block time is the trusted "existed before" time. Since registry v4, every segment and every window is chained to the one before it, and the camera signs a recent block hash, so the time is bounded on both sides.

Status: beta on the QoreChain test network (qorechain-diana), built for the QoreChain Developer Fest (Nov 2026). Website and setup guide: https://qorewitness.fnoufnou.com. For the jury: https://qorewitness.fnoufnou.com/jury.html. The test network can be reset, so do not use QoreWitness as your only evidence yet.

## Why post-quantum

Evidence can be needed 10 to 30 years after recording. Classical signatures (ECDSA, RSA) may be broken by then. ML-DSA-87 (FIPS 204) signatures keep the link between device, owner and time valid in that period. The hash commitment itself is already fairly robust against quantum computers. The post-quantum value is mainly in the signatures.

## How it works

```
camera (RTSP) -> ffmpeg segments -> agent: sha256 per segment
  -> window of N seconds -> Merkle root -> ML-DSA-87 signature by the device key
  -> AnchorRegistry.anchor() on QoreChain (pqcVerify on chain)
  -> receipt JSON next to the recordings (+ OpenTimestamps, planned)
verifier (static web page or CLI): file + receipt -> hash, Merkle path,
  verifyAnchor on chain, device key, ML-DSA-87 signature
```

Two keys, two layers of post-quantum protection:

| Key | Holder | Signs | Checked by |
|---|---|---|---|
| Owner key: the account's ML-DSA-87 key registered on chain | Owner account | Native-lane txs (hybrid), EVM window, register and revoke a device | Chain, and the contract via `pqcKeyStatus` (`0x...0A02`) + `pqcVerify` (`0x...0A01`) |
| Device key: one ML-DSA-87 key per camera | Agent next to the camera | Window roots, key rotation (old and new key) | Contract via `pqcVerify` |

1. Chain level. Every EVM transaction needs a registered ML-DSA-87 key and an EVM authorisation window. The agent opens a window that is scoped to the registry only (`allowed_targets`).
2. Application level. Every state change in the registry needs fresh ML-DSA-87 signatures. A stolen ECDSA key, even inside an open window, cannot anchor, register, revoke or rotate.

## Live on testnet (qorechain-diana, EVM chain ID 9800)

QoreWitness targets the qorechain-diana testnet, where the fest is judged. The QoreChain PQC precompiles (`pqcVerify`, `pqcKeyStatus`) are not active on mainnet yet, so QoreWitness does not run on mainnet.

| What | Address or tx |
|---|---|
| Registry v4 (14 Nov, chained windows, time bound on both sides, live) | `0xa1378D6558B32e1f8d37b68cf90e3C93839Da365` |
| Registry v3 (12 Nov, audit fixes, Q-Day Drill) | `0x238A1D989c1f0561d4DD51d4B322C491A5cb1CD2` |
| Registry v2 (9 to 12 Nov, devices, rotation, `verifyAnchor`) | `0x1854EeE2A659F4f39A05d5832cceC405E8045336` |
| Registry v1 (9 Nov, anchors by account key) | `0xA73d4347b50C2A373533915d698Bf03a01c65aAF` |
| Owner and agent account | `0xD6C6bDfBE567BcE731907789800205Df0B78ca52` |

- A home camera records 60-second segments. The agent anchors every 10-minute window. It used v2 from 9 Nov and v3 since 12 Nov, 07:01 UTC.
- Threat model: what QoreWitness claims and does not claim, its design goal, attackers and controls: `docs/THREAT_MODEL.md`.
- Audit: QCAI audit stages, each finding with its fix, test or reason, and a map of every PQC precompile call with its tests: `docs/AUDIT.md`.
- Gas and tx hashes: `docs/TESTNET_FINDINGS.md`. One anchor costs about 0.0457 test QOR (about 406,000 gas). The owner account also opens an EVM window (0.1 test QOR) about every 7 hours. Explorers show about 0.104 QOR per anchor: that is the maximum fee, the chain charges less.
- Free beta: a sponsor service refills the test QOR that beta cameras use ("Free beta: we cover the network fees"). Test tokens only: `docs/SPONSOR.md`. A paid Hands-off plan (USD 10 or EUR 9 per camera per month) is planned for the QoreChain main network.
- Save evidence: the dashboard makes one ZIP for a time range (original clips, receipts, a printable `certificate.html`, `HOW-TO-CHECK.txt`). Open `web/verifier/dist/index.html` and drop the ZIP: one plain verdict (green, orange or red), what it proves and cannot prove, and a print button.
- Verify a segment: open `web/verifier/dist/index.html`, drop the video and its receipt. Or run `pnpm tsx scripts/verify-receipt.ts <receipt> <file>`. Without any QoreWitness code: `python3 tools/verify_receipt.py <receipt> <file>` (standard library only). The exact rules, and how to replay a check with third-party tools, are in `docs/SPEC.md`. The page has a tamper demo: it changes one byte in a copy in memory and checks again.

## Contract rules

- Anchors are immutable. There is no contract owner and no upgrade path.
- Devices belong to the account that registered them. Register: the owner key and the new device key sign (proof of possession). Revoke: the owner key signs. Final, a revoked device id cannot come back. Rotate: the old and the new device key sign. A nonce per owner stops replays.
- Anchor: only the owner account can send it, and the current device key must sign. Anchors from a revoked device or with an old key fail.
- Windows per (owner, device) must move forward and must not overlap. A later anchor cannot fill a gap in the past.
- Since v4, each window commits to the previous root of its camera, and each segment to the previous segment. A removed, replaced or re-recorded piece breaks the chain. Gaps are stored on chain.
- Since v4, the camera signs the hash of a recent block: the root was signed after that block and anchored before the anchor block.
- A window must end before the block time (120 s skew allowed).
- Every signed message is domain-separated: tag, chain ID, registry address, owner, device and the action data.
- `verifyAnchor(owner, device, windowStart, segmentHash, index, path)` gives a third party one answer: found, included, anchor time, signing key and version, device status now. It never reverts.
- `requirePossessionProof`: the owner key must have a proof of possession on chain.

## Drills

- **Q-Day Drill dry run** (keys): 13 attacks with only the ECDSA key, 0 succeeded. `docs/TESTNET_FINDINGS.md`.
- **Custody drill** (input): 10 attacks on the footage itself. All 5 attacks after anchoring are rejected. 4 of 5 substitutions before hashing are flagged. A substitution with the camera's own settings is not caught: that is the trust boundary. `docs/CUSTODY_DRILL.md`.
- **Recovery drill** (crash): the agent stops after the anchor tx is mined and before the receipt is written. After a restart, the receipt is rebuilt from public chain data and verifies. Every field equals the lost result (15 Nov 2026, block 10,133,808). `scripts/recovery-drill.ts`.

## Repository

| Path | Content |
|---|---|
| `contracts/` | `AnchorRegistry`, `MerkleSha256`, `QorePqc` (safe precompile wrappers), test mocks |
| `src/core/` | Merkle tree, signed messages and receipt checks, shared by agent, CLI and browser verifier |
| `src/agent/` | Agent: segment watcher, windows, device key, ML-DSA signing, scoped EVM window renewal, receipts |
| `src/setup/` | Setup steps shared by the terminal and the browser setup (idempotent, chain access behind an interface) |
| `src/web/` | Box web server: pairing and auth, setup wizard, Tapo camera test, pilot sponsor client, dashboard, evidence ZIP (`evidence.ts`, `certificate.ts`) |
| `services/sponsor/` | Pilot fee sponsor: tops up owner accounts with test QOR (testnet only) |
| `web/verifier/` | Browser verifier (single HTML file after `pnpm build:verifier`) |
| `deploy/` | Recorder (ffmpeg) and agent systemd units, per-camera config |
| `scripts/` | Device CLI, EVM window helper, anchor and verify CLIs, live precompile probes |
| `test/` | Contract and Merkle tests (Hardhat 3, node:test, viem) |
| `docs/` | Architecture, threat model, testnet findings |

## Install (Docker, early alpha)

On a 64-bit Linux machine (Raspberry Pi OS Lite 64-bit, Debian, Ubuntu) on your home network:

```bash
curl -fsSL https://raw.githubusercontent.com/fnoufnou/qorewitness/v0.6.0-alpha.3/install.sh | bash
```

The installer installs Docker when it is missing (Enter or `--yes` means yes), pulls the published image `ghcr.io/fnoufnou/qorewitness:<QW_VERSION>`, starts the box and prints the dashboard address and a pairing code. The rest happens in the browser on your phone or laptop: a password, the camera ("Is this your camera?" with a picture), and one progress bar to "Sealing started". Keys and the owner account are made in the background. The free beta pays the network fees (no code). Self-managed sits under "Advanced". Everything lives in `~/qorewitness/data`. Read `install.sh` before you run it.

Step by step, with a Tapo C210 section: `docs/INSTALL.md`. The older terminal setup stays available: `install.sh --terminal` or `docker compose run --rm agent setup`.

Stream types (`QW_STREAM_URL` in `data/camera.env`):

| URL | Use |
|---|---|
| `rtsp://` `rtsps://` | Most home cameras. QoreWitness pulls the stream. |
| `rtmp://` `rtmps://` | Pull from an RTMP server or camera. |
| `http://` `https://` | Pull an HLS (`.m3u8`) or HTTP-FLV stream. |
| `rtmp://0.0.0.0:1935/live/<secret>` with `QW_STREAM_LISTEN=1` | The camera or an app pushes to this machine. Open port 1935 in `docker-compose.yml`, on the camera network only: anyone who reaches the port and knows the path can push video. |

The `ui` service serves the browser setup and the dashboard on one port. Before setup it needs the pairing code. After setup it needs the dashboard password. It shows the health of the box in plain words (green, orange, red) with one action per problem, the latest seals with explorer links, and receipt downloads.
- Port: `QW_UI_BIND` in `~/qorewitness/.env`. The installer sets `0.0.0.0:8080` on a home network and `127.0.0.1:8080` on a host with a public IP. Never forward this port on your router.
- Checks: Host allowlist (private IPs, `localhost`, `*.local`, `QW_UI_HOSTNAME`), same-origin POST with a CSRF token, private clients only, scrypt password, signed sessions.
- During setup the `ui` writes secrets to `/data` (camera password in `camera.env`, recovery phrase in `qorewitness.env`, camera key), all with mode 600. Its process never loads the recovery phrase into its environment, and it reads the phrase from the file only for the setup steps that sign. After `setup.done` the process locks itself and no longer reads `qorewitness.env` or `keys/`.

`recorder` and `agent` run in supervise mode: they wait for `data/setup.done`, read `data/camera.env` themselves and restart when it changes. Camera passwords are masked in all logs.

The `retention` service deletes segments older than `QW_RETENTION_DAYS` (default 14). Receipts stay. Use Save evidence on the dashboard for the clips you need first.

## Quick start

```bash
pnpm install --ignore-scripts
pnpm test                 # local tests with precompile mocks
pnpm probe:pqc            # live ML-DSA-87 checks against the testnet precompile, no funds needed
```

Deploy to testnet (needs a funded testnet account, see `.env.example`):

```bash
pnpm window register      # once: register the ML-DSA-87 key
pnpm window open          # open an unscoped EVM window (deploys need one)
pnpm deploy:testnet
QORE_ALLOWED_TARGETS=<registry> QORE_WINDOW_TXS=20 pnpm window open   # scoped window
pnpm device keygen keys/front-door.key
QORE_REGISTRY=<registry> pnpm device register front-door
QORE_REGISTRY=<registry> pnpm tsx --env-file=.env scripts/anchor-files.ts front-door <file...>
```

Create the account with `scripts/new-account.ts` (mnemonic). Do not use the `PRIVATE_KEY` path for a real account: the SDK derives its ML-DSA key from the ECDSA key (see `docs/TESTNET_FINDINGS.md`).

## Legal limits

A blockchain anchor is not an eIDAS qualified timestamp. A court weighs it as ordinary evidence. It shows that a file existed at a time. It does not show who recorded it or that the camera told the truth. Keep the original files, the receipts and a record of how you handled them.

## Licence

Apache-2.0. Built on `@qorechain/pqc`, `@qorechain/sdk`, `@qorechain/evm`, `@noble/hashes`, viem and Hardhat. The project started from the `create-qorechain-dapp` Hardhat template (0.12.0). See `AI_USAGE.md` for how AI was used.
