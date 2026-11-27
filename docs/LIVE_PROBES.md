# Live probes

The contract tests in `test/` replace the QoreChain precompiles with mocks. These probes use the real ones. They talk to the public testnet `qorechain-diana` (EVM chain id 9800) with `eth_call` only. They need no key, no funds and no account, and they never send a transaction.

| Command | What it runs |
|---|---|
| `pnpm probe:pqc` | 6 hand-picked calls to the live `pqcVerify` (valid, hedged, tampered, other message, short, empty message) |
| `pnpm probe:pqc:fuzz` | About 300 seeded mutations of a valid input against the live `pqcVerify`. Options: `--seed N`, `--cases N`, `--report file.md` |
| `pnpm probe:registry` | Negative simulations against the live AnchorRegistry v4. Option: `--report file.md` |

Dated logs of real runs are in `docs/evidence/`. A separate workflow, `.github/workflows/live-probe.yml`, runs the three commands once a day and on push to main. It is not part of the `test` workflow, because a public testnet can be down. A red run there means the testnet needs a look.

Rules of the scripts: requests run one after another or with at most 3 at once, with a small gap and retries with backoff. If the RPC does not answer, the script says so and exits with code 5. An RPC error is never counted as a pass.

## 1. Mutation fuzz of pqcVerify

What it does:

1. Positive controls first. Three fresh ML-DSA-87 keys, each with a deterministic and a hedged signature, must return `true`. If one does not, the run stops. A dead precompile must not look like "every forgery was rejected".
2. Then the negative cases. Each is a valid triple (public key, signature, message) with one thing broken. The classes are single bit flips in the signature (spread over c-tilde, z, hint positions and hint counts), the public key and the message, a signature of another key, a signature of another message, truncated and extended signature and key, an all-zero and an all-0xff signature, swapped argument order, wrong lengths and empty inputs.
3. Every negative must return `false` or revert. `true` is a failure. The script counts `false`, revert and not run apart.

The seed and the case count are printed and written to the report. The keys, messages and mutations follow from the seed. A hedged signature uses fresh randomness, so only the positive controls differ between two runs with the same seed.

Exit codes: 0 all good, 2 a positive control failed, 3 a mutated input was accepted, 4 more than 2% of the cases could not run, 5 the RPC is down.

What it shows: on the day of the run, the live precompile accepted fresh valid signatures and returned `false` for every mutated input in the sample.

What it does not show:

- It is not a proof of ML-DSA conformance. About 300 cases cannot cover the input space, and the precompile is a black box here.
- It is not a security audit of the precompile or of the chain.
- It does not test timing, resource use or what happens inside a block. A call to the precompile through `eth_call` is not a transaction.
- A passing run says nothing about other days. The daily workflow only repeats the sample.

## 2. Live registry simulations

`pnpm probe:registry` reads the live state of the camera owner (device id, the device public key from a recent anchor transaction, `chainHead`, `nextWindowStart`, a recent block and its hash). It builds a window claim that passes every check except the signature and calls `anchor` with `from` set to the owner address. `eth_call` needs no signature, so this works without the owner key.

The expected answer is a custom error, decoded by its selector:

| Simulation | Expected |
|---|---|
| `anchor` with a random 4,627-byte signature | `BadSignature()` |
| `anchor` with a real old signature of the device (replay on a new window) | `BadSignature()` |
| `anchor` with a valid ML-DSA-87 signature of a fresh attacker key over the exact signing message | `BadSignature()` |
| `anchor` with the attacker's own public key | `DeviceKeyMismatch` |
| `anchor` with the right key and a wrong `prevRoot` | `BrokenChain` |
| `revokeDevice` and `registerDevice` from the owner address with a random or attacker signature | `BadOwnerSignature()` |
| `verifyAnchor` for the public sample receipt | found and included |
| the same with one flipped bit in the segment link | found, not included |

Before the simulations the script also checks that the signing message it builds is byte for byte the one the contract returns from `signingMessage()` and `revokeMessage()`.

What `BadSignature()` shows: `anchor` checks the window, the chain head, the reference block and the device key before it calls the precompile. So the claim got past all of them and the real `pqcVerify`, called by the real contract, did not accept the signature. For the owner actions, `BadOwnerSignature()` also shows that the owner's chain key was found (registered, ML-DSA-87, right size, possession proven).

What it does not show:

- The contract cannot tell "the precompile returned false" from "the precompile call failed". `QorePqc.verify` returns false for both. An inactive precompile gives a different error (`PqcPrecompileInactive`), so a missing precompile would not look like `BadSignature()`.
- The valid-signature path of the real device key is not simulated, because the key is not available. That path is shown by the real anchor transactions of the live camera. A simulation with a state override cannot stand in for it (see below).
- A simulation is not a transaction. It says nothing about inclusion in a block, fees or EVM windows.

## What we learned about eth_call on qorechain-diana (27 Nov 2026)

- `eth_call` of state-changing functions works. The node returns the revert data of the contract, including custom errors. It does not ask for an EVM window and `from` can be any address, also the real owner.
- The window of the live camera is 600 seconds and it ends after the latest block most of the time. Calling `anchor` with `nextWindowStart` and 600 seconds gives `WindowInFuture`. The probe shortens the window to the time that has passed, with at least 1 second.
- **State overrides switch the PQC precompile off.** A plain `eth_call` of `pqcVerify` with a valid signature returns `true`. The same call with a third parameter, even an empty object `{}`, returns `0x` (empty). Inside the registry the result is `PqcPrecompileInactive()` (selector `0xc0975f58`). Checked several times. So one cannot simulate a successful `anchor` by overriding the stored device key. The probes never send overrides, and the fuzz treats empty return data as "not run".
- The table in `docs/TESTNET_FINDINGS.md` (9 Nov) says `false` for a valid signature over an empty message and that empty messages are refused. Today `pqcVerify` returns `true` for a valid signature over an empty message, on every run of `probe:pqc`. The signature is really over the empty message, so `true` is right. The old line is out of date or the precompile changed.
