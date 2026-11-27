# Live AnchorRegistry negative simulations (eth_call)

- Run (UTC): 2026-11-27 22:07:18 UTC
- Chain: qorechain-diana, EVM chain id 9800
- Block height at the run: 10873377 (block time 2026-11-27 22:07:15 UTC)
- RPC: https://evm-testnet.qore.host
- Git commit of the code: 278c852e2ff7b0471e075d7d8315ffc609d9011e
- Command: `pnpm probe:registry --report docs/evidence/2026-11-27-live-registry.md`
- Registry: 0xa1378D6558B32e1f8d37b68cf90e3C93839Da365 (v4)
- Owner address used as `from`: 0xD6C6bDfBE567BcE731907789800205Df0B78ca52
- Device id: 0x76616b5f3685aa868ba2cedc576e97e4c3edfb92a921082b4f4e2b9c4424bf0d
- Registered device key hash: 0x2dcf03a3a426a6eab2036db1de43eee2c37c63f1a2fa8ef8ee8465187835c796
- Chain head (root of the newest window): 0xab1c74b6440f239ad8050bc978cd93a116085851b606cef09002135bc6354bf7
- nextWindowStart: 1795816800
- Claim used: windowStart 1795816800, windowSeconds 437, refBlock 10873377
- Replayed signature copied from block 10869720, transaction 0xfab6c733bed184fbffe37591645b42fd79e578a91aef57ef98eeb10df420ad84
- Sample receipt: https://qorewitness.fnoufnou.com/sample-receipt.json

## Result

**PASSED.** 14 of 14 checks gave the expected answer.

Nothing was sent. Every call is an `eth_call`. The owner address is only the `from` field, no owner key or signature was used.

### Live state read

| Check | Expected | Got | Verdict |
| --- | --- | --- | --- |
| device is active and its key (from a recent anchor transaction) is the registered key | status Active, keccak256(key) = registered key hash | status 1, key hash matches | pass |

### Message sanity (what we sign is what the contract hashes)

| Check | Expected | Got | Verdict |
| --- | --- | --- | --- |
| signing message built here equals signingMessage() of the live contract (256 bytes) | equal | equal | pass |
| revoke message built here equals revokeMessage() of the live contract | equal | equal | pass |

### anchor(): forged and replayed signatures, broken chain

| Check | Expected | Got | Verdict |
| --- | --- | --- | --- |
| anchor: random 4,627-byte signature | BadSignature | BadSignature() | pass |
| anchor: real old signature of this device, replayed on a new window | BadSignature | BadSignature() | pass |
| anchor: valid ML-DSA-87 signature of a fresh attacker key over the exact signing message, device key as registered | BadSignature | BadSignature() | pass |
| anchor: same attacker signature with the attacker's own public key | DeviceKeyMismatch | DeviceKeyMismatch(0x76616b5f3685aa868ba2cedc576e97e4c3edfb92a921082b4f4e2b9c4424bf0d) | pass |
| anchor: correct device key, wrong prevRoot | BrokenChain | BrokenChain(0xab1c74b6440f239ad8050bc978cd93a116085851b606cef09002135bc6354bf7, 0xcaaf296efadbcf71af0fe26a01f5058846b39f997db56604b819a59935c7201a) | pass |

- All earlier checks passed (window, chain head, reference block, active device, key hash). pqcVerify then refused the signature.
- The key hash check stops it before the signature check.
- The chain head check stops it before the signature check.

### Owner actions with forged owner signatures

| Check | Expected | Got | Verdict |
| --- | --- | --- | --- |
| revokeDevice from the owner address, random signature | BadOwnerSignature | BadOwnerSignature() | pass |
| revokeDevice from the owner address, valid signature of a fresh attacker key over the exact revoke message | BadOwnerSignature | BadOwnerSignature() | pass |
| registerDevice from the owner address, random owner signature | BadOwnerSignature | BadOwnerSignature() | pass |
| registerDevice from the owner address, valid attacker signature as owner signature | BadOwnerSignature | BadOwnerSignature() | pass |

- The owner's chain key was found (registered, ML-DSA-87, size ok) and pqcVerify refused the forged signature.

### Positive control with the public sample receipt (no private key needed)

| Check | Expected | Got | Verdict |
| --- | --- | --- | --- |
| verifyAnchor of the public sample receipt: segment is found and included | found=true, included=true | found=true, included=true | pass |
| verifyAnchor with one flipped bit in the segment link: not included | found=true, included=false | found=true, included=false | pass |

- Control for the tamper check below: the same call with the real link is accepted.

## Observations

- pqcVerify of a valid signature: plain eth_call returns true, eth_call with an empty state override object returns "0x". So the node does not run the PQC precompile when a state override is present, and a simulation with overrides cannot be used as a positive control. These probes never use overrides.

## What this shows

The deployed contract, running with the real pqcVerify and pqcKeyStatus precompiles, refuses forged, replayed and attacker-made signatures with the expected custom errors. BadSignature() after the window, chain, block and key checks means the precompile refused the signature inside the real contract. The contract treats a precompile that returns false and one that fails the same way, but it reports an inactive precompile as a different error.

What it does not show: a simulation is not a transaction, so it says nothing about what a node would include in a block. A valid signature by the real device key was not tested here because that key is not available to this script. That path is shown by the real anchor transactions of the live camera.
