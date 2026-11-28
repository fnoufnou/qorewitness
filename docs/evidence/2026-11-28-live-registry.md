# Live AnchorRegistry negative simulations (eth_call)

- Run (UTC): 2026-11-28 00:55:06 UTC
- Chain: qorechain-diana, EVM chain id 9800
- Block height at the run: 10880428 (block time 2026-11-28 00:55:01 UTC)
- RPC: https://evm-testnet.qore.host
- Git commit of the code: bbfa59d7773ee8221ffeb24df3768dbc09d10ec8
- Command: `pnpm probe:registry --report docs/evidence/2026-11-28-live-registry.md`
- Every call and state read used block 10880428 (head at the start 10880430, pinned 2 blocks below it)
- Registry: 0xa1378D6558B32e1f8d37b68cf90e3C93839Da365 (v4)
- Owner address used as `from`: 0xD6C6bDfBE567BcE731907789800205Df0B78ca52
- Device id: 0x76616b5f3685aa868ba2cedc576e97e4c3edfb92a921082b4f4e2b9c4424bf0d
- Registered device key hash: 0x2dcf03a3a426a6eab2036db1de43eee2c37c63f1a2fa8ef8ee8465187835c796
- Newest real anchor (used by the controls): block 10880222, transaction 0xa3c8e7d922ed13dc1a2b43c7f39490a5f0beb67a547103a63492b988079f5cf2, anchor id 0x1fd5c604516c8f69868b68283afd48c689e15858afa44226a5f1e156d8b24988, windowStart 1795826400
- Chain head (root of the newest window): 0x98f58f5d5863e60bbd2be5b142db915e3cba50b2421939d0911b7bbdc3b3df5a
- nextWindowStart: 1795827000
- Claim used: windowStart 1795827000, windowSeconds 301, refBlock 10880427
- Replayed signature copied from block 10876440, transaction 0xcd8ca16615c73d1d4c1706d3eddc8ed529a1a751431f6f4c7f828babab481327
- Sample receipt: https://qorewitness.fnoufnou.com/sample-receipt.json
- Exit code: 0

## Result

**PASSED.** 21 of 21 checks gave the expected answer.

Nothing was sent. Every call is an `eth_call`. The owner address is only the `from` field. No owner or device private key was used.

### Live state read

| Check | Expected | Got | Verdict |
| --- | --- | --- | --- |
| device is active and its key (from the newest anchor transaction) is the registered key | status Active, keccak256(key) = registered key hash | status 1, key hash matches | pass |

### Gating positive controls (run first, the run stops if one does not hold)

| Check | Expected | Got | Verdict |
| --- | --- | --- | --- |
| pqcVerify called directly: fresh ML-DSA-87 key, valid signature | true | true | pass |
| newest real anchor: signingMessage(owner, claim) of the live contract equals the message built here | equal | equal (256 bytes) | pass |
| newest real anchor: pqcVerify(device key, its signature, message from the live contract) | true | true | pass |
| newest real anchor: the same call with one flipped bit in the signature | false | false | pass |
| newest real anchor: the same call with one flipped bit in the message | false | false | pass |
| newest real anchor: keccak256(signature) equals sigHash in the Anchored event and in getAnchor(anchorId) | all equal | event equal, getAnchor equal | pass |
| newest real anchor: keccak256(device key) equals the stored deviceKeyHash of the anchor | equal | equal | pass |

- Replay with eth_call of a verification the chain already did when it included the newest anchor transaction. No owner or device private key is used.

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
| anchor: correct device key, wrong prevRoot | BrokenChain | BrokenChain(0x98f58f5d5863e60bbd2be5b142db915e3cba50b2421939d0911b7bbdc3b3df5a, 0xcaaf296efadbcf71af0fe26a01f5058846b39f997db56604b819a59935c7201a) | pass |

- All earlier checks passed (window, chain head, reference block, active device, key hash). The precompile then did not accept the signature: it returned false or the call failed. The gating controls above show that the same precompile accepts the real camera signature in this run.
- The key hash check stops it before the signature check.
- The chain head check stops it before the signature check.

### Owner actions with forged owner signatures

| Check | Expected | Got | Verdict |
| --- | --- | --- | --- |
| revokeDevice from the owner address, random signature | BadOwnerSignature | BadOwnerSignature() | pass |
| revokeDevice from the owner address, valid signature of a fresh attacker key over the exact revoke message | BadOwnerSignature | BadOwnerSignature() | pass |
| registerDevice from the owner address, random owner signature | BadOwnerSignature | BadOwnerSignature() | pass |
| registerDevice from the owner address, valid attacker signature as owner signature | BadOwnerSignature | BadOwnerSignature() | pass |

- The owner's chain key was found (registered, ML-DSA-87, size ok, possession proven) and the precompile did not accept the forged signature (it returned false or the call failed).

### Public sample receipt with verifyAnchor (no private key needed)

| Check | Expected | Got | Verdict |
| --- | --- | --- | --- |
| verifyAnchor of the public sample receipt: segment is found and included | found=true, included=true | found=true, included=true | pass |
| verifyAnchor with one flipped bit in the segment link: not included | found=true, included=false | found=true, included=false | pass |

- Control for the tamper check below: the same call with the real link is accepted.

## Observations

- The probe makes exactly one call with an empty state override, on purpose, to record how the node behaves. It called pqcVerify with a fresh valid signature and an empty override object, and it returned empty data: with a state override the node answered without the PQC precompile. This observation does not change the exit code. Every other call of the run has no override.

## What this shows

The gating controls show that the live pqcVerify precompile accepts a fresh valid signature and the real signature of the camera over the exact bytes that the live contract builds. It returns false when one bit of that signature or of that message is flipped. The real-signature control is a replay with eth_call of a verification the chain already did when it included the newest anchor. No owner or device private key was used.

The deployed contract, running with the same precompiles, refuses forged, replayed and attacker-made signatures with the expected custom errors. BadSignature() means that the precompile did not accept the signature: it returned false or the call failed. Together with the gating controls in the same run, a dead precompile cannot produce a passing run.

Limits: a simulation is not a transaction, so it says nothing about what a node would include in a block. The real device key signs only on the camera, so this script cannot make a new valid camera signature. The real anchor transactions of the live camera show that path.
