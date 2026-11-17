# QCAI audit

Two-stage audit with the QCAI Contract Auditor on dashboard.qorechain.io, as the organisers describe for the Post-Quantum dApp track: run the auditor, fix the findings, run it again. Stages 3 and 4 audit registry v4, the contract that runs today.

| Stage | Date (UTC) | Code | Setting | Score | Report (copy in `docs/audit/`) |
|---|---|---|---|---|---|
| 1 | 2026-11-12 | registry v2 | Ethereum (EVM/Solidity) | 82 | `2026-11-12-stage1-registry-v2-...html` |
| 2 | 2026-11-13 | registry v3 (stage 1 fixes) | Ethereum (EVM/Solidity) | 72 | `2026-11-13-stage2-registry-v3-...html` |
| 3 | 2026-11-15 | registry v4 | QoreChain (CosmWasm + PQC) | 78 | `2026-11-15-stage3-registry-v4-qorechain-setting-...html` |
| 4 | 2026-11-17 | registry v4 (same input as stage 3) | Ethereum (EVM/Solidity) | 85 | `2026-11-17-stage4-registry-v4-...html` |

The QoreChain team advises the Ethereum setting for Solidity contracts, the same setting for every stage, and "Not scored" for quantum readiness is expected there (16 Nov 2026). Stage 3 used the CosmWasm setting, which flags Solidity as a mismatch. Stage 4 repeats the same input with the advised setting, so stages 1, 2 and 4 compare directly. The quantum-safety evidence is in the section "Where QoreWitness calls the PQC precompiles".

## Stage 1 (12 Nov 2026)

- Report: https://qorechain-audit-reports-362958365954.s3.amazonaws.com/audits/QCAIA-1794466215610-895C6EAD/report.html
- Audit id: `QCAIA-1794466215610-895C6EAD`
- Input: `contracts/` at commit `a10def6` (registry v2), flattened in this order: `QorePqc.sol`, `DeviceRegistry.sol`, `MerkleSha256.sol`, `AnchorRegistry.sol`. Chain setting: Ethereum (EVM/Solidity), because QoreChain EVM is not in the list.
- Result: score 82, risk MEDIUM. 5 findings: 1 high, 2 medium, 1 low, 1 info.

## Changelog: findings and changes

| Id | Severity | Finding | Assessment | Change |
|---|---|---|---|---|
| ETH-001 | High | `windowStart + windowSeconds` in `_checkWindow` can overflow for a very large `windowSeconds` | Solidity 0.8 checks arithmetic, so an overflow reverts and cannot accept a bad window. The finding still points at a real gap: v2 accepts windows of any length. | Fixed in v3. `MAX_WINDOW_SECONDS = 86_400` (1 day) and a new error `WindowTooLong`. Test: "rejects windows longer than one day (audit ETH-001)". |
| ETH-002 | Medium | `anchor` has no access control beyond device ownership | By design. Only the owner account can anchor for its devices, and the current device key must sign every root with ML-DSA-87. The chain also needs the owner's ML-DSA-87 key and an EVM window scoped to the registry for every tx. A stolen ECDSA key cannot anchor (Q-Day Drill dry run: 13 attacks, 0 succeeded). | No code change. |
| ETH-003 | Medium | Front-running of anchors through timestamp validation | Anchors are keyed by (owner, device, windowStart). Another account cannot write into this key space, so it cannot front-run or block an owner's window. The block time is the trusted "existed before" time. The window end may be at most 120 s ahead of it. | No code change. |
| ETH-004 | Low | Unbounded loop in `MerkleSha256.verify` | The loop runs once per tree level, so at most 32 times for a `uint32` leaf count, and the proof length is checked. | Fixed in v3. `MAX_PROOF_LENGTH = 32`: longer proofs return false at once. Same limit in `src/core/merkle.ts`. Test: "rejects Merkle proofs longer than 32 hashes (audit ETH-004)". |
| ETH-005 | Info | No ERC standard | Not applicable. The registry is not a token. | No change. |

v3 keeps the signed message format of v2 (domain tag `QoreWitness/AnchorRegistry/v2`). The registry address is part of every signed message, so v2 signatures do not work on v3.

Registry v3: `0x238A1D989c1f0561d4DD51d4B322C491A5cb1CD2` on qorechain-diana, deployed 12 Nov 2026 in block 9,938,126. Tests: 43 passing.

## Stage 2 (13 Nov 2026)

- Report: https://qorechain-audit-reports-362958365954.s3.amazonaws.com/audits/QCAIA-1794552433002-3DE3CBCB/report.html
- Audit id: `QCAIA-1794552433002-3DE3CBCB`
- Input: `contracts/` at commit `404010e` (registry v3, `0x238A1D989c1f0561d4DD51d4B322C491A5cb1CD2`), flattened in the same order. Chain setting: Ethereum (EVM/Solidity).
- Result: score 72, risk MEDIUM. 5 findings: 1 high, 2 medium, 1 low, 1 info.

| Id | Severity | Finding | Our assessment | Change |
|---|---|---|---|---|
| ETH-001 | High | Window overlap: `nextWindowStart` "can be manipulated" through overlapping anchors | Likely a false positive. The pointer is keyed by `msg.sender`, so an account can only move its own pointer. It only moves forward. `_checkWindow` reverts `WindowOverlap` for any start before it, and a window cannot end later than block time plus 120 s. Tests cover overlap and future windows. | No code change. Explain here. |
| ETH-002 | Medium | No access control beyond device key verification | Same as stage 1 ETH-002. By design. | No change. |
| ETH-003 | Medium | Overflow in `windowStart + windowSeconds` | Fixed in v3: `windowSeconds` is at most `MAX_WINDOW_SECONDS` (1 day) and Solidity 0.8 checks arithmetic. The auditor did not pick up the fix. | Done in v3 (stage 1 ETH-001). |
| ETH-004 | Low | Unbounded proof length in `MerkleSha256.verify` | Fixed in v3: proofs longer than `MAX_PROOF_LENGTH` (32) return false before the loop. The auditor did not pick up the fix. | Done in v3 (stage 1 ETH-004). |
| ETH-005 | Info | No ERC standard | Not applicable. | No change. |

Note: the stage 2 score is lower than stage 1 (72 against 82), with the same code fixes in place. To our knowledge the auditor output varies per run. The report also shows quantum readiness "0%", although every anchor and key action is checked on chain with `pqcVerify` (ML-DSA-87). The API returns `quantumReadiness: null`, so this is likely a missing value and not a result.

## Stage 3: registry v4 (15 Nov 2026)

Registry v4 adds the chain of custody (chained windows, reference block, gaps on chain). New code, so a new audit run.

- Report: https://qorechain-audit-reports-362958365954.s3.amazonaws.com/audits/QCAIA-1794725697151-41DCDCA7/report.html (public, `QCAIA-1794725697151-41DCDCA7`).
- Input: `docs/audit/AnchorRegistry.v4.flat.sol` (Hardhat flatten of commit 6fccf05, SHA-256 `2e532218a16cd111fbb4bf96fc4cd52b66f936801ef44ad8291f00a0efdd2080`). Deployed at `0xa1378D6558B32e1f8d37b68cf90e3C93839Da365`.
- Chain setting "QoreChain (CosmWasm + PQC)". The team later advised the Ethereum setting for Solidity (see stage 4). With this setting the auditor returns a quantum readiness value: **QUANTUM-SAFE**. (The report page still shows "0%". The API value is text, so this is likely a display issue.) It also labels the code as Rust, which it is not.
- Score 78, risk medium. 1 high, 2 medium, 1 low, 1 info.

| Finding | Severity | Our assessment | Action |
|---|---|---|---|
| Missing quantum resistance in a Solidity contract | High | Not applicable. Every state change needs an ML-DSA-87 signature that the contract checks on chain with `pqcVerify`. The finding is generic and likely comes from the CosmWasm chain setting. | No change. |
| Reentrancy risk in device registration | Medium | Not applicable. `registerDevice` checks both signatures before it writes any state, and the only external calls are `staticcall`s to precompiles, which cannot re-enter. | No change. |
| Insufficient validation of the reference block hash | Medium | Partly right in spirit, wrong in detail. A zero hash is refused (`BadRefBlock`). The real limit is different: on qorechain-diana `BLOCKHASH` returns 0, so the contract cannot compare the hash itself. Verifiers compare it with the chain (`docs/SPEC.md`, section 4). | Documented. |
| Inconsistent error handling in the PQC library | Low | By design: a failed call returns false (bad signature), an empty or short answer reverts (precompile missing). Fail closed. | No change. |
| ML-DSA key length assumption | Info | By design: the registry accepts ML-DSA-87 only and checks the algorithm id and key length. A new algorithm means a new registry version. | No change. |

## Stage 4: registry v4, Ethereum setting (17 Nov 2026)

- Report: https://qorechain-audit-reports-362958365954.s3.amazonaws.com/audits/QCAIA-1794898425611-F962122E/report.html (public, `QCAIA-1794898425611-F962122E`)
- Input: `docs/audit/AnchorRegistry.v4.flat.sol`, the same file as stage 3 (SHA-256 `2e532218a16cd111fbb4bf96fc4cd52b66f936801ef44ad8291f00a0efdd2080`, checked before upload). Deployed at `0xa1378D6558B32e1f8d37b68cf90e3C93839Da365`.
- Setting "Ethereum (EVM/Solidity)". Score 85, risk medium, quantum readiness "Not scored". 1 high, 2 medium, 1 low, 1 info.

| Finding | Severity | Our assessment | Evidence (`test/AnchorRegistry.test.ts`) |
|---|---|---|---|
| Window overlap after a device is revoked and registered again | High | False positive. Revoke is final: a device id with any status other than "none" cannot be registered again (`DeviceExists`). So `nextWindowStart` and the chain head of a device never reset. | New regression test: "a revoked device id cannot be registered again, so its window chain never resets (audit stage 4)". Also "rejects a second registration of the same device id". |
| Overflow in the gap calculation | Medium | False positive. The gap is computed only after the overlap check, so `windowStart >= nextAllowed`. Solidity 0.8 checks arithmetic and would revert in any case. | "rejects overlapping and backdated windows", "stores the gap before a window and emits WindowGap" |
| Missing access control on `anchor` | Medium | By design. Anyone may send the call, but only a registered, active camera key can sign a claim, and the signed message names the sender as owner. Another account with a valid signature is refused. | "rejects another account that sends the device key and a valid signature", "rejects an unregistered device", "rejects a bad device signature" |
| Unbounded loop in Merkle verification | Low | Bounded by design: proofs longer than 32 hashes are refused (stage 1 fix). | "rejects Merkle proofs longer than 32 hashes (audit ETH-004)" |
| No ERC interface | Info | Not applicable. The registry is not a token and needs no ERC interface. | - |

## Where QoreWitness calls the PQC precompiles

The quantum-safe part of QoreWitness runs on chain. Every state change needs an ML-DSA-87 signature that the contract checks itself. The auditor's EVM setting gives no quantum readiness score ("Not scored" is expected, team answer of 16 Nov 2026), so this section shows it.

All calls go through `contracts/QorePqc.sol`. It uses `staticcall` only, so a precompile cannot change state or call back into the registry.

| Call | Where | What it protects | Tests (`test/AnchorRegistry.test.ts`) |
|---|---|---|---|
| `pqcVerify` (0x...0a01) | `DeviceRegistry.registerDevice` | Only the owner (registered ML-DSA-87 key) can add a camera, and the camera proves it holds its key | "registers a device with owner and device signatures", "rejects a bad owner signature", "rejects a missing device proof of possession", "rejects a replayed register signature (nonce)" |
| `pqcVerify` | `DeviceRegistry.revokeDevice` | Only the owner can revoke a camera | "revokes a device with the owner signature, final", "rejects revoke with a bad owner signature, or with the device key", "rejects a replayed revoke signature" |
| `pqcVerify` | `DeviceRegistry.rotateDeviceKey` | A key changes only with signatures from the old and the new key | "rotates with signatures from the old and the new key", "rejects rotation without a valid old-key signature", "rejects rotation without a valid new-key signature", "rejects a replayed rotation (nonce)" |
| `pqcVerify` | `AnchorRegistry.anchor` | A window root is accepted only with the camera's signature over the full claim (owner, window, root, previous root, reference block) | "rejects a bad device signature", "rejects a signature by the owner key instead of the device key", "rejects another account that sends the device key and a valid signature", "rejects a signature over another block hash than the claim" |
| `pqcKeyStatus` (0x...0a02) | `DeviceRegistry._ownerKey` | The owner must have an ML-DSA-87 key on chain (2,592 bytes, algorithm 1), with proof of possession where required | "rejects an owner without a PQC key on chain", "rejects an owner key without proof of possession when required", "accepts the 3-value pqcKeyStatus form when no proof of possession is required" |
| Both | `QorePqc` wrapper | Fail closed: an empty or short answer from a precompile reverts (`PqcPrecompileInactive`). An anchor is never accepted without a real check. | "refuses to register a device when pqcVerify answers nothing", "refuses to anchor when pqcVerify answers nothing, and keeps no record", "refuses to register a device when pqcKeyStatus answers nothing" |

The local tests use mock precompiles. Real ML-DSA-87 verification is checked against testnet with `pnpm probe:pqc`, and every live anchor since 9 Nov 2026 passed `pqcVerify` on chain.

The stage 3 low finding ("inconsistent error handling in the PQC library") maps to the fail-closed row above: the behaviour is by design, now covered by three regression tests (16 Nov 2026).

