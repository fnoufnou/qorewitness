# Testing

How the contracts are tested, what the tests show and what they do not show.

## Where the tests are

| Place | Runner | What it covers |
|---|---|---|
| `test/*.test.ts` | Hardhat node test runner with viem | 308 tests. Contracts (54 in `test/AnchorRegistry.test.ts`), agent, setup, dashboard, fee sponsor, installer, verifier, live probe logic |
| `test/solidity/Signatures.t.sol` | Hardhat Solidity tests | Signature binding, domain separation, replay, key format, key status forms |
| `test/solidity/AnchorWindows.t.sol` | Hardhat Solidity tests | Stored anchor record, changed claim fields, window rules, refBlock rules, revoke and rotate effects, segment proofs on a stored window |
| `test/solidity/QorePqcFailClosed.t.sol` | Hardhat Solidity tests | Missing, broken and hostile precompiles, the 3, 4 and 5 value forms of `pqcKeyStatus` |
| `test/solidity/MerkleSha256.t.sol` | Hardhat Solidity tests | Differential test against the RFC 6962 reference tree |
| `test/solidity/Invariants.t.sol` | Hardhat Solidity tests | Stateful invariant tests with a handler and ghost state, plus a fixed-seed reach walk |
| `test/solidity/utils/` | | Shared setup, reference messages, RFC 6962 reference tree |

The Solidity tests use the test runner built into Hardhat 3 and `forge-std` v1.16.2 (commit `bf647bd`, licence MIT or Apache-2.0) for `Test`, assertions and `StdInvariant`.

## Test boundary

The simulated chain has no QoreChain precompiles. The Solidity tests put `contracts/test/PqcMocks.sol` at `0x0A01` (`pqcVerify`) and `0x0A02` (`pqcKeyStatus`) with `vm.etch`. The verify mock accepts one "signature" per key and message: `keccak256(pubkey) || keccak256(message)`. A signature is bound to its key and its message, so fuzzing the registry logic against it is meaningful.

These tests do not check real ML-DSA-87. Real ML-DSA-87 is checked on the live testnet:

- `pnpm probe:pqc` calls the live `pqcVerify`. Valid signatures pass. A changed bit, a short signature and a wrong message fail.
- `pnpm probe:pqc:fuzz` sends about 300 seeded mutations of valid inputs to the live `pqcVerify`. `pnpm probe:registry` simulates forged, replayed and attacker-signed calls against the live registry v4. Both are read-only. See `docs/LIVE_PROBES.md` and the dated runs in `docs/evidence/`.
- Every live anchor on registry v4 goes through `pqcVerify` on chain.

## Properties (stateless fuzz tests)

Threat ids are from `docs/THREAT_MODEL.md` (A1 to A9) and `docs/AUDIT.md` (ETH-001, ETH-004).

| Property | Threat | Test |
|---|---|---|
| Any signature other than the exact valid one is refused by `registerDevice` (owner and device signature), `revokeDevice`, `rotateDeviceKey` (old and new key) and `anchor`. State stays the same. Five shapes: random bytes, one flipped bit, truncated, extended, 4,627 random bytes | A3 | `Signatures: testFuzz_*_rejectsAnyOtherSignature` |
| The contract signs exactly the reference bytes. The window message is 256 bytes | A3, A7 | `Signatures: testFuzz_messagesMatchReference` |
| A signature does not work for another owner (also one with the same chain key), another device (same key), another registry address, another chain id, or as another action | A3 | `Signatures: testFuzz_domain_*` |
| A held-back or used owner signature dies when the nonce moves. Rotation K1 to K2 to K1 does not revive the first K1 to K2 signatures. No anchor signature works twice | A1, A3 | `Signatures: testFuzz_replay_*` |
| A device key that is not 2,592 bytes is refused. Rotation needs the current key and a different new key. Each key status form gives the right possession result | A3, A4 | `Signatures: testFuzz_rejectsWrongKeyLength`, `testFuzz_rotate_needsCurrentKeyAndNewKey`, `testFuzz_registry_eachKeyStatusForm` |
| A valid claim is stored field by field. Chain head, `nextWindowStart` and `gapBefore` follow it | A1, A2 | `AnchorWindows: testFuzz_anchor_storesExactRecord` |
| Changing any one field of a signed `WindowClaim` never stores an anchor. Each field fails with its own check | A1, A2 | `AnchorWindows: testFuzz_claimFieldMutation` |
| Overlap, zero seconds, zero leaves, longer than one day, end later than block time plus 120 s (with overflow) are refused. Exact edges are tested | A2, ETH-001 | `AnchorWindows: testFuzz_window_*`, `test_window_futureBoundary` |
| A claim whose `prevRoot` is not the chain head is refused even when the device key signed it | A1, A4 | `AnchorWindows: testFuzz_window_forkRefusedEvenWhenSigned` |
| refBlock must be before the current block, at most 256 blocks back, with a non-zero hash that matches where the EVM knows it. Checked against a reference rule, with `vm.roll` and `vm.setBlockhash`, also with hashes unknown as on qorechain-diana | A2 | `AnchorWindows: testFuzz_refBlock_*`, `test_refBlock_rangeEdges` |
| A revoked device never anchors. After rotation the old key cannot anchor | A4 | `AnchorWindows: testFuzz_revokedDeviceNeverAnchors`, `testFuzz_rotation_oldKeyDead` |
| On a stored window every segment verifies at its index with the stored `leafCount`. Changed segment, other index, index beyond `leafCount` fail | A1 | `AnchorWindows: testFuzz_verifySegment_usesStoredLeafCount` |
| No code at a precompile address reverts `PqcPrecompileInactive`. Any answer to `pqcVerify` gives true only for a first word of exactly 1. A reverting precompile counts as "no" | Fail closed | `QorePqcFailClosed: testFuzz_verify_*`, `test_registry_inactiveVerify` |
| Any answer to `pqcKeyStatus`: shorter than 96 bytes reverts, registered only for a clean `true`, possession only when the answer has 4 or more values. The registry agrees with the decoded answer. 3, 4 and 5 value forms decode the same fields | Fail closed, A3 | `QorePqcFailClosed: testFuzz_keyStatus_*` |
| For random sizes 1 to 300 and random leaves every index verifies with the RFC 6962 reference proof. Every size 1 to 70 and 255, 256, 257 for every index | A1 | `MerkleSha256: testFuzz_everyIndexVerifies`, `test_everyIndexVerifies_allSmallSizesAndEdges` |
| Wrong index, index equal to or above size, one flipped bit in segment, leaf, root or any sibling, a missing or extra proof element, a proof longer than 32 all fail | A1, ETH-004 | `MerkleSha256: testFuzz_*Fails`, `test_indexEqualToSizeFails` |
| An internal node given as a segment does not verify one level up (the 0x00 leaf prefix stops it) | A1 | `MerkleSha256: testFuzz_internalNodeAsLeafFails` |
| A wrong size fails unless the walk is the same for both sizes. See "Findings" | A1 | `MerkleSha256: testFuzz_wrongSize` |

## Invariants (stateful tests)

`RegistryHandler` drives one registry with 3 owners and 4 device ids each. Valid actions: register, rotate, revoke (never the last active device of an owner), anchor 1 to 3 windows, move time and blocks. Attacker actions: anchors with a wrong signature or from the wrong sender, a device-signed fork or backdated window, forged owner actions (wrong key, future nonce, wrong sender, rotation to an attacker key, rogue registration), replay of any earlier successful call, and anchors for a revoked or unregistered device. The ghost state is built from what the handler sent, not from the contract.

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
| `pnpm test` (node and Solidity tests) | 256 | 32 x 64 | about 30 s |
| `pnpm test:sol` | 256 | 32 x 64 | about 30 s |
| `pnpm test:fuzz` (profile `deep`) | 4,096 | 256 x 100 | about 4.5 min |
| `pnpm test:coverage` | 256 | 32 x 64 | about 45 s |

The profiles are in `hardhat.config.ts`. The fuzz seed is Hardhat's fixed default. CI runs all three commands.

Counts on 28 Nov 2026: 308 node tests and 57 Solidity tests (45 fuzz tests, 6 invariants, 6 unit tests), 365 in total.

## Coverage

`pnpm test:coverage` on 27 Nov 2026, commit `d1896cb`:

| File | Line % | Statement % |
|---|---|---|
| contracts/AnchorRegistry.sol | 100 | 100 |
| contracts/DeviceRegistry.sol | 100 | 100 |
| contracts/MerkleSha256.sol | 100 | 100 |
| contracts/QorePqc.sol | 100 | 100 |

The Solidity tests alone (`npx hardhat test solidity --coverage`) also reach 100 % of lines and statements in the four files. Hardhat 3.21 reports lines and statements only, not branches or functions. Every function has at least one covered line. The mutation check below is the check on branches.

## Mutation check

On 27 Nov 2026 we put one bug at a time into a scratch copy of the contracts and ran the Solidity tests. The mutants were never committed. Every mutant made the suite fail.

| Mutant | Caught by |
|---|---|
| Remove the `prevRoot` check (`BrokenChain`) | `testFuzz_window_forkRefusedEvenWhenSigned`, `testFuzz_claimFieldMutation`, 4 invariants |
| Skip the nonce increment in `revokeDevice` | `testFuzz_replay_register`, `testFuzz_replay_revoke`, `invariant_noncesCountOwnerActions`, `invariant_noForgeryNoReplay`, reach walk |
| Drop the device key check in `_activeDeviceKey` | `testFuzz_rotation_oldKeyDead`, 4 invariants, reach walk |
| Merkle `index >= size` changed to `index > size` | `test_indexEqualToSizeFails`, `testFuzz_wrongIndexFails` |
| Remove the 32-element proof cap | `testFuzz_proofLongerThan32Fails` |
| Remove the `ret.length < 32` check in `QorePqc.verify` | `testFuzz_verify_noCodeReverts`, `testFuzz_verify_garbageAnswer`, `test_registry_inactiveVerify` |
| refBlock range 256 changed to 257 | `test_refBlock_rangeEdges` |
| `gapBefore` always 0 | `testFuzz_anchor_storesExactRecord`, `invariant_anchorsImmutable`, `invariant_windowsOrderedAndGapsTrue`, reach walk |
| Window message without the chain id | `testFuzz_domain_otherChainId` |
| `pqcKeyStatus` shape test `offset >= 0x80` changed to `>= 0x60` | `testFuzz_keyStatus_shapes`, `testFuzz_registry_eachKeyStatusForm` |
| Skip the known block hash compare | `testFuzz_refBlock_rules`, `testFuzz_refBlock_knownHashMismatch`, `testFuzz_claimFieldMutation` |
| No `keyVersion` increase on rotation | `testFuzz_rotation_oldKeyDead`, `testFuzz_replay_rotateBackAndForth`, `invariant_devices`, `invariant_anchorsImmutable`, reach walk |

In the first round the mutants "index > size", "no proof cap" and "range 257" survived. The tests `test_indexEqualToSizeFails`, the 2^33 leaf case in `testFuzz_proofLongerThan32Fails` and `test_refBlock_rangeEdges` were added for them.

## Findings

No bug was found in the four contracts. Observations:

- `MerkleSha256.verify` does not bind the tree size. A proof for index i in a tree of n leaves also verifies for another size n' when the contract walks both sizes the same way (for example index 0 with 5 or 6 leaves). This is how RFC 6962 roots work. The registry is not affected: it always uses the `leafCount` that the device signed and the contract stored, and a caller cannot pass a size. An off-chain verifier must take the size from the anchor too.
- `QorePqc.keyStatus` tells the 3-value answer from the 4-value answer by the offset word. A non-canonical 3-value answer with an offset of 0x80 or more is read as 4 values. Only a precompile that answers wrongly can send that, and the precompile is the trust root anyway.
- When `pqcVerify` reverts, `QorePqc.verify` returns false. The registry then reports `BadSignature`, not `PqcPrecompileInactive`. This fails closed.
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
- The mock accepts a keyed hash, not a signature. A flaw that only shows with real ML-DSA-87 (for example a signature malleability in the precompile) cannot show here.
- The simulator gives block hashes for recent blocks. qorechain-diana returns 0 for `BLOCKHASH`. Both cases are tested with `vm.setBlockhash`, but the chain itself is not.
- Hardhat 3.21 has no branch coverage. The mutation check covers 12 hand-picked mutants, not every possible change.
- When a long Solidity test fails, Hardhat replays it with step tracing, which needs a lot of memory. The reach walk is kept at 200 steps for that reason.
