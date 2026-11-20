# Changelog

Newest first. Dates in UTC. Dependency updates follow the checks in the "Dependencies" section below.

## Unreleased (0.4.0-alpha.1)

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
