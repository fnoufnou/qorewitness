# QoreWitness

Post-quantum evidence anchor for camera footage on QoreChain.

QoreWitness proves that a video segment existed before a known time. It hashes each recording segment, builds a SHA-256 Merkle tree per time window, signs the root with ML-DSA-87 and stores it in the `AnchorRegistry` contract on QoreChain. The contract checks the ML-DSA signature on chain against the post-quantum key that the chain has registered for the sender. The block time is the trusted "existed before" time.

Status: proof of concept for the QoreChain Developer Fest (Nov 2026). Testnet only. Do not use it as your only evidence.

## Why post-quantum

Evidence can be needed 10 to 30 years after recording. Classical signatures (ECDSA, RSA) may be broken by then. ML-DSA-87 (FIPS 204) signatures keep the link between device, owner and time valid in that period. The hash commitment itself is already fairly robust against quantum computers. The post-quantum value is mainly in the signatures.

## How it works

```
camera (RTSP) -> ffmpeg segments -> agent: sha256 per segment
  -> window of N seconds -> Merkle root -> ML-DSA-87 signature
  -> AnchorRegistry.anchor() on QoreChain (pqcVerify on chain)
  -> receipt JSON next to the recordings (+ OpenTimestamps, planned)
verifier (static web page): file + receipt -> hash, Merkle path, signature, chain record
```

Two layers of post-quantum protection:

1. Chain level. Every EVM transaction needs a registered ML-DSA-87 key and an EVM authorisation window. The agent opens a window that is scoped to the registry contract only (`allowed_targets`).
2. Application level. The contract verifies the ML-DSA-87 signature over each root with the `pqcVerify` precompile (`0x...0A01`) against the key from `pqcKeyStatus` (`0x...0A02`).

## Contract rules

- Anchors are immutable. There is no owner and no upgrade path.
- Windows per (signer, device) must move forward and must not overlap. A later anchor cannot fill a gap in the past.
- A window must end before the block time (120 s skew allowed).
- The signed message is domain-separated: tag, chain ID, registry address, signer, device, window start, window length, leaf count, root.
- Optional: only keys registered with a proof of possession can anchor (`requirePossessionProof`).

## Repository

| Path | Content |
|---|---|
| `contracts/` | `AnchorRegistry`, `MerkleSha256`, `QorePqc` (safe precompile wrappers), test mocks |
| `src/core/` | Merkle tree and signing message, shared by agent and verifier |
| `src/agent/` | Segment hashing, window batching, receipts (work in progress) |
| `scripts/` | EVM window helper, live precompile probes |
| `test/` | Contract and Merkle tests (Hardhat 3, node:test, viem) |
| `docs/` | Architecture, threat model, testnet findings |

## Quick start

```bash
pnpm install --ignore-scripts
pnpm test                 # local tests with precompile mocks
pnpm probe:pqc            # live ML-DSA-87 checks against the testnet precompile, no funds needed
```

Deploy to testnet (needs a funded testnet account, see `.env.example`):

```bash
pnpm window register      # once: register the ML-DSA-87 key
pnpm window open          # open an EVM window
pnpm deploy:testnet
```

## Legal limits

A blockchain anchor is not an eIDAS qualified timestamp. A court weighs it as ordinary evidence. It shows that a file existed at a time. It does not show who recorded it or that the camera told the truth. Keep the original files, the receipts and a record of how you handled them.

## Licence

Apache-2.0. Built on `@qorechain/pqc`, `@qorechain/sdk`, `@qorechain/evm`, `@noble/hashes`, viem and Hardhat. The project started from the `create-qorechain-dapp` Hardhat template (0.12.0). See `AI_USAGE.md` for how AI was used.
