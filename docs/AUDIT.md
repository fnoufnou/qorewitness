# QCAI audit

Two-stage audit with the QCAI Contract Auditor on dashboard.qorechain.io, as the organisers describe for the Post-Quantum dApp track: run the auditor, fix the findings, run it again.

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

## Stage 2

Input: `contracts/` of registry v3, same order. Report link follows.
