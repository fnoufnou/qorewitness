# Contracts

| File | Role |
|---|---|
| `AnchorRegistry.sol` | Stores one signed Merkle root per camera and time window. Checks the camera's ML-DSA-87 signature on chain. `verifyAnchor` gives a third party one answer. |
| `DeviceRegistry.sol` | Register, rotate and revoke camera keys. The owner key and the camera key both sign. |
| `MerkleSha256.sol` | Merkle proof check (RFC 6962 style, at most 32 hashes). |
| `QorePqc.sol` | Safe wrappers for the QoreChain precompiles `pqcVerify` (`0x...0A01`) and `pqcKeyStatus` (`0x...0A02`). They fail closed. |
| `test/PqcMocks.sol` | Test doubles for the two precompiles. Used by the tests only, never deployed. |

There is no contract owner and no upgrade path. A change ships only with a new deployment.

## Which source runs at which address

All on the QoreChain test network qorechain-diana (EVM chain ID 9800). Compiler: solc 0.8.28, optimizer on, 200 runs.

| Registry | Address | Source |
|---|---|---|
| v4 (live since 14 Nov 2026) | [0xa1378D6558B32e1f8d37b68cf90e3C93839Da365](https://explore.qore.network/address/0xa1378D6558B32e1f8d37b68cf90e3C93839Da365) | Commit `6fccf05`, flattened in [docs/audit/AnchorRegistry.v4.flat.sol](../docs/audit/AnchorRegistry.v4.flat.sol) (SHA-256 `2e532218a16cd111fbb4bf96fc4cd52b66f936801ef44ad8291f00a0efdd2080`) |
| v3 (12 Nov 2026) | [0x238A1D989c1f0561d4DD51d4B322C491A5cb1CD2](https://explore.qore.network/address/0x238A1D989c1f0561d4DD51d4B322C491A5cb1CD2) | Commit `404010e`, flattened in [docs/audit/AnchorRegistry.v3.flat.sol](../docs/audit/AnchorRegistry.v3.flat.sol) |
| v2 (9 Nov 2026) | [0x1854EeE2A659F4f39A05d5832cceC405E8045336](https://explore.qore.network/address/0x1854EeE2A659F4f39A05d5832cceC405E8045336) | Commit `a10def6` (audit stage 1 input) |
| v1 (9 Nov 2026) | [0xA73d4347b50C2A373533915d698Bf03a01c65aAF](https://explore.qore.network/address/0xA73d4347b50C2A373533915d698Bf03a01c65aAF) | Commit `b244b44` (first contracts) |

### Check the v4 source yourself

On 27 Nov 2026 we compiled the v4 flat file with the settings above and compared it with `eth_getCode` of the live address. The runtime bytecode is the same, byte for byte, up to the metadata hash at the end. The metadata hash differs because it covers the file names, and the flat file is one file instead of four. Immutable values were masked for the compare.

### What changed on main after v4

One change: commit `bb89a0f` (21 Nov 2026) in `QorePqc.keyStatus`.

- Live v4 reads `pqcKeyStatus` only when the answer has exactly 3 or 4 values.
- Main also reads a longer answer by position, if the chain appends fields later (QoreChain team guidance, 21 Nov 2026).
- Impact on the live v4 if the chain appends a field: register and revoke fail closed. Anchoring and `verifyAnchor` do not call `pqcKeyStatus`, so they keep working.
- The change ships with the next registry deployment.

Details: [docs/AUDIT.md](../docs/AUDIT.md).

## Why the contract tests use a mock of pqcVerify

The tests run on the Hardhat simulated chain. That chain does not have the QoreChain precompiles. So the tests put `test/PqcMocks.sol` at the precompile addresses.

- The mock checks our logic: who may call, which key must sign, the exact signed message bytes, windows, chaining, revoke and rotate.
- The mock does not check real ML-DSA-87. It accepts a "signature" that is the 64 bytes `keccak256(pubkey) || keccak256(message)`.

Real ML-DSA-87 is checked on chain, by the real precompile:

- `pnpm probe:pqc` calls the live `pqcVerify` with no funds needed. Valid signatures pass. A changed bit, a short signature, a wrong message and an empty message fail. Results: [docs/TESTNET_FINDINGS.md](../docs/TESTNET_FINDINGS.md).
- Every live seal goes through `pqcVerify` inside registry v4. See all seals on the [explorer](https://explore.qore.network/address/0xa1378D6558B32e1f8d37b68cf90e3C93839Da365).
- Q-Day Drill dry run (9 Nov 2026): a forged revoke, a forged anchor, an attacker device and a key rotation to an attacker key were mined and reverted on chain. Log: [docs/TESTNET_FINDINGS.md](../docs/TESTNET_FINDINGS.md).
- After a key rotation, an anchor with the old key reverted with `DeviceKeyMismatch` on registry v2 (tx list in the same file).
