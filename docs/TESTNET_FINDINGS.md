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
- Plus storage and the event: likely about 400,000 gas per anchor in total. To be measured on the first deploy.
- At the 0.1 uqor per gas minimum this is about 0.04 QOR per anchor. One anchor per minute is about 58 QOR per day. The faucet gives 100 QOR per 24 h. A 5-minute window is the default.
