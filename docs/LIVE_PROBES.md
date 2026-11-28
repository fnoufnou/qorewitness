# Live probes

The contract tests in `test/` replace the QoreChain precompiles with mocks. These probes use the real ones. They talk to the public testnet `qorechain-diana` (EVM chain id 9800) with `eth_call` only. They need no key, no funds and no account, and they never send a transaction.

| Command | What it runs |
|---|---|
| `pnpm probe:pqc` | 6 hand-picked calls to the live `pqcVerify` (valid, hedged, tampered, other message, short, empty message) |
| `pnpm probe:pqc:fuzz` | About 300 seeded mutations of a valid input against the live `pqcVerify`. Options: `--seed N`, `--cases N`, `--report file.md` |
| `pnpm probe:registry` | Negative simulations against the live AnchorRegistry v4. Option: `--report file.md` |

Dated logs of real runs are in `docs/evidence/`. A separate workflow, `.github/workflows/live-probe.yml`, runs the three commands once a day and on manual start. It does not run on push, and it is not part of the `test` workflow, because a public testnet can be down. A red run there means the testnet needs a look.

Rules of the scripts: requests run one after another or with at most 3 at once, with a small gap and retries with backoff. An RPC error is never counted as a pass.

## Exit codes

| Code | `pnpm probe:pqc:fuzz` | `pnpm probe:registry` |
|---|---|---|
| 0 | All controls true, no mutated input accepted, at most 2% of the cases not run | All controls held and every check gave the expected answer |
| 1 | Other error (for example a bad option) | The live state could not be used: no recent anchor of the camera, device not active, key changed, wrong chain, or a view call reverted. Also other errors |
| 2 | A positive control did not return true. The negative cases were not run | A gating positive control did not hold. The negative simulations were not run |
| 3 | A mutated input was accepted (`pqcVerify` returned true) | A forged or replayed input was accepted (a simulated call succeeded, or `pqcVerify` returned true for a flipped bit) |
| 4 | More than 2% of the cases could not run | A check could not run (a revert without data, or the sample receipt could not be read) |
| 5 | The RPC did not answer | The RPC did not answer, anywhere in the run, also inside view calls during setup. Also when the node did not have the pinned block twice |
| 6 | - | A check gave another answer than expected (another custom error, or a message that differs) |

When several apply, `probe:registry` reports the first in this order: 2, 3, 6, 4.

## 1. Mutation fuzz of pqcVerify

What it does:

1. Positive controls first. Three fresh ML-DSA-87 keys, each with a deterministic and a hedged signature, must return `true`. If one does not, the run stops. A dead precompile must not look like "every forgery was rejected".
2. Then the negative cases. Each is a valid triple (public key, signature, message) with one thing broken. The classes are single bit flips in the signature (spread over c-tilde, z, hint positions and hint counts), the public key and the message, a signature of another key, a signature of another message, truncated and extended signature and key, an all-zero and an all-0xff signature, swapped argument order, wrong lengths and empty inputs.
3. Every negative must return `false` or revert. `true` is a failure. The script counts `false`, revert and not run apart.

The seed and the case count are printed and written to the report. The keys, messages and mutations follow from the seed. A hedged signature uses fresh randomness, so only the positive controls differ between two runs with the same seed.

Exit codes are in the table above. The fuzz calls only the precompile, which reads no contract state, so its calls use the latest block.

What it shows: on the day of the run, the live precompile accepted fresh valid signatures and returned `false` for every mutated input in the sample.

What it does not show:

- It is not a proof of ML-DSA conformance. About 300 cases cannot cover the input space, and the precompile is a black box here.
- It is not a security audit of the precompile or of the chain.
- It does not test timing, resource use or what happens inside a block. A call to the precompile through `eth_call` is not a transaction.
- A passing run says nothing about other days. The daily workflow only repeats the sample.

## 2. Live registry simulations

`pnpm probe:registry` reads the head block number once and pins the whole run to the block two below it. Every `eth_call` and every state read uses that block number as its block tag, so a camera anchor that lands during the run cannot change what the probe sees. If the node says it does not have that block, the run starts once more at a fresh block. A second miss counts as RPC down.

It reads the state of the camera owner at that block: device id, the newest anchor transactions of the camera, the device public key from the newest one, `chainHead`, `nextWindowStart` and a block hash. `eth_call` needs no signature, so `from` can be the owner address. No owner key and no device key are used.

### Gating positive controls

These run first. If one does not hold, the run stops before the negative simulations and exits with code 2.

| Control | Expected |
|---|---|
| `pqcVerify` called directly with a fresh ML-DSA-87 key and a valid signature | `true` |
| The newest real anchor transaction of the camera: its calldata `anchor(WindowClaim, devicePubkey, signature)` is decoded, and `signingMessage(owner, claim)` of the live contract equals the message built here | equal, 256 bytes |
| `pqcVerify(devicePubkey, signature, message from the live contract)` | `true` |
| The same call with one flipped bit in the signature | `false` |
| The same call with one flipped bit in the message | `false` |
| `keccak256(signature)` equals the `sigHash` in the `Anchored` event and in `getAnchor(anchorId)` | equal |
| `keccak256(devicePubkey)` equals the stored `deviceKeyHash` of that anchor | equal |

The real-signature control is a replay of a verification the chain already did when it included the anchor transaction, shown again with `eth_call`. It shows that the live precompile accepts the real camera signature over the exact bytes the live contract builds, without any private key. The two bit flips show that the same call is sensitive to the signature and to the message.

### Negative simulations

The probe builds a window claim that passes every check except the signature and calls `anchor` with `from` set to the owner address. The expected answer is a custom error, decoded by its selector:

| Simulation | Expected |
|---|---|
| `anchor` with a random 4,627-byte signature | `BadSignature()` |
| `anchor` with a real old signature of the device (replay on a new window) | `BadSignature()` |
| `anchor` with a valid ML-DSA-87 signature of a fresh attacker key over the exact signing message | `BadSignature()` |
| `anchor` with the attacker's own public key | `DeviceKeyMismatch` |
| `anchor` with the right key and a wrong `prevRoot` | `BrokenChain` |
| `revokeDevice` and `registerDevice` from the owner address with a random or attacker signature (4 calls) | `BadOwnerSignature()` |
| `verifyAnchor` for the public sample receipt | found and included |
| the same with one flipped bit in the segment link | found, not included |

The script also checks that the messages it builds for the claim and for a revoke are byte for byte the ones the contract returns from `signingMessage()` and `revokeMessage()`. With the state check this gives 21 checks per run.

What `BadSignature()` means: `anchor` checks the window, the chain head, the reference block and the device key before it calls the precompile. So the claim got past all of them, and the precompile did not accept the signature: it returned false or the call failed. `QorePqc.verify` returns false in both cases. An inactive precompile gives `PqcPrecompileInactive` instead. Together with the gating controls in the same run, a dead precompile cannot produce a passing run. For the owner actions, `BadOwnerSignature()` also shows that the owner's chain key was found (registered, ML-DSA-87, right size, possession proven).

A revert without data counts as "not run". It never counts as a pass or as a failure.

What it does not show:

- A simulation is not a transaction. It says nothing about inclusion in a block, fees or EVM windows.
- The device key signs only on the camera, so the probe cannot make a new valid camera signature. The real-signature control replays one the chain already accepted.

### The state override observation

The probe makes exactly one call with an empty state override, on purpose, to record how the node behaves: `pqcVerify` with a fresh valid signature and `{}` as the third parameter of `eth_call`. The report says what the node returned. Empty data means that with a state override the node answered without the PQC precompile. A 32-byte `true` would mean that the node now runs the precompile with overrides. This observation never changes the exit code. No other call of the run has an override.

## What we learned about eth_call on qorechain-diana (27 Nov 2026)

- `eth_call` of state-changing functions works. The node returns the revert data of the contract, including custom errors. It does not ask for an EVM window and `from` can be any address, also the real owner.
- The window of the live camera is 600 seconds and it ends after the latest block most of the time. Calling `anchor` with `nextWindowStart` and 600 seconds gives `WindowInFuture`. The probe shortens the window to the time that has passed, with at least 1 second.
- **State overrides switch the PQC precompile off.** A plain `eth_call` of `pqcVerify` with a valid signature returns `true`. The same call with a third parameter, even an empty object `{}`, returns `0x` (empty). Inside the registry the result is `PqcPrecompileInactive()` (selector `0xc0975f58`). Checked several times, and again by the observation call of the 28 Nov run. So one cannot simulate a successful `anchor` by overriding the stored device key. Apart from that one observation call, the probes send no overrides, and the fuzz treats empty return data as "not run".
- `eth_call` with a block number as the block tag works for recent blocks, also for the PQC precompiles. For a block the node does not have, it answers `header not found`.
- The table in `docs/TESTNET_FINDINGS.md` (9 Nov) says `false` for a valid signature over an empty message and that empty messages are refused. Today `pqcVerify` returns `true` for a valid signature over an empty message, on every run of `probe:pqc`. The signature is really over the empty message, so `true` is right. The old line is out of date or the precompile changed.
