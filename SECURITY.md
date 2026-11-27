# Security policy

QoreWitness runs on the QoreChain test network (qorechain-diana, EVM chain ID 9800) only. It uses test tokens without value. Nothing runs on the QoreChain main network.

## Report a vulnerability

- Use GitHub private vulnerability reporting: the Security tab of this repository, then "Report a vulnerability".
- Or send a direct message to [@fnoufnou on X](https://x.com/fnoufnou).
- Please do not open a public issue for a vulnerability.
- Please do not attack the live camera, the fee sponsor or other people's accounts. Use your own test account and your own copy of the code.

We aim to answer within a few days. We fix confirmed issues in the next release. If you want, we credit you in the CHANGELOG.

## Scope

| In scope | Path |
|---|---|
| Contracts (AnchorRegistry, DeviceRegistry, MerkleSha256, QorePqc) | [contracts/](contracts/) |
| Agent, recorder, setup, dashboard and shared verify code | [src/](src/), [scripts/record.sh](scripts/record.sh), [deploy/](deploy/) |
| Free beta fee sponsor | [services/sponsor/](services/sponsor/) |
| Installer | [install.sh](install.sh) |
| Verifiers (QoreWitness Verify, CLI, Python tool) | [web/verifier/](web/verifier/), [scripts/verify-receipt.ts](scripts/verify-receipt.ts), [tools/verify_receipt.py](tools/verify_receipt.py) |

Out of scope:

- The QoreChain network, its precompiles, SDK and explorer. Report those to the QoreChain team.
- Attacks that need control of the recorder itself, for example its files or the owner's recovery phrase on it. The threat model lists this as a known limit (A4).
- Denial of service against the test network.

## What we already know

- Threat model, attackers, controls and residual risks: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
- QCAI audit rounds, each finding with its fix, test or reason: [docs/AUDIT.md](docs/AUDIT.md).
- Drills on chain: [docs/TESTNET_FINDINGS.md](docs/TESTNET_FINDINGS.md) and [docs/CUSTODY_DRILL.md](docs/CUSTODY_DRILL.md).
