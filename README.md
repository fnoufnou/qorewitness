# QoreWitness

Post-quantum evidence anchor for camera footage on QoreChain.

QoreWitness proves that a video segment existed before a known time. It hashes each recording segment, builds a SHA-256 Merkle tree per time window, signs the root with the camera's own ML-DSA-87 key and stores it in the `AnchorRegistry` contract on QoreChain. The contract checks the ML-DSA signature on chain. The block time is the trusted "existed before" time.

Status: proof of concept for the QoreChain Developer Fest (Nov 2026). Testnet only. Do not use it as your only evidence.

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

| What | Address or tx |
|---|---|
| Registry v3 (12 Nov, audit fixes, live) | `0x238A1D989c1f0561d4DD51d4B322C491A5cb1CD2` |
| Registry v2 (9 to 12 Nov, devices, rotation, `verifyAnchor`) | `0x1854EeE2A659F4f39A05d5832cceC405E8045336` |
| Registry v1 (9 Nov, anchors by account key) | `0xA73d4347b50C2A373533915d698Bf03a01c65aAF` |
| Owner and agent account | `0xD6C6bDfBE567BcE731907789800205Df0B78ca52` |

- A home camera records 60-second segments. The agent anchors every 10-minute window. It used v2 from 9 Nov and v3 since 12 Nov, 07:01 UTC.
- Audit: two-stage QCAI audit, reports and changelog in `docs/AUDIT.md`.
- Gas and tx hashes: `docs/TESTNET_FINDINGS.md`.
- Verify a segment: open `web/verifier/dist/index.html`, drop the video and its receipt. Or run `pnpm tsx scripts/verify-receipt.ts <receipt> <file>`. Without any QoreWitness code: `python3 tools/verify_receipt.py <receipt> <file>` (standard library only). The exact rules, and how to replay a check with third-party tools, are in `docs/SPEC.md`. The page has a tamper demo: it changes one byte in a copy in memory and checks again.

## Contract rules

- Anchors are immutable. There is no contract owner and no upgrade path.
- Devices belong to the account that registered them. Register: the owner key and the new device key sign (proof of possession). Revoke: the owner key signs. Final, a revoked device id cannot come back. Rotate: the old and the new device key sign. A nonce per owner stops replays.
- Anchor: only the owner account can send it, and the current device key must sign. Anchors from a revoked device or with an old key fail.
- Windows per (owner, device) must move forward and must not overlap. A later anchor cannot fill a gap in the past.
- A window must end before the block time (120 s skew allowed).
- Every signed message is domain-separated: tag, chain ID, registry address, owner, device and the action data.
- `verifyAnchor(owner, device, windowStart, segmentHash, index, path)` gives a third party one answer: found, included, anchor time, signing key and version, device status now. It never reverts.
- `requirePossessionProof`: the owner key must have a proof of possession on chain.

## Repository

| Path | Content |
|---|---|
| `contracts/` | `AnchorRegistry`, `MerkleSha256`, `QorePqc` (safe precompile wrappers), test mocks |
| `src/core/` | Merkle tree, signed messages and receipt checks, shared by agent, CLI and browser verifier |
| `src/agent/` | Agent: segment watcher, windows, device key, ML-DSA signing, scoped EVM window renewal, receipts |
| `web/verifier/` | Browser verifier (single HTML file after `pnpm build:verifier`) |
| `deploy/` | Recorder (ffmpeg) and agent systemd units, per-camera config |
| `scripts/` | Device CLI, EVM window helper, anchor and verify CLIs, live precompile probes |
| `test/` | Contract and Merkle tests (Hardhat 3, node:test, viem) |
| `docs/` | Architecture, threat model, testnet findings |

## Install (Docker, early alpha)

On a Linux machine with Docker (Debian, Ubuntu, Raspberry Pi OS 64-bit) and an RTSP camera:

```bash
curl -fsSL https://raw.githubusercontent.com/fnoufnou/qorewitness/main/install.sh | bash
```

The setup asks for a camera name and its RTSP URL. It creates a testnet account from a fresh mnemonic, waits until you claim test QOR from the faucet, registers the account's ML-DSA-87 key and the camera key, and starts the recorder and the agent. Everything lives in `~/qorewitness/data`. Read `install.sh` before you run it.

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
