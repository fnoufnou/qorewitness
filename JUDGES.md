# QoreWitness: guide for jurors

Version 28 Nov 2026

- **What it is.** Sealed video for home cameras. A recorder signs the fingerprints of each 10-minute window with the camera's own ML-DSA-87 key. The AnchorRegistry contract on QoreChain checks that signature with the `pqcVerify` precompile before it stores anything.
- **Entry.** Category Post-Quantum dApp, solo builder under the alias fnoufnou. Testnet only (qorechain-diana, EVM chain ID 9800). The PQC precompiles are not on the QoreChain main network yet.
- **Why post-quantum.** Evidence can be needed 10 to 30 years after recording. A classical signature may be broken by then, and ML-DSA-87 keeps the link between camera, owner and time valid ([docs/THREAT_MODEL.md](docs/THREAT_MODEL.md#post-quantum-rationale)).

Video (2 min 43 s): https://youtu.be/RSHszgfsqm8

## Score it in 5 minutes

Steps 1 to 3 need a browser only. Steps 4 and 5 need Node 22 and pnpm. Run once: `pnpm install --frozen-lockfile --ignore-scripts`

| # | Time | Do this | Expected result |
|---|---|---|---|
| 1 | 1 min | Open [the one-click sample check](https://qorewitness.fnoufnou.com/verifier.html?sample). It loads a public clip and its receipt and checks them against the live contract in your browser. | A green "Original". |
| 2 | 1 min | Press "Try it: change one byte and check again". The page flips one bit in an in-memory copy and runs the same checks. | The result turns red. |
| 3 | 1 min | Open the [sample anchor transaction](https://explore.qore.network/tx/0xc144eb064bc87a199711ba178493f13bfdee2f48664aa3946404c8ca594fa482). The explorer opens on mainnet, so switch it to Testnet once at the top of the page. | Block 10,653,907, a call to registry v4. The call reverts unless `pqcVerify` accepts the camera signature. |
| 4 | 1 min | Run `pnpm probe:pqc:fuzz` and `pnpm probe:registry`. Both only read the testnet, need no key and send no transaction. About 20 s in total. | Fuzz: 6 positive controls true, 300 mutated inputs, 0 accepted. Registry: 14 of 14 checks as expected, including `BadSignature()` from the live contract. |
| 5 | 1 min to start | Run `pnpm test`. It takes about 35 s. | 365 tests pass (308 node tests and 57 Solidity tests). |

Saved runs of step 4 from 27 Nov 2026: [docs/evidence/2026-11-27-live-pqc-fuzz.md](docs/evidence/2026-11-27-live-pqc-fuzz.md) and [docs/evidence/2026-11-27-live-registry.md](docs/evidence/2026-11-27-live-registry.md). What each probe shows and does not show: [docs/LIVE_PROBES.md](docs/LIVE_PROBES.md).

## Rubric and our evidence

| Criterion (weight) | Evidence | Links |
|---|---|---|
| Works as described (25) | One real home camera has anchored a window every 10 minutes since 9 Nov 2026, on registry v4 since 14 Nov. On 28 Nov 2026 (block 10,876,582) it had more than 1,900 anchors on v4, and v4 held 2,400 anchors from all our devices. The sample in step 1 comes from the test computer, on the same contract. | [camera account](https://explore.qore.network/address/0xD6C6bDfBE567BcE731907789800205Df0B78ca52), [registry v4](https://explore.qore.network/address/0xa1378D6558B32e1f8d37b68cf90e3C93839Da365), [README](README.md) |
| QoreChain tech usage, verified in the repo and on chain (25) | The contract calls `pqcVerify` (`0x...0A01`) and `pqcKeyStatus` (`0x...0A02`). The agent opens an EVM window scoped to the registry with a hybrid ECDSA + ML-DSA-87 transaction. The SDK kits `@qorechain/pqc`, `@qorechain/sdk` and `@qorechain/evm` are used. | [contracts/QorePqc.sol](contracts/QorePqc.sol), [src/agent/evm-window.ts](src/agent/evm-window.ts), [contracts/README.md](contracts/README.md) |
| Post-quantum correctness and security (20) | Every state change needs a fresh ML-DSA-87 signature over a domain-separated message. 45 fuzz tests and 6 invariants. 12 hand-made mutants, all caught. Live probes on 27 Nov 2026. Four QCAI audit rounds with every finding mapped. | [docs/TESTING.md](docs/TESTING.md), [docs/AUDIT.md](docs/AUDIT.md), [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md), [docs/LIVE_PROBES.md](docs/LIVE_PROBES.md) |
| Originality (15) | C2PA and Truepic sign at capture but need a camera or app built for it. OpenTimestamps proves that one file existed. QoreWitness works with cameras people already own, chains every clip to the one before it, and the chain checks the camera's post-quantum signature. | [README: why not C2PA](README.md#why-not-c2pa-truepic-or-opentimestamps), [docs/SPEC.md](docs/SPEC.md) |
| Clarity, UX and documentation (15) | One install line, then four short screens in the browser. A spec, a threat model, an audit map, a testing report and an AI usage log. | [docs/INSTALL.md](docs/INSTALL.md), [docs/SPEC.md](docs/SPEC.md), [AI_USAGE.md](AI_USAGE.md) |

## Category requirements: Post-Quantum dApp

| Requirement | Where in the code | How it is tested | On chain |
|---|---|---|---|
| Scoped EVM window | `ensureScopedWindow` in [src/agent/evm-window.ts](src/agent/evm-window.ts#L46) builds `MsgOpenEVMWindow` with `allowedTargets: [registry]` ([line 57](src/agent/evm-window.ts#L57)). The agent calls it in [src/agent/run.ts](src/agent/run.ts#L138). The helper [scripts/window.ts](scripts/window.ts#L142) reads `QORE_ALLOWED_TARGETS`. | No automated test, because the simulated chain has no EVM windows. The Q-Day Drill dry run of 9 Nov 2026 shows the scope on the live chain ([docs/TESTNET_FINDINGS.md](docs/TESTNET_FINDINGS.md#q-day-drill-dry-run-9-nov-2026-2345-utc)). | The `MsgOpenEVMWindow` transactions are on the [camera account](https://explore.qore.network/address/0xD6C6bDfBE567BcE731907789800205Df0B78ca52). |
| Hybrid ECDSA + ML-DSA-87 transactions | `EthNativeSigner` with `signMode: "hybrid"` in [src/agent/evm-window.ts](src/agent/evm-window.ts#L59) and in `hybridBankSend` in [src/agent/bank.ts](src/agent/bank.ts#L65). | Live only. The chain refused the ECDSA-only and derived-key transfers of the dry run (attacks A1 to A3). | The official drill transaction, a hybrid self-send: [9C52C39C...7AD16](https://explore.qore.network/tx/9C52C39CDA1BEE42AD4EA5000620C82D2B496BD0D767BB9DFEBACC965837AD16), block 10,301,720. |
| `pqcVerify` | `QorePqc.verify` in [contracts/QorePqc.sol](contracts/QorePqc.sol#L21). Called by `anchor` ([line 131](contracts/AnchorRegistry.sol#L131)), `registerDevice` ([line 110](contracts/DeviceRegistry.sol#L110)), `revokeDevice` ([line 128](contracts/DeviceRegistry.sol#L128)) and `rotateDeviceKey` ([line 153](contracts/DeviceRegistry.sol#L153)). | Signature fuzz tests in [test/solidity/Signatures.t.sol](test/solidity/Signatures.t.sol), with a precompile mock. Real signatures: the two live probes. | Every anchor on [registry v4](https://explore.qore.network/address/0xa1378D6558B32e1f8d37b68cf90e3C93839Da365). |
| `pqcKeyStatus` | `QorePqc.keyStatus` ([line 40](contracts/QorePqc.sol#L40)), used by `_ownerKey` ([line 186](contracts/DeviceRegistry.sol#L186)). | [test/solidity/QorePqcFailClosed.t.sol](test/solidity/QorePqcFailClosed.t.sol) and the tests listed in the audit map. | Register and revoke calls on registry v4. |
| Two-stage QCAI audit | Four rounds from 12 to 17 Nov 2026, scores 82, 72, 78 and 85. These are automated reviews, and no accredited firm audited the project. | Findings are mapped to a fix, a test or a reason in [docs/AUDIT.md](docs/AUDIT.md). Map of every precompile call: [docs/AUDIT.md](docs/AUDIT.md#where-qorewitness-calls-the-pqc-precompiles). | Audited code is deployed at registry v4. Reports: [docs/audit/](docs/audit/). |
| Foundry or Hardhat tests | 57 Solidity tests in [test/solidity/](test/solidity/) and contract tests in [test/AnchorRegistry.test.ts](test/AnchorRegistry.test.ts). Hardhat 3 runs both. | `pnpm test` (365 in total), `pnpm test:fuzz` (4,096 runs per fuzz test, invariants 256 runs x depth 100), `pnpm test:coverage` (100% of lines and statements in the four contracts, Hardhat 3 reports no branch coverage). | Not applicable. |
| Sensitive actions get post-quantum protection | Anchor, register, revoke and rotate each need ML-DSA-87 signatures that the contract checks. | The mutation check and 6 invariants in [docs/TESTING.md](docs/TESTING.md). | Reverted attacks of the dry run, and `BadSignature()` in step 4. |

## Declared and Verified on the project page

The two Solidity PQC items show as Declared for every team, because the checker cannot see precompile calls inside a contract. Check them by hand in `QorePqc.verify` and `QorePqc.keyStatus`, then in the `pqcVerify` calls listed above, then on chain with any anchor transaction. The item `create-qorechain-dapp` can never turn Verified on its own, so the credit for it is the README line below.

TODO (builder to confirm): the README credits say the project started from the `create-qorechain-dapp` Hardhat template, version 0.12.0 ([README: Credits](README.md#credits)). The first commit is not a pristine scaffold, so the repo has no commit that shows the template output. The template parts we name are the Hardhat setup and `scripts/window.ts`.

## What is real and what is mocked

- **Real.** The contract on the testnet. The `pqcVerify` and `pqcKeyStatus` precompiles it calls. The ML-DSA-87 signatures of the live camera. The hybrid transactions.
- **Mocked.** The contract tests run on the Hardhat simulated chain, which has no QoreChain precompiles. They use [contracts/test/PqcMocks.sol](contracts/test/PqcMocks.sol). The mock accepts a keyed hash and not a real signature. So the 365 tests check our logic and the exact signed bytes, and the live probes cover ML-DSA-87.
- **Where real ML-DSA-87 is checked.** The two live probes in step 4 and every live anchor. A flaw that only shows with real signatures could not show in the contract tests ([docs/TESTING.md](docs/TESTING.md#limits)).
- **Gap in the probes.** The valid-signature path of the live camera key cannot be simulated without the key. The real anchors show it.

## Known limits

- Testnet only. The test network can be reset, so the beta is a demonstration and not evidence yet ([docs/THREAT_MODEL.md](docs/THREAT_MODEL.md#two-scopes-the-beta-now-the-product-later)).
- The owner keys sit on the recorder today. An offline owner key with an anchor-only agent key is designed and a spike passed, but relayed calls emit no EVM logs, so it is not used ([docs/AGENT_KEY.md](docs/AGENT_KEY.md)).
- An attacker with only the ECDSA key can still send calls to the scoped target. They revert but use window slots and fees. They cannot take value or change state ([docs/TESTNET_FINDINGS.md](docs/TESTNET_FINDINGS.md#q-day-drill-dry-run-9-nov-2026-2345-utc)).
- The installer is tested end to end on Linux only. Docker Compose on a NAS, Windows and macOS is documented and still has to be tested there.
- A seal proves that a file has not changed since it was sealed. It does not prove that the scene was real.
- Custody drill: 10 attacks on the footage. All 5 attacks after anchoring were rejected. 4 of 5 swaps before hashing were flagged and 1 was missed, a swap with footage from the same camera settings ([docs/CUSTODY_DRILL.md](docs/CUSTODY_DRILL.md)).
- Q-Day Drill. Official, 18 Nov 2026, run by the organisers: our proof transaction was accepted, and the official attack log is not published yet. Our own dry run, 9 Nov 2026: 13 attacks with only the ECDSA key, 0 succeeded. These are two separate results.
- The two live probes are samples. They are not a proof of ML-DSA conformance and not an audit of the chain.

## Built during the fest

- First commit: 9 Nov 2026 (`feat: AnchorRegistry with on-chain ML-DSA-87 verification, Merkle core, tests`). Check with `git log --reverse --format='%ad %s' --date=short | head -3`. [AI_USAGE.md](AI_USAGE.md) says the history was rebuilt under the alias.
- Licence: Apache-2.0 ([LICENSE](LICENSE)).
- Credits and third-party software: [README: Credits](README.md#credits).
- AI use, who did what: [AI_USAGE.md](AI_USAGE.md). Changes: [CHANGELOG.md](CHANGELOG.md). Security reports: [SECURITY.md](SECURITY.md).
