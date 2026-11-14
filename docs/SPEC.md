# QoreWitness specification (qorewitness-spec/2)

This document defines every byte that QoreWitness computes. Anyone can re-implement the checks from it, without QoreWitness code. A receipt names the rules it follows in `generator.spec`.

## 1. File hash

`fileHash = SHA-256(file bytes)`, 32 bytes. Any standard tool gives the same value:

- Linux and macOS: `sha256sum clip.mp4` or `shasum -a 256 clip.mp4`
- Windows: `Get-FileHash clip.mp4 -Algorithm SHA256`

## 2. Segment chain (spec/2)

Each segment commits to the segment before it, also across windows:

`link = SHA-256(0x02 || prevLink || fileHash || startMs || durationMs || sourceFp)`

| Field | Bytes | Value |
|---|---|---|
| prevLink | 32 | link of the previous segment of the device, 32 zero bytes for the first |
| fileHash | 32 | section 1 |
| startMs | 8 | unix milliseconds of the first frame, big-endian (from the recorder's file name) |
| durationMs | 4 | segment length in milliseconds, big-endian |
| sourceFp | 32 | SHA-256 of the stream description, or 32 zero bytes if unknown |

The stream description is a `key=value` list sorted by key and joined with `;`: codec, profile, width, height, fps, pixel format and `extradata` (the SHA-256 of the encoder's parameter sets, from `ffprobe -show_data_hash SHA256`). A clip from another camera or a re-encoded clip gets another description.

A removed, added, re-ordered or re-timed segment changes every later link. The receipt lists `prevLink` and `link` for every segment, so a verifier can check the whole window.

## 3. Merkle tree per window

RFC 6962 style domain separation. `||` is byte concatenation.

- `leaf = SHA-256(0x00 || link)` (spec/1: `fileHash` instead of `link`)
- `node = SHA-256(0x01 || left || right)`
- Leaves are in the order of `segments[].index` in the receipt.
- Each level pairs nodes from left to right. An odd last node moves up one level unchanged. It is never duplicated.
- The root is the single node at the top. A window with one file has `root = leaf`.

Proof for the file at `index` in a window of `size` files: the sibling hashes from the leaf up, in order. At each level: if `index` is odd, the sibling is on the left. If `index` is even and `index + 1 < size`, the sibling is on the right. Otherwise the node moves up without a sibling. Then `index = floor(index / 2)` and `size = ceil(size / 2)`. A valid proof uses every sibling exactly once and has at most 32 entries.

## 4. Signed window message

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
| prevRoot | 32 | root of the previous window of the device, 32 zero bytes for the first |
| refBlock | 8 | number of a recent block |
| refBlockHash | 32 | hash of that block |

Domain tag in spec/2: `keccak256("QoreWitness/AnchorRegistry/v3")`. Total: 256 bytes (spec/1: 184 bytes, without the last three fields).

The block hash is unknown before the block exists. So the signature, and the root under it, was made after `refBlock`. The anchor block shows it existed before the anchor time. The contract accepts only one of the last 256 blocks (about 5 minutes on testnet). Where the EVM gives block hashes, the contract also compares the hash. On qorechain-diana `BLOCKHASH` returns 0 (14 Nov 2026), so there the verifier compares the signed hash with the chain's block. Register, revoke and rotate messages follow the same pattern with their own tags (see `src/core/message.ts`).

## 5. On-chain record

- The registry accepts an anchor only after the `pqcVerify` precompile (`0x...0a01`) confirms the ML-DSA-87 signature with the registered device key.
- `anchorId = keccak256(abi.encode(owner, deviceId, windowStart))`, 32-byte words.
- The contract keeps a chain head per device (the newest root). A new window must name it as `prevRoot`, or the anchor fails (`BrokenChain`). Time without an anchor between two windows is stored as `gapBefore` and emitted as `WindowGap`.
- `getAnchor(anchorId)` (selector `0x7feb51d9`) returns 13 words: root, sigHash (`keccak256(signature)`), deviceKeyHash, prevRoot, owner, deviceKeyVersion, windowStart, windowSeconds, leafCount, anchoredAt (block time), blockNumber, refBlock, gapBefore. (spec/1 registries: 10 words, without prevRoot, refBlock and gapBefore.)
- `verifyAnchor(owner, deviceId, windowStart, link, index, proof)` returns the full check, the full record and the chain head in one call and never reverts.
- The anchor transaction calls `anchor((bytes32,uint64,uint32,uint32,bytes32,bytes32,uint64,bytes32),bytes,bytes)` (selector `0xb813aa2a`). In its input, after the 4-byte selector, word 1 is the deviceId, word 2 windowStart, word 3 windowSeconds, word 4 leafCount, **word 5 the root**, word 6 prevRoot, word 7 refBlock and word 8 refBlockHash. (spec/1: selector `0x7220498d`, root also word 5.)

## 6. Receipt

JSON, format `qorewitness-receipt/v3` (spec/2) or `qorewitness-receipt/v2` (spec/1). v3 adds `prevRoot`, `refBlock`, `refBlockHash`, and per segment `prevLink`, `link`, `startMs`, `durationMs`, `sourceFp`, `source`, and the warnings `gapBeforeMs` and `sourceChanged`. Fields: `chain` (evmChainId, registry, txHash, anchorId, blockNumber), `owner`, `deviceId`, `deviceLabel`, `devicePubkey`, `windowStart`, `windowSeconds`, `root`, `signature`, `segments[]` (file, sha256, size, index, proof), and since 14 Nov 2026 `generator` (name, version, commit, spec) and `settings`.

## 7. Replay with third-party tools

A person who does not trust QoreWitness can check a clip in four steps. No step uses QoreWitness code.

1. **Hash.** Run `sha256sum clip.mp4`. The value must be in the receipt under `segments[].sha256`.
2. **Chain and Merkle path.** Run `python3 tools/verify_receipt.py receipt.json clip.mp4`. It has about 200 lines and uses only the Python standard library. Read it first. It rebuilds the segment link and the root, and checks the window chain and the reference block.
3. **Public chain.** Search the receipt's `chain.txHash` on the QoreChain explorer (https://explore.qore.network, testnet). Check that the transaction went to the registry address. Check that word 5 of the input data is the root. The block time is the time before which the file existed. Word 7 is the reference block and word 8 its hash: compare it with that block on the explorer. Its time is the time after which the root was signed.
4. **Exact software.** The receipt names the release and the git commit. Check out that commit from https://github.com/fnoufnou/qorewitness to read or rerun the exact code that made the receipt.

The post-quantum signature was checked on chain by the `pqcVerify` precompile before the record was accepted. The browser verifier also checks it locally.

## Versions

| Spec | Since | Change |
|---|---|---|
| qorewitness-spec/1 | 14 Nov 2026 | First version. Registry v3 rules (max window 1 day, max proof length 32). |
| qorewitness-spec/2 | 14 Nov 2026 | Segment chain with stream fingerprint, window chain (prevRoot) with gaps on chain, lower time bound (refBlock). Registry v4. After feedback from the QoreChain team on chain of custody. |
