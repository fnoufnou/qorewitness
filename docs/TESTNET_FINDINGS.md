# Testnet findings

Live checks against `qorechain-diana` (EVM chain ID 9800, `https://evm-testnet.qore.host`) from 9 to 21 Nov 2026.

## pqcVerify precompile (`0x...0A01`)

Script: `scripts/probe-pqc.ts` (eth_call, no account needed).

| Input | Result | Gas estimate (whole call) |
|---|---|---|
| Deterministic ML-DSA-87 signature, empty context | true | 313,150 |
| Hedged signature | true | 312,910 |
| One bit changed in the signature | false | 313,150 |
| Signature over a different message | false | 311,720 |
| Short signature (100 bytes) | false | 132,940 |
| Valid signature over an empty message | false on 9 Nov 2026, true since at least 27 Nov 2026 (see the note below) | 310,740 |

Conclusions:

- `@qorechain/pqc` `mldsa.sign(secretKey, message)` output verifies on chain as is.
- Bad input returns false. It does not revert.
- Empty messages: on 9 Nov 2026 the precompile returned false for a valid signature over an empty message. On 27 Nov 2026 it returns true, which is the correct answer for a valid signature. QoreWitness never signs an empty message: the window message is always 256 bytes (`signingMessage` in `contracts/AnchorRegistry.sol`), and the owner messages are fixed-length too.
- Since 27 Nov 2026 the wider live checks are `pnpm probe:pqc:fuzz` and `pnpm probe:registry` (`docs/LIVE_PROBES.md`).
- The address must be written lower case in viem and Solidity (checksum rules).

## pqcKeyStatus precompile (`0x...0A02`)

Script: `scripts/probe-keystatus.ts`.

- Returns the 4-value form `(bool registered, uint8 algorithmId, bytes pubkey, bool possessionProven)`.
- A validator account showed `registered = true`, `algorithmId = 1`, a 2,592-byte key and `possessionProven = false`. Older keys likely lack the proof of possession.
- `QorePqc.keyStatus` reads both the 3-value and the 4-value form.

## Cost estimate per anchor

- About 313,000 gas for the verification call alone (calldata of about 7.4 KB plus the precompile).
- Measured on the first anchor: 340,949 gas in total (3 files).
- Early estimate (9 Nov): at the 0.1 uqor per gas minimum this is about 0.04 QOR per anchor. The faucet gives 100 QOR per 24 h.
- Measured since: about 0.0457 test QOR per anchor, with one anchor per 10-minute window (the default). See the next section.

### Measured cost on registry v4 (20 to 21 Nov 2026)

Live agent account, 195 anchors from 20 Nov 08:30 to 21 Nov 16:50 UTC, no window missed.

- Gas used per anchor: 406,132 on average (405,845 to 406,337).
- Gas price charged: 0.1125 uqor per gas (base fee 0.1 + tip 0.0125).
- Fee per anchor: about **0.0457 test QOR** (45,700 uqor). Measured as the balance change across one anchor block.
- EVM window open: 0.1 test QOR each (fixed fee 100,000 uqor for 800,000 gas). One opens about every 6 h 50 min, so about 3.5 per day per owner account.
- One camera with 10-minute windows: 144 anchors + 3.5 window opens = about 6.9 test QOR per day, about 208 per month.
- Explorers show about 0.104 QOR per anchor. That is the Cosmos `fee` field (gas limit x max fee per gas, 255 gwei). The chain charges gas used x effective gas price, so the account loses about 0.0457 QOR. Earlier notes that said "about 0.1 QOR per anchor" used the explorer number.

## First deployment and anchor (9 Nov 2026)

- `AnchorRegistry`: `0xA73d4347b50C2A373533915d698Bf03a01c65aAF`, `requirePossessionProof = true`.
- Agent account: `0xD6C6bDfBE567BcE731907789800205Df0B78ca52`. Key registered with `register-key-v2` (proof of possession).
- Deploy: unscoped EVM window (600 blocks, 3 txs). Anchoring: window scoped to the registry (`allowed_targets`), 2,000 blocks, 10 txs.
- First anchor: 3 files, tx `0x0048aee4ca79a9a499d50a855415fdb50b7594efcc33a423e830db5e47157d40`, block 9790419, **340,949 gas** (about 0.034 QOR at 0.1 uqor per gas).
- `scripts/verify-receipt.ts`: all 8 checks pass for the original file. A file with one extra byte fails the first check.

## Registry v3 with audit fixes (12 Nov 2026)

v3 adds two limits from the QCAI audit (`docs/AUDIT.md`): a window is at most 1 day long, and a Merkle proof has at most 32 hashes. The rest is the same as v2.

- `AnchorRegistry` v3: `0x238A1D989c1f0561d4DD51d4B322C491A5cb1CD2`, `requirePossessionProof = true`. Deploy tx `0x7912aedff98616e783b4a7894930a55f358433c60063825c415b2266fd2c091c`, block 9938126, 2,201,200 gas.
- Deploy: unscoped EVM window (600 blocks, 5 txs). The agent then opened its own window scoped to v3.

| Action | Signatures checked on chain | Gas | Tx |
|---|---|---|---|
| `registerDevice` (lsc-indoor) | owner key + device key | 479,954 | `0x8cf6ad5b90b148e4d3b36c7dcd4ba25183b0348fc79ef2573fb044319e57251c` |
| `registerDevice` (demo-testpattern) | owner key + device key | 463,034 | `0x919dfcb9fcbbd12f7911432211e4043f8a4fdbcbd4378f8e021f305e8cfb8bca` |
| `anchor`, demo clip, first anchor of the device | device key | 404,549 | `0x18dbc7a0f0be01700120ea829616a43e2a16b7cb74dc1898ae509df36eb7cd2b` |
| `anchor`, 10 segments, first agent window on v3 | device key | 404,669 | `0x3a74939ce64ca3a6d5420f4f2150ad51d5cc0f546163c138515690c4deccdb5c` |

The first anchor of a device costs about 35,000 gas more, because it writes new storage slots.

## Registry v2 with DeviceRegistry (9 Nov 2026, evening)

Contract `AnchorRegistry` v2 inherits `DeviceRegistry`. Each camera has its own ML-DSA-87 key. All checks below ran on chain with the real `pqcVerify` precompile.

- `AnchorRegistry` v2: `0x1854EeE2A659F4f39A05d5832cceC405E8045336`, `requirePossessionProof = true`. Deploy tx `0xbb3dbe48521e96393f7152d6ed1c9183069ceae8a7a3db1085c853c22f082578`, block 9795790, 2,176,542 gas.
- Deploy: unscoped EVM window (300 blocks, 3 txs). All later calls: window scoped to the v2 registry only (`allowed_targets`).
- v1 (`0xA73d...5aAF`) stays as it is. It holds the anchors of 9 Nov.

| Action | Signatures checked on chain | Gas | Tx |
|---|---|---|---|
| `registerDevice` (demo-files) | owner key + device key | 478,354 | `0x86334e5e0b78504e4d27cf6f8cf6b814bf3f7cbb7ab3e8a40518319688f74f73` |
| `anchor`, 3 files, key v1 | device key | 403,630 | `0x6ae398aa13f44b7b13426cc3399c87fea6b6f1de3da483a956f4f75d1a19bfb4` |
| `rotateDeviceKey` | old key + new key | 463,642 | `0xf83db7aa4d874b35c4719cf0de7ccc5f2aee205eb7e043556d0f4ede22dd5aae` |
| `anchor`, 1 file, key v2 | device key | 369,334 | `0x843572f7aac934bfd3b197a1ef26d20600c08762545d8ec44a0ef00b96e7233d` |
| `registerDevice` (revoke-test) | owner key + device key | 461,074 | `0xfc657a4f6d4589a9d9f997f2934cd5338009bfd8415a3e0639394cae4b8d9de4` |
| `revokeDevice` (revoke-test) | owner key | 211,351 | `0x7cc1390d86696edf11bf55fd15712f626e76d2f5665b98a28c713bcb3e070b71` |
| `registerDevice` (lsc-indoor) | owner key + device key | 461,098 | `0x0872f7d2d4d2e9a528b2f46d198bda208590bb8604bc2d39a2f786e6f314fa24` |
| `anchor`, live camera, 4 segments | device key | 403,522 | `0xa40dff077ccfab2001ff468d8de67b883e107f73c3899cab46d3bc295fc3ad92` |

Failure paths on testnet (simulated, so no gas was spent):

- Anchor with the old key after rotation: revert `DeviceKeyMismatch` (`0x51b24072`).
- Anchor from the revoked device: revert `DeviceNotActive` (`0x2b38e2ea`).
- `verify-receipt.ts`: 7 of 7 checks pass for the original file and for the file signed with key version 2. A copy with one changed byte fails at the first check.

Conclusions:

- One on-chain ML-DSA-87 check costs less than we estimated. Register (two checks, about 12 KB calldata) costs about 470,000 gas.
- An anchor costs about 60,000 gas more than in v1, because the 2,592-byte device key is in the calldata. Estimate: about 0.04 QOR per anchor at 0.1 uqor per gas. Measured on v4: about 0.0457 test QOR (see above).
- The contract stores only `keccak256` of the device key. Storage for the full key would cost about 1.7 million gas per device.

## Finding: ML-DSA key derived from the ECDSA key (Q-Day Drill risk)

- `@qorechain/sdk` 0.12.0 `unifiedAccountFromSeed(privateKey)` derives the ML-DSA-87 seed as `SHAKE-256("qorechain:pqc:v1|" + qor1-address + "|seed:" + hex(privateKey))`.
- So for an account made from a raw private key (the `PRIVATE_KEY` path of the template helper `pnpm window`), the ECDSA key is enough to rebuild the ML-DSA key. The post-quantum protection is then likely void for that account.
- `deriveUnifiedAccount(mnemonic)` uses the mnemonic as the secret. The ECDSA key alone does not give the ML-DSA key, because the BIP-32 path is one-way.
- Rule for the Q-Day Drill: create the drill account from a fresh mnemonic. Hand over only its ECDSA private key.
- Fixed upstream in `@qorechain/sdk` 0.13.0 (10 Nov 2026), confirmed by the QoreChain team on 15 Nov. Check of 16 Nov: with 0.14.0, our three accounts (all from mnemonics) derive the same addresses and ML-DSA-87 keys as with 0.12.0. The update follows after the drill (`CHANGELOG.md`).

## Q-Day Drill dry run (9 Nov 2026, 23:45 UTC)

Throwaway drill account `0x06af2d43F5048AdF71b3957d2e6b0C4027F8dc06` from a fresh mnemonic. ML-DSA-87 key registered with proof of possession. Device `drill-cam` registered and one anchor made. Open EVM window scoped to the v2 registry (12 txs, 3.77 QOR left). Then `scripts/qday-drill.ts dryrun` with `DRILL_SEND=1` used only the ECDSA key.

| Attack | Result |
|---|---|
| A0 rebuild the ML-DSA key from the ECDSA key | Refused: the derived key is not the registered key |
| A1 native transfer, ECDSA only | Refused at broadcast: `pqc` code 20 (registered key, PQC signature required) |
| A2 native transfer, hybrid with the derived key | Refused: `pqc` code 21 (`hybrid_verify_failed`) |
| A3 open an EVM window, ECDSA only / derived key | Refused: code 20 / code 21 |
| A4 EVM transfer of 1 QOR | Not admitted. The RPC answered "Missing or invalid parameters". Likely the window scope check. |
| A5 token approval, target outside the scope | Not admitted, same answer |
| A6 send QOR to the registry | Mined, reverted (no receive function) |
| A7 revoke with a forged owner signature | Mined, reverted |
| A8 register an attacker device | Mined, reverted |
| A9 rotate to an attacker key | Mined, reverted |
| A10 forged anchor with the real device key | Mined, reverted |
| A11 replay of the real anchor | Mined, reverted (window overlap) |

13 attacks, 0 succeeded. Cost to the victim: 303,750 uqor (0.30 QOR) in fees and 6 window slots.

Conclusions:

- Calls to an in-scope target are admitted, then revert. Each one used a window slot and charged 450,000 gas, which is half of the 900,000 gas limit. So an attacker with the ECDSA key can burn the open window: slots and fees, up to its `maxValue`. The attacker cannot take value or change state.
- Mitigation for the drill: keep no EVM window open on 18 Nov, or a very small one. Make the "normal tx" a hybrid native-lane tx, which needs no window.
- The RPC error text for A4 and A5 does not name the window. Still to confirm that it is the scope rule and not a malformed request.

## Registry v4: chain of custody (14 Nov 2026)

After feedback from the QoreChain team on chain of custody and time bounds. Rules: `docs/SPEC.md` (qorewitness-spec/2).

- `AnchorRegistry` v4: `0xa1378D6558B32e1f8d37b68cf90e3C93839Da365`, `requirePossessionProof = true`.
- `registerDevice` (lsc-indoor): 480,117 gas, tx `0x4d58338623ad2e87ae87eb66dfde59eb472fee008e71f70b0804e0f42e6e55b6`.
- First chained anchor, 10 segments: block 10,078,095, **437,049 gas**, tx `0x9c7f9680053819a4f61722ebd20c4c911ebccf5c2db4619728088507493a8c15`. About 67,000 gas more than v3, for the chain head, the reference block and the gap field.
- Signed after block 10,078,092 (14:23:40 UTC), anchored in block 10,078,095 (14:23:44 UTC): a time window of 4 seconds for the signature.
- `verify-receipt.ts` and `tools/verify_receipt.py` pass every check on a live v3 receipt.

### Finding: BLOCKHASH returns 0 on qorechain-diana

- An `eth_call` with a state override that runs `BLOCKHASH(NUMBER - 1)` and `BLOCKHASH(NUMBER - 10)` returns 0.
- The first v4 deploy (`0x95BA116CC13cDd058E0622E7eCfE001f7b85c102`) required `blockhash(refBlock) != 0` and refused every anchor. It is not used.
- Fix: the device signs the block hash it read from the RPC. The contract checks that the block is one of the last 256, and compares the hash only where the EVM knows it. Verifiers compare the signed hash with the chain's block. The lower time bound holds, because nobody knows a block hash before the block exists.
- Question for the team: is BLOCKHASH meant to return 0 on the EVM lane?

## Owner key offline: agent key spike (20 Nov 2026)

`scripts/authenticator-spike.ts`, SDK 0.14.0, chain v3.2.8, test owner `0x181A21311797E258B346e7728E43Ae782fa41Ab7`, relayer = the agent account, registry v4. Result: 8 of 8 checks passed.

| Step | Result | Transaction |
|---|---|---|
| Link a secp256k1 agent key (20-byte address, EIP-191 possession proof), permission `evm`, spending rule: only `anchor()` on registry v4, 1 uqor per tx and per day | Accepted | `F7853FB5...52D6` |
| Owner EVM window | None live during the test | - |
| Anchor one window through `MsgExecuteEVM` from the relayer | Accepted. The record shows the owner (`0x181A...1Ab7`) as owner, so no contract change is needed | `778CC249...1D38`, block 10,419,865 |
| Same call data to registry v3 | Refused by the spending rule: "a linked key with a spending rule may call" only the listed target. The tx succeeds, the execution fails, the nonce is used | `3F01CABF...BD8E` |
| Value transfer of 1,000 uqor | Refused: "per-tx limit 1uqor exceeded" | `8AD2CD01...F4D8` |
| Revoke the agent key | Accepted | `8CBC76A2...2E30` |
| Anchor after revoke | Refused at broadcast: the key lacks the permission | - |

Findings:
- `MsgExecuteEVM` runs the call from the owner's EVM address, and it needs no EVM window. The owner's recovery phrase can leave the recorder.
- Gas: the relayed anchor used 895,024 gas (direct anchor: about 406,000 EVM gas). With 1,500,000 gas wanted at 0.1 uqor, the fee was 0.15 QOR. With about 1,100,000 gas wanted it would be about 0.11 QOR. A relayed call pays for the gas wanted, so a relayed anchor costs about 2.4 times a direct anchor (about 0.0457 QOR charged, see "Measured cost on registry v4" above).
- A refused execution does not revert the transaction. It emits `abstractaccount_execution_failed` and uses the key's nonce. The agent must read that event, not only the tx code.

### Follow-up, 21 Nov: no EVM logs for relayed calls

- The relayed anchor of 20 Nov (block 10,419,865) is stored in the registry: `getAnchor` and `verifyAnchor` return it. But `eth_getLogs` for that block returns no `Anchored` event, and the Cosmos transaction carries no EVM log events either. To our knowledge, events emitted inside a `MsgExecuteEVM` call are not exposed over the EVM JSON-RPC on chain v3.2.8.
- The relayed call has no EVM transaction hash. The receipt can only name the Cosmos transaction hash.
- Effects on QoreWitness in agent-key mode:
  - The browser and CLI verifiers read contract state (`verifyAnchor`), so they keep working.
  - The Python verifier checks the root in the EVM transaction input (`eth_getTransactionByHash`). For relayed anchors it needs a second path: read the `MsgExecuteEVM` call data from the Cosmos REST API.
  - Crash recovery finds the transaction through the `Anchored` event. For relayed anchors it must search Cosmos transactions of the relayer at the anchor's block height instead.
- A question for the QoreChain team: are logs of `MsgExecuteEVM` calls planned in `eth_getLogs`?
- Testnet moved to v3.2.9 on 20 Nov (about 09:00 UTC). `probe:pqc` passes on 21 Nov and the live agent anchors normally, so the PQC precompiles behave as before.
