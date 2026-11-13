# QoreWitness specification (qorewitness-spec/1)

This document defines every byte that QoreWitness computes. Anyone can re-implement the checks from it, without QoreWitness code. A receipt names the rules it follows in `generator.spec`.

## 1. File hash

`fileHash = SHA-256(file bytes)`, 32 bytes. Any standard tool gives the same value:

- Linux and macOS: `sha256sum clip.mp4` or `shasum -a 256 clip.mp4`
- Windows: `Get-FileHash clip.mp4 -Algorithm SHA256`

## 2. Merkle tree per window

RFC 6962 style domain separation. `||` is byte concatenation.

- `leaf = SHA-256(0x00 || fileHash)`
- `node = SHA-256(0x01 || left || right)`
- Leaves are in the order of `segments[].index` in the receipt.
- Each level pairs nodes from left to right. An odd last node moves up one level unchanged. It is never duplicated.
- The root is the single node at the top. A window with one file has `root = leaf`.

Proof for the file at `index` in a window of `size` files: the sibling hashes from the leaf up, in order. At each level: if `index` is odd, the sibling is on the left. If `index` is even and `index + 1 < size`, the sibling is on the right. Otherwise the node moves up without a sibling. Then `index = floor(index / 2)` and `size = ceil(size / 2)`. A valid proof uses every sibling exactly once and has at most 32 entries.

## 3. Signed window message

The device signs these bytes with ML-DSA-87 (FIPS 204, empty context string). Big-endian, packed, no padding:

| Field | Bytes | Value |
|---|---|---|
| domain | 32 | `keccak256("QoreWitness/AnchorRegistry/v2")` |
| chainId | 32 | EVM chain ID (testnet: 9800) |
| registry | 20 | registry contract address |
| owner | 20 | account that owns the device |
| deviceId | 32 | `keccak256("QoreWitness/device/" + label)` |
| windowStart | 8 | unix seconds |
| windowSeconds | 4 | window length |
| leafCount | 4 | number of files |
| root | 32 | Merkle root |

Total: 184 bytes. Register, revoke and rotate messages follow the same pattern with their own tags (see `src/core/message.ts`).

## 4. On-chain record

- The registry accepts an anchor only after the `pqcVerify` precompile (`0x...0a01`) confirms the ML-DSA-87 signature with the registered device key.
- `anchorId = keccak256(abi.encode(owner, deviceId, windowStart))`, 32-byte words.
- `getAnchor(anchorId)` (selector `0x7feb51d9`) returns 10 words: root, sigHash (`keccak256(signature)`), deviceKeyHash, owner, deviceKeyVersion, windowStart, windowSeconds, leafCount, anchoredAt (block time), blockNumber.
- `verifyAnchor(owner, deviceId, windowStart, fileHash, index, proof)` returns the full check in one call and never reverts.
- The anchor transaction calls `anchor(bytes32,uint64,uint32,uint32,bytes32,bytes,bytes)` (selector `0x7220498d`). In its input, after the 4-byte selector, word 1 is the deviceId, word 2 windowStart, word 3 windowSeconds, word 4 leafCount and **word 5 the root**.

## 5. Receipt

JSON, format `qorewitness-receipt/v2`. Fields: `chain` (evmChainId, registry, txHash, anchorId, blockNumber), `owner`, `deviceId`, `deviceLabel`, `devicePubkey`, `windowStart`, `windowSeconds`, `root`, `signature`, `segments[]` (file, sha256, size, index, proof), and since 14 Nov 2026 `generator` (name, version, commit, spec) and `settings`.

## 6. Replay with third-party tools

A person who does not trust QoreWitness can check a clip in four steps. No step uses QoreWitness code.

1. **Hash.** Run `sha256sum clip.mp4`. The value must be in the receipt under `segments[].sha256`.
2. **Merkle path.** Run `python3 tools/verify_receipt.py receipt.json clip.mp4`. It has about 150 lines and uses only the Python standard library. Read it first. It rebuilds the root from the hash and the proof.
3. **Public chain.** Search the receipt's `chain.txHash` on the QoreChain explorer (https://explore.qore.network, testnet). Check that the transaction went to the registry address. Check that word 5 of the input data is the root. The block time is the time before which the file existed.
4. **Exact software.** The receipt names the release and the git commit. Check out that commit from https://github.com/fnoufnou/qorewitness to read or rerun the exact code that made the receipt.

The post-quantum signature was checked on chain by the `pqcVerify` precompile before the record was accepted. The browser verifier also checks it locally.

## Versions

| Spec | Since | Change |
|---|---|---|
| qorewitness-spec/1 | 14 Nov 2026 | First version. Registry v3 rules (max window 1 day, max proof length 32). |
