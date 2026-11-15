# QoreWitness specification (qorewitness-spec/3)

This document defines every byte that QoreWitness computes. Anyone can re-implement the checks from it, without QoreWitness code. A receipt names the rules it follows in `generator.spec`.

## 1. File hashes

`fileHash = SHA-256(file bytes)`, 32 bytes. Since spec/3 also `fileSha3 = SHA3-256(file bytes)` (FIPS 202), 32 bytes. Any standard tool gives the same values:

- Linux: `sha256sum clip.mp4` and `openssl dgst -sha3-256 clip.mp4`
- macOS: `shasum -a 256 clip.mp4` and `openssl dgst -sha3-256 clip.mp4`
- Windows: `Get-FileHash clip.mp4 -Algorithm SHA256`. For SHA3-256 use Python or OpenSSL.
- Python: `hashlib.sha256` and `hashlib.sha3_256`

The two functions have different designs (Merkle-Damgard and Keccak sponge). To swap a file without a trace, a forger must find a collision in both at once. This keeps a receipt useful if one of them weakens over the years. (Two hashes of the same design, such as SHA-256 and SHA-512, add less: Joux's multicollision attack works across them.)

### Which fingerprint decides

Both decide. A spec/3 segment is **verified** only when SHA-256 and SHA3-256 of the file both match the receipt. A verifier that accepts either one inherits the weaker of the two, so QoreWitness verifiers never do that.

| Result | Meaning |
|---|---|
| Verified | Both fingerprints match and every other check passes. |
| Partly verified | No check failed, but the verifier did not compute SHA3-256 (for example an older tool). Not enough on its own. CLI exit code 2. |
| Not verified | A check failed. |
| One fingerprint | A spec/2 segment has SHA-256 only. It is verified on SHA-256, and the verifier says so. |

If SHA-256 matches and SHA3-256 does not, there are two possible causes: a fault in one hash implementation, or a file made to collide with the original under SHA-256. The second is the attack that SHA3-256 is there to catch. Today a fault is far more likely, because no practical SHA-256 collision is known. The file and the receipt do not change, so a fault in a tool does not destroy evidence. Recompute both values with a second, independent tool (section 1, for example OpenSSL and Python). If both tools confirm the mismatch, the file is not verified. The QoreWitness verifiers are tested against the FIPS 180-4 and FIPS 202 test vectors.

The segment links and the Merkle tree above the files use SHA-256 only. Their inputs are hash outputs that an attacker cannot shape freely, so a structural attack on SHA-256 is likely much harder there than on a raw file. A full break of SHA-256 would need a new spec version.

## 2. Segment chain (spec/2, spec/3)

Each segment commits to the segment before it, also across windows:

- spec/3: `link = SHA-256(0x03 || prevLink || fileHash || fileSha3 || startMs || durationMs || sourceFp)`
- spec/2: `link = SHA-256(0x02 || prevLink || fileHash || startMs || durationMs || sourceFp)`

A segment with `sha3_256` in the receipt uses the spec/3 form. A segment without it uses the spec/2 form. Both forms can follow each other in one chain.

| Field | Bytes | Value |
|---|---|---|
| prevLink | 32 | link of the previous segment of the device, 32 zero bytes for the first |
| fileHash | 32 | section 1, SHA-256 |
| fileSha3 | 32 | section 1, SHA3-256 (spec/3 only) |
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

Domain tag in spec/2 and spec/3: `keccak256("QoreWitness/AnchorRegistry/v3")`. Total: 256 bytes (spec/1: 184 bytes, without the last three fields).

The block hash is unknown before the block exists. So the signature, and the root under it, was made after `refBlock`. The anchor block shows it existed before the anchor time. The contract accepts only one of the last 256 blocks (about 5 minutes on testnet). Where the EVM gives block hashes, the contract also compares the hash. On qorechain-diana `BLOCKHASH` returns 0 (14 Nov 2026), so there the verifier compares the signed hash with the chain's block. Register, revoke and rotate messages follow the same pattern with their own tags (see `src/core/message.ts`).

## 5. On-chain record

- The registry accepts an anchor only after the `pqcVerify` precompile (`0x...0a01`) confirms the ML-DSA-87 signature with the registered device key.
- `anchorId = keccak256(abi.encode(owner, deviceId, windowStart))`, 32-byte words.
- The contract keeps a chain head per device (the newest root). A new window must name it as `prevRoot`, or the anchor fails (`BrokenChain`). Time without an anchor between two windows is stored as `gapBefore` and emitted as `WindowGap`.
- `getAnchor(anchorId)` (selector `0x7feb51d9`) returns 13 words: root, sigHash (`keccak256(signature)`), deviceKeyHash, prevRoot, owner, deviceKeyVersion, windowStart, windowSeconds, leafCount, anchoredAt (block time), blockNumber, refBlock, gapBefore. (spec/1 registries: 10 words, without prevRoot, refBlock and gapBefore.)
- `verifyAnchor(owner, deviceId, windowStart, link, index, proof)` returns the full check, the full record and the chain head in one call and never reverts.
- The anchor transaction calls `anchor((bytes32,uint64,uint32,uint32,bytes32,bytes32,uint64,bytes32),bytes,bytes)` (selector `0xb813aa2a`). In its input, after the 4-byte selector, word 1 is the deviceId, word 2 windowStart, word 3 windowSeconds, word 4 leafCount, **word 5 the root**, word 6 prevRoot, word 7 refBlock and word 8 refBlockHash. (spec/1: selector `0x7220498d`, root also word 5.)

## 6. Receipt

JSON, format `qorewitness-receipt/v3` (spec/2 and spec/3) or `qorewitness-receipt/v2` (spec/1). v3 adds `prevRoot`, `refBlock`, `refBlockHash`, and per segment `prevLink`, `link`, `startMs`, `durationMs`, `sourceFp`, `source`, and the warnings `gapBeforeMs` and `sourceChanged`. Fields: `chain` (evmChainId, registry, txHash, anchorId, blockNumber), `owner`, `deviceId`, `deviceLabel`, `devicePubkey`, `windowStart`, `windowSeconds`, `root`, `signature`, `segments[]` (file, sha256, size, index, proof), and since 14 Nov 2026 `generator` (name, version, commit, spec) and `settings`. spec/3 adds `segments[].sha3_256` and sets `settings.fileHash` to `sha256+sha3-256`.

## 7. Replay with third-party tools

A person who does not trust QoreWitness can check a clip in four steps. No step uses QoreWitness code.

1. **Hash.** Run `sha256sum clip.mp4`. The value must be in the receipt under `segments[].sha256`. Run `openssl dgst -sha3-256 clip.mp4`. The value must match `sha3_256` of the same segment.
2. **Chain and Merkle path.** Run `python3 tools/verify_receipt.py receipt.json clip.mp4`. It has about 200 lines and uses only the Python standard library. Read it first. It checks both hashes, rebuilds the segment link and the root, and checks the window chain and the reference block.
3. **Public chain.** Search the receipt's `chain.txHash` on the QoreChain explorer (https://explore.qore.network, testnet). Check that the transaction went to the registry address. Check that word 5 of the input data is the root. The block time is the time before which the file existed. Word 7 is the reference block and word 8 its hash: compare it with that block on the explorer. Its time is the time after which the root was signed.
4. **Exact software.** The receipt names the release and the git commit. Check out that commit from https://github.com/fnoufnou/qorewitness to read or rerun the exact code that made the receipt.

The post-quantum signature was checked on chain by the `pqcVerify` precompile before the record was accepted. The browser verifier also checks it locally.

## Versions

| Spec | Since | Change |
|---|---|---|
| qorewitness-spec/1 | 14 Nov 2026 | First version. Registry v3 rules (max window 1 day, max proof length 32). |
| qorewitness-spec/2 | 14 Nov 2026 | Segment chain with stream fingerprint, window chain (prevRoot) with gaps on chain, lower time bound (refBlock). Registry v4. After feedback from the QoreChain team on chain of custody. |
| qorewitness-spec/3 | 15 Nov 2026 | Second file hash (SHA3-256) bound into the segment link (tag 0x03). Same registry v4: the contract sees only the root. |
