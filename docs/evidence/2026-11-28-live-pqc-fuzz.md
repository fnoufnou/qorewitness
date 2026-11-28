# Live pqcVerify mutation fuzz

- Run (UTC): 2026-11-28 00:54:51 UTC
- Chain: qorechain-diana, EVM chain id 9800
- Block height at the run: 10880419
- RPC: https://evm-testnet.qore.host
- Git commit of the code: bbfa59d7773ee8221ffeb24df3768dbc09d10ec8
- Command: `pnpm probe:pqc:fuzz --seed 20261128 --cases 300 --report docs/evidence/2026-11-28-live-pqc-fuzz.md`
- Seed: 20261128 (rerun with `--seed 20261128 --cases 300`)
- Duration: 14.7 s

## Result

**PASSED.** 300 of 300 negative cases were rejected (300 returned false, 0 reverted), none was accepted, 0 could not run.

### Positive controls (must return true)

| Control | Observed | Verdict |
| --- | --- | --- |
| key 1, deterministic signature | true | pass |
| key 1, hedged signature | true | pass |
| key 2, deterministic signature | true | pass |
| key 2, hedged signature | true | pass |
| key 3, deterministic signature | true | pass |
| key 3, hedged signature | true | pass |

### Negative cases per class (must return false or revert, never true)

| Class | Cases | false | revert | accepted (true) | not run |
| --- | ---: | ---: | ---: | ---: | ---: |
| sig-bitflip | 130 | 130 | 0 | 0 | 0 |
| pk-bitflip | 65 | 65 | 0 | 0 | 0 |
| msg-bitflip | 65 | 65 | 0 | 0 | 0 |
| sig-other-key | 1 | 1 | 0 | 0 | 0 |
| sig-other-message | 1 | 1 | 0 | 0 | 0 |
| sig-truncated | 7 | 7 | 0 | 0 | 0 |
| sig-extended | 4 | 4 | 0 | 0 | 0 |
| pk-truncated | 3 | 3 | 0 | 0 | 0 |
| pk-extended | 2 | 2 | 0 | 0 | 0 |
| sig-all-zero | 1 | 1 | 0 | 0 | 0 |
| sig-all-ff | 1 | 1 | 0 | 0 | 0 |
| swapped-args | 5 | 5 | 0 | 0 | 0 |
| wrong-length | 10 | 10 | 0 | 0 | 0 |
| empty-input | 5 | 5 | 0 | 0 | 0 |
| **all** | **300** | **300** | **0** | **0** | **0** |

### Signature bit flips per region

Layout of an ML-DSA-87 signature (4,627 bytes): c-tilde bytes 0 to 63, z bytes 64 to 4543, hint positions bytes 4544 to 4618, hint counts bytes 4619 to 4626.

| Region | Cases | false | revert | accepted (true) | not run |
| --- | ---: | ---: | ---: | ---: | ---: |
| ctilde | 26 | 26 | 0 | 0 | 0 |
| z | 52 | 52 | 0 | 0 | 0 |
| hintPositions | 26 | 26 | 0 | 0 | 0 |
| hintCounts | 26 | 26 | 0 | 0 | 0 |

## What this shows

The live pqcVerify precompile returned true for fresh valid signatures and did not return true for any of the mutated inputs above. It is a black-box sample. It is no proof of ML-DSA conformance and no audit. An RPC error counts as "not run".
