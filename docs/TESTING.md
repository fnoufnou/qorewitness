# Testing

How the contracts are tested, what the tests show and what they do not show.

## Where the tests are

| Place | Runner | What it covers |
|---|---|---|
| `test/*.test.ts` | Hardhat node test runner with viem | 321 tests. Contracts (54 in `test/AnchorRegistry.test.ts`), agent, setup, dashboard, fee sponsor, installer, verifier, live probe logic |
| `test/solidity/Signatures.t.sol` | Hardhat Solidity tests | Signature binding, domain separation, replay, key format, key status forms |
| `test/solidity/AnchorWindows.t.sol` | Hardhat Solidity tests | Stored anchor record and its exact events, changed claim fields, window rules, refBlock rules, revoke and rotate effects, segment proofs on a stored window |
| `test/solidity/DeviceAndViews.t.sol` | Hardhat Solidity tests | Device records, exact device events, status changes, per-owner nonces, `verifyAnchor` shapes, the possession flag of the constructor |
| `test/solidity/QorePqcFailClosed.t.sol` | Hardhat Solidity tests | Missing, broken and hostile precompiles, the 3, 4 and 5 value forms of `pqcKeyStatus` |
| `test/solidity/MerkleSha256.t.sol` | Hardhat Solidity tests | Differential test against the RFC 6962 reference tree |
| `test/solidity/Invariants.t.sol` | Hardhat Solidity tests | Stateful invariant tests with a handler and ghost state, plus a fixed-seed reach walk |
| `test/solidity/utils/` | | Shared setup, reference messages, RFC 6962 reference tree |

The Solidity tests use the test runner built into Hardhat 3 and `forge-std` v1.16.2 (commit `bf647bd`, licence MIT or Apache-2.0) for `Test`, assertions and `StdInvariant`.

## Test boundary

The simulated chain has no QoreChain precompiles. The Solidity tests put `contracts/test/PqcMocks.sol` at `0x0A01` (`pqcVerify`) and `0x0A02` (`pqcKeyStatus`) with `vm.etch`. The verify mock accepts one "signature" per key and message: `keccak256(pubkey) || keccak256(message)`. Anyone can compute it. The mock binds a "signature" to one key and one message and gives no secrecy, so it tests the contract logic only.

These tests do not check real ML-DSA-87. Real ML-DSA-87 is checked on the live testnet:

- `pnpm probe:pqc` calls the live `pqcVerify`. Valid signatures pass. A changed bit, a short signature and a wrong message fail.
- `pnpm probe:pqc:fuzz` sends about 300 seeded mutations of valid inputs to the live `pqcVerify`. `pnpm probe:registry` first checks that the live `pqcVerify` accepts a fresh valid signature and the newest real camera signature over the bytes the live contract builds, then simulates forged, replayed and attacker-signed calls against the live registry v4. Both are read-only. See `docs/LIVE_PROBES.md` and the dated runs in `docs/evidence/`.
- Every live anchor on registry v4 goes through `pqcVerify` on chain.

## Properties (stateless fuzz tests)

Threat ids are from `docs/THREAT_MODEL.md` (A1 to A9) and `docs/AUDIT.md` (ETH-001, ETH-004).

| Property | Threat | Test |
|---|---|---|
| Any signature other than the exact valid one is refused by `registerDevice` (owner and device signature), `revokeDevice`, `rotateDeviceKey` (old and new key) and `anchor`. State stays the same. Five shapes: random bytes, one flipped bit, truncated, extended, 4,627 random bytes | A3 | `Signatures: testFuzz_*_rejectsAnyOtherSignature` |
| The contract signs exactly the reference bytes. The window message is 256 bytes | A3, A7 | `Signatures: testFuzz_messagesMatchReference` |
| A signature does not work for another owner (also one with the same chain key), another device (same key), another registry address, another chain id, or as another action | A3 | `Signatures: testFuzz_domain_*` |
| A held-back or used owner signature dies when the nonce moves. Rotation K1 to K2 to K1 does not revive the first K1 to K2 signatures. No anchor signature works twice | A1, A3 | `Signatures: testFuzz_replay_*` |
| Held-back replay that reaches the signature check: the owner signs action X at nonce n, performs another action Y, and X at nonce n then fails on the signature check itself (`BadOwnerSignature` or `BadOldKeySignature`). X signed at the new nonce succeeds. Every pair of X and Y in register, rotate and revoke | A3 | `Signatures: testFuzz_replay_heldBackReachesSignatureCheck` |
| Nonces are per owner. After another owner moved its nonce, an owner still acts at its own nonce, and a signature at the other owner's nonce is refused | A3 | `DeviceAndViews: testFuzz_nonces_isolatedPerOwner` |
| A device key that is not 2,592 bytes is refused. Rotation needs the current key and a different new key. Each key status form gives the right possession result | A3, A4 | `Signatures: testFuzz_rejectsWrongKeyLength`, `testFuzz_rotate_needsCurrentKeyAndNewKey`, `testFuzz_registry_eachKeyStatusForm` |
| A valid claim is stored field by field. Chain head, `nextWindowStart` and `gapBefore` follow it. `Anchored` has the exact topics and data, `WindowGap` comes first when there is a gap, and the first window of a device emits `Anchored` only | A1, A2 | `AnchorWindows: testFuzz_anchor_storesExactRecord` |
| `registerDevice` stores the exact record (`registeredAt` is the block time) and emits `DeviceRegistered` with the exact fields. Each rotation emits `DeviceKeyRotated` with old and new key hash and the new version, the revoke emits `DeviceRevoked` with the current version | A3, A4 | `DeviceAndViews: testFuzz_register_exactRecordAndEvent`, `testFuzz_rotateAndRevoke_exactEvents` |
| A revoked or unknown device cannot rotate, even with valid signatures (`DeviceNotActive`). Revoked is final: no second revoke, no new registration | A4 | `DeviceAndViews: testFuzz_rotate_revokedOrUnknownDeviceRefused`, `test_status_revokedIsFinal` |
| `verifyAnchor` reports the device status and revocation time now, the chain head and the full anchor. An unknown window gives `found=false`, `included=false`, the computed anchor id and an empty record. An unknown device gives status None and a zero chain head | A1, A4 | `DeviceAndViews: testFuzz_verifyAnchor_statusRevocationAndShapes` |
| `requirePossessionProof` is what the constructor got, and only `true` refuses an owner key without possession proof | A3 | `DeviceAndViews: test_constructor_possessionFlag` |
| Changing any one field of a signed `WindowClaim` never stores an anchor. Each field fails with its own check | A1, A2 | `AnchorWindows: testFuzz_claimFieldMutation` |
| Overlap, zero seconds, zero leaves, longer than one day, end later than block time plus 120 s (with overflow) are refused. Exact edges are tested. The future-window fuzz puts half of its cases within 2 days of the limit, so it hits both sides | A2, ETH-001 | `AnchorWindows: testFuzz_window_*`, `test_window_futureBoundary` |
| A claim whose `prevRoot` is not the chain head is refused even when the device key signed it | A1, A4 | `AnchorWindows: testFuzz_window_forkRefusedEvenWhenSigned` |
| refBlock must be before the current block, at most 256 blocks back, with a non-zero hash that matches where the EVM knows it. Checked against a reference rule, with `vm.roll` and `vm.setBlockhash`. With block hashes unknown as on qorechain-diana, a signed hash of 0 is refused and a non-zero one is accepted, anywhere in the range | A2 | `AnchorWindows: testFuzz_refBlock_*`, `test_refBlock_rangeEdges`, `test_refBlock_zeroSignedHashRefusedWhenUnknown` |
| A revoked device never anchors. After rotation the old key cannot anchor | A4 | `AnchorWindows: testFuzz_revokedDeviceNeverAnchors`, `testFuzz_rotation_oldKeyDead` |
| On a stored window every segment verifies at its index with the stored `leafCount`. Changed segment, other index, index beyond `leafCount` fail | A1 | `AnchorWindows: testFuzz_verifySegment_usesStoredLeafCount` |
| No code at a precompile address reverts `PqcPrecompileInactive`. Any answer to `pqcVerify` gives true only for a first word of exactly 1. A reverting precompile counts as "no" | Fail closed | `QorePqcFailClosed: testFuzz_verify_*`, `test_registry_inactiveVerify` |
| Any answer to `pqcKeyStatus`: shorter than 96 bytes reverts, registered only for a clean `true`, possession only when the answer has 4 or more values. The registry agrees with the decoded answer. 3, 4 and 5 value forms decode the same fields | Fail closed, A3 | `QorePqcFailClosed: testFuzz_keyStatus_*` |
| For random sizes 1 to 300 and random leaves every index verifies with the RFC 6962 reference proof. Every size 1 to 70 and 255, 256, 257 for every index | A1 | `MerkleSha256: testFuzz_everyIndexVerifies`, `test_everyIndexVerifies_allSmallSizesAndEdges` |
| Wrong index, index equal to or above size, one flipped bit in segment, leaf, root or any sibling, a missing or extra proof element, a proof longer than 32 all fail | A1, ETH-004 | `MerkleSha256: testFuzz_*Fails`, `test_indexEqualToSizeFails` |
| An internal node given as a segment does not verify one level up (the 0x00 leaf prefix stops it) | A1 | `MerkleSha256: testFuzz_internalNodeAsLeafFails` |
| A wrong size fails unless the walk is the same for both sizes. See "Findings" | A1 | `MerkleSha256: testFuzz_wrongSize` |

## Invariants (stateful tests)

`RegistryHandler` drives one registry with 3 owners and 4 device ids each. Valid actions: register, rotate, revoke (never the last active device of an owner), anchor 1 to 3 windows, move time and blocks. Attacker actions: anchors with a wrong signature or from the wrong sender, a device-signed fork or backdated window, forged owner actions (wrong key, future nonce, wrong sender, rotation to an attacker key, rogue registration), replay of any earlier successful call, and anchors for a revoked or unregistered device. The ghost state is built from what the handler sent. It never reads the contract's own records.

An unchanged replay of an earlier call is refused by a state check (`DeviceExists`, `DeviceNotActive`, `WindowOverlap` and similar) before the contract reaches the signature check. The replay of a held-back signature that does reach the signature check is the fuzz test `testFuzz_replay_heldBackReachesSignatureCheck` above.

Each invariant runs after every handler call.

| Invariant | Test |
|---|---|
| `chainHead` is the root of the last stored anchor. Each anchor's `prevRoot` is the root of the one before (0 for the first). `anchorCount` equals the ghost count | `invariant_hashChainIntact` |
| Every anchor ever stored reads back identical, all 13 fields, including the device key hash and key version at anchor time | `invariant_anchorsImmutable` |
| Windows of a device never overlap. `nextWindowStart` is the end of the last window. `gapBefore` is the true gap. No window ends later than anchor time plus 120 s. refBlock is before the anchor block | `invariant_windowsOrderedAndGapsTrue` |
| Status, key hash and key version match the ghost. `keyVersion` is 1 plus the number of rotations. A revoked device stays revoked and has no anchor after its revocation | `invariant_devices` |
| Each owner's nonce equals its number of successful register, revoke and rotate calls. The attacker's nonce stays 0 | `invariant_noncesCountOwnerActions` |
| No forged or replayed call was accepted. No valid call was refused. `nextWindowStart`, `keyVersion` and nonces never went down | `invariant_noForgeryNoReplay` |
| After each run, at least half of the handler calls did real work (no early return) | `afterInvariant` |

Reach, measured on 27 Nov 2026 with a temporary logging patch (averages per run):

| Profile | Anchored windows | Rotations | Revocations | Refused attacks |
|---|---|---|---|---|
| default (32 runs x 64 calls) | 12.7 (min 4) | 6.6 | 3.2 | 28.6 |
| deep (256 runs x 100 calls) | 21.5 (min 4, max 50) | 10.8 | 5.3 | 43.6 |

`test_reach_fixedSeedWalk` repeats this in a form anyone can rerun. Its 200 steps give 49 windows, 25 rotations, 9 revocations and 81 refused attacks, and it fails below set minimums.

## Run counts

| Command | Fuzz runs per test | Invariant runs x depth | Time here (2 cores) |
|---|---|---|---|
| `pnpm test` (node and Solidity tests) | 256 | 32 x 64 | about 40 s |
| `pnpm test:sol` | 256 | 32 x 64 | about 20 s |
| `pnpm test:fuzz` (profile `deep`) | 4,096 | 256 x 100 | about 4.5 min |
| `pnpm test:coverage` | 256 | 32 x 64 | about 45 s |

The profiles are in `hardhat.config.ts`. CI runs all three commands.

The fuzz seed is set there too (`0x7727ea51...720450bc`, the Hardhat default), so runs are reproducible: the same seed gives the same fuzz and invariant inputs. We checked that the same seed gives the same invariant counterexample and another seed a different one. Hardhat 3.21 has no command-line flag for the seed. Another seed for one run is set with an environment variable:

```
QW_FUZZ_SEED=0x1234 pnpm test:sol
```

Counts on 28 Nov 2026: 321 node tests and 67 Solidity tests (52 fuzz tests, 6 invariants, 9 unit tests), 388 in total.

## Coverage

`pnpm test:coverage` on 28 Nov 2026, commit `1f5c971`:

| File | Line % | Statement % |
|---|---|---|
| contracts/AnchorRegistry.sol | 100 | 100 |
| contracts/DeviceRegistry.sol | 100 | 100 |
| contracts/MerkleSha256.sol | 100 | 100 |
| contracts/QorePqc.sol | 100 | 100 |

The Solidity tests alone (`npx hardhat test solidity --coverage`) also reach 100 % of lines and statements in the four files. Hardhat 3.21 reports lines and statements only. It has no branch or function coverage. Every function has at least one covered line. The mutation check below is the check on branches.

## Mutation check

A mutant is one bug put into a scratch copy of the contracts. We then ran the Solidity tests. No mutant was ever committed. There were three rounds, 56 mutants in total. "Caught at first" means the tests of that day failed. A mutant that survived got a new test, and the new test was shown to fail on that mutant.

| Round | Mutants | Caught at first | Survived, then caught by a new test |
|---|---|---|---|
| 1. Author, 27 Nov 2026 | 12 | 9 | 3 |
| 2. Independent review, 28 Nov 2026 | 24 | 17 | 7 |
| 3. Follow-up round, 28 Nov 2026 | 20 | 19 | 1 |

Today all 56 make the suite fail.

Round 1:

| Mutant | Caught by |
|---|---|
| Remove the `prevRoot` check (`BrokenChain`) | `testFuzz_window_forkRefusedEvenWhenSigned`, `testFuzz_claimFieldMutation`, 4 invariants |
| Skip the nonce increment in `revokeDevice` | `testFuzz_replay_register`, `testFuzz_replay_revoke`, `invariant_noncesCountOwnerActions`, `invariant_noForgeryNoReplay`, reach walk |
| Drop the device key check in `_activeDeviceKey` | `testFuzz_rotation_oldKeyDead`, 4 invariants, reach walk |
| Merkle `index >= size` changed to `index > size` (survived) | new: `test_indexEqualToSizeFails`, also `testFuzz_wrongIndexFails` |
| Remove the 32-element proof cap (survived) | new: the 2^33 leaf case in `testFuzz_proofLongerThan32Fails` |
| Remove the `ret.length < 32` check in `QorePqc.verify` | `testFuzz_verify_noCodeReverts`, `testFuzz_verify_garbageAnswer`, `test_registry_inactiveVerify` |
| refBlock range 256 changed to 257 (survived) | new: `test_refBlock_rangeEdges` |
| `gapBefore` always 0 | `testFuzz_anchor_storesExactRecord`, `invariant_anchorsImmutable`, `invariant_windowsOrderedAndGapsTrue`, reach walk |
| Window message without the chain id | `testFuzz_domain_otherChainId` |
| `pqcKeyStatus` shape test `offset >= 0x80` changed to `>= 0x60` | `testFuzz_keyStatus_shapes`, `testFuzz_registry_eachKeyStatusForm` |
| Skip the known block hash compare | `testFuzz_refBlock_rules`, `testFuzz_refBlock_knownHashMismatch`, `testFuzz_claimFieldMutation` |
| No `keyVersion` increase on rotation | `testFuzz_rotation_oldKeyDead`, `testFuzz_replay_rotateBackAndForth`, `invariant_devices`, `invariant_anchorsImmutable`, reach walk |

Round 2 (M1 to M24). Caught at first: skip the nonce increment in register (M1) or in rotate (M2), drop the possession check (M3), the algorithm check (M4) or the owner key length check (M5), drop the device key length check in register (M6), `windowStart <= nextAllowed` (M7), leaf prefix 0x02 (M9), drop `p == proof.length` (M10), store `prevRoot` as 0 (M11), no `anchorCount` increase (M12), `revokedAt` not set (M13), re-register a revoked device (M15), register tag in the revoke message (M16), rotate message without the registry address (M17), `verifyAnchor` with `leafCount + 1` (M22). The future skew 120 changed to 100,000 (M8) was caught at first only by the unit test `test_window_futureBoundary`. The fuzz test `testFuzz_window_future` now catches it too.

| Survived at first | New test that catches it |
|---|---|
| M14 rotate a revoked device | `testFuzz_rotate_revokedOrUnknownDeviceRefused` |
| M18 `registeredAt` not set | `testFuzz_register_exactRecordAndEvent`, `testFuzz_rotateAndRevoke_exactEvents` |
| M19 `Anchored` emits `prevRoot` as root | `testFuzz_anchor_storesExactRecord` (exact event) |
| M20 `DeviceRevoked` with key version 0 | `testFuzz_rotateAndRevoke_exactEvents` |
| M21 drop the `refBlockHash == 0` check | `test_refBlock_zeroSignedHashRefusedWhenUnknown`, `testFuzz_refBlock_unknownHashZeroOrNot` |
| M23 `DeviceKeyRotated` with the new hash as old hash | `testFuzz_rotateAndRevoke_exactEvents` |
| M24 `verifyAnchor` without `deviceRevokedAt` | `testFuzz_verifyAnchor_statusRevocationAndShapes` |

Round 3 (R1 to R20), on the suite with the round 2 tests:

| Mutant | Caught by |
|---|---|
| R1 window message with `windowSeconds` and `leafCount` swapped | `testFuzz_messagesMatchReference` and 20 more |
| R2 window message with `refBlock` widened to 32 bytes | `testFuzz_messagesMatchReference` and 20 more |
| R3 `anchorIdOf` with `abi.encodePacked` | `testFuzz_messagesMatchReference`, `testFuzz_anchor_storesExactRecord`, 3 invariants |
| R4 `getAnchor` without `UnknownAnchor` | `testFuzz_anchor_rejectsAnyOtherSignature` |
| R5 `verifyAnchor` reads the chain head of `msg.sender` | `testFuzz_verifySegment_usesStoredLeafCount`, `testFuzz_verifyAnchor_statusRevocationAndShapes` |
| R6 `verifyAnchor` says found for an unknown window | the same two |
| R7 `verifyAnchor` status always Active | `testFuzz_verifyAnchor_statusRevocationAndShapes` |
| R8 `getDevice` reads `msg.sender` | 15 tests, among them `invariant_devices` |
| R9 constructor ignores `requirePossessionProof_` | `test_constructor_possessionFlag`, `testFuzz_registry_eachKeyStatusForm`, `testFuzz_keyStatus_shapes` |
| R10 revoke sets status None | `test_status_revokedIsFinal`, `testFuzz_replay_register`, `invariant_devices` |
| R11 `registeredAt` from `block.number` | `testFuzz_register_exactRecordAndEvent` |
| R12 the first window gets a gap | `testFuzz_anchor_storesExactRecord`, `invariant_windowsOrderedAndGapsTrue` |
| R13 Merkle `index + 1 < size` changed to `<=` | `test_everyIndexVerifies_allSmallSizesAndEdges` and 4 more |
| R14 `DeviceKeyRotated` with the old version | `testFuzz_rotateAndRevoke_exactEvents` |
| R15 `blockNumber` stored from `block.timestamp` | `testFuzz_anchor_storesExactRecord`, `invariant_anchorsImmutable` |
| R16 `WindowGap` with the window start as gap start | `testFuzz_anchor_storesExactRecord` |
| R17 `verifySegment` with `windowSeconds` as tree size | `testFuzz_verifySegment_usesStoredLeafCount` |
| R18 register adds the nonce of another owner (survived) | new: `testFuzz_nonces_isolatedPerOwner` |
| R19 3-value `pqcKeyStatus` reports possession | `testFuzz_keyStatus_shapes`, `testFuzz_registry_eachKeyStatusForm` |
| R20 rotation keeps the old key hash | `testFuzz_rotation_oldKeyDead`, `invariant_devices` and 4 more |

## Findings

No bug was found in the four contracts. Observations:

- `MerkleSha256.verify` does not bind the tree size. A proof for index i in a tree of n leaves also verifies for another size n' when the contract walks both sizes the same way (for example index 0 with 5 or 6 leaves). This is how RFC 6962 roots work. The registry is not affected: it always uses the `leafCount` that the device signed and the contract stored, and a caller cannot pass a size. An off-chain verifier must take the size from the anchor too.
- `QorePqc.keyStatus` tells the 3-value answer from the 4-value answer by the offset word. A non-canonical 3-value answer with an offset of 0x80 or more is read as 4 values. Only a precompile that answers wrongly can send that, and the precompile is the trust root anyway.
- When `pqcVerify` reverts, `QorePqc.verify` returns false. The registry then reports `BadSignature`. Only empty return data gives `PqcPrecompileInactive`. Both fail closed.
- `rotateDeviceKey` needs the old and the new device key but no owner signature, and it moves the owner's nonce. Whoever holds the owner account and the device key (A4, an intruder on the recorder) can rotate before a pending revoke and so make that revoke signature stale. The owner then signs again at the new nonce. This is by design (see the contract NatSpec) and is noted here for review.

## How to rerun

```
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm test:fuzz
pnpm test:coverage
```

`pnpm test:coverage` prints the table and writes `coverage/html/index.html` and `coverage/lcov.info`. A single file runs with `npx hardhat test solidity test/solidity/MerkleSha256.t.sol`.

## Limits

- The precompiles are mocks. Real ML-DSA-87 signing and verification are not part of these tests. The live probes (`docs/LIVE_PROBES.md`) and the live anchors on registry v4 cover them.
- The mock compares the "signature" with `keccak256(pubkey) || keccak256(message)`, which anyone can compute. It binds a "signature" to one key and one message and gives no secrecy, so it tests the contract logic only. A flaw that only shows with real ML-DSA-87 (for example a signature malleability in the precompile) cannot show here.
- The simulator gives block hashes for recent blocks. qorechain-diana returns 0 for `BLOCKHASH`. Both cases are tested with `vm.setBlockhash`, but the chain itself is not.
- Hardhat 3.21 has no branch coverage. The mutation check covers 56 hand-picked mutants. Other changes to the code may still go unnoticed.
- When a long Solidity test fails, Hardhat replays it with step tracing, which needs a lot of memory. The reach walk is kept at 200 steps for that reason.
