# Testnet findings

Live checks against `qorechain-diana` (EVM chain ID 9800, `https://evm-testnet.qore.host`) on 9 Nov 2026.

## pqcVerify precompile (`0x...0A01`)

Script: `scripts/probe-pqc.ts` (eth_call, no account needed).

| Input | Result | Gas estimate (whole call) |
|---|---|---|
| Deterministic ML-DSA-87 signature, empty context | true | 313,150 |
| Hedged signature | true | 312,910 |
| One bit changed in the signature | false | 313,150 |
| Signature over a different message | false | 311,720 |
| Short signature (100 bytes) | false | 132,940 |
| Valid signature over an empty message | false | 310,740 |

Conclusions:

- `@qorechain/pqc` `mldsa.sign(secretKey, message)` output verifies on chain as is.
- Bad input returns false. It does not revert.
- Empty messages are refused. QoreWitness messages are always 184 bytes.
- The address must be written lower case in viem and Solidity (checksum rules).

## pqcKeyStatus precompile (`0x...0A02`)

Script: `scripts/probe-keystatus.ts`.

- Returns the 4-value form `(bool registered, uint8 algorithmId, bytes pubkey, bool possessionProven)`.
- A validator account showed `registered = true`, `algorithmId = 1`, a 2,592-byte key and `possessionProven = false`. Older keys likely lack the proof of possession.
- `QorePqc.keyStatus` reads both the 3-value and the 4-value form.

## Cost estimate per anchor

- About 313,000 gas for the verification call alone (calldata of about 7.4 KB plus the precompile).
- Measured on the first anchor: 340,949 gas in total (3 files).
- At the 0.1 uqor per gas minimum this is about 0.04 QOR per anchor. One anchor per minute is about 58 QOR per day. The faucet gives 100 QOR per 24 h. A 5-minute window is the default.

## First deployment and anchor (9 Nov 2026)

- `AnchorRegistry`: `0xA73d4347b50C2A373533915d698Bf03a01c65aAF`, `requirePossessionProof = true`.
- Agent account: `0xD6C6bDfBE567BcE731907789800205Df0B78ca52`. Key registered with `register-key-v2` (proof of possession).
- Deploy: unscoped EVM window (600 blocks, 3 txs). Anchoring: window scoped to the registry (`allowed_targets`), 2,000 blocks, 10 txs.
- First anchor: 3 files, tx `0x0048aee4ca79a9a499d50a855415fdb50b7594efcc33a423e830db5e47157d40`, block 9790419, **340,949 gas** (about 0.034 QOR at 0.1 uqor per gas).
- `scripts/verify-receipt.ts`: all 8 checks pass for the original file. A file with one extra byte fails the first check.

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
- An anchor costs about 60,000 gas more than in v1, because the 2,592-byte device key is in the calldata. About 0.04 QOR per anchor at 0.1 uqor per gas.
- The contract stores only `keccak256` of the device key. Storage for the full key would cost about 1.7 million gas per device.

## Finding: ML-DSA key derived from the ECDSA key (Q-Day Drill risk)

- `@qorechain/sdk` 0.12.0 `unifiedAccountFromSeed(privateKey)` derives the ML-DSA-87 seed as `SHAKE-256("qorechain:pqc:v1|" + qor1-address + "|seed:" + hex(privateKey))`.
- So for an account made from a raw private key (the `PRIVATE_KEY` path of the template helper `pnpm window`), the ECDSA key is enough to rebuild the ML-DSA key. The post-quantum protection is then likely void for that account.
- `deriveUnifiedAccount(mnemonic)` uses the mnemonic as the secret. The ECDSA key alone does not give the ML-DSA key, because the BIP-32 path is one-way.
- Rule for the Q-Day Drill: create the drill account from a fresh mnemonic. Hand over only its ECDSA private key.
