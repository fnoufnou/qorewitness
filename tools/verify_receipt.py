#!/usr/bin/env python3
"""Independent QoreWitness receipt check. Python 3.8+, standard library only.

It does not use any QoreWitness code. It follows docs/SPEC.md. Receipt v3
(qorewitness-spec/2) adds the segment chain, the window chain and a lower time
bound. Receipt v2 (spec/1) is still checked as before.

  1. SHA-256 of the file is listed in the receipt.
  2. The Merkle path leads from the file to the root in the receipt.
  3. The registry contract returns the same root for this anchor (getAnchor).
  4. The anchor transaction on the public chain carries the same root in its input,
     was sent to the registry, and its block time is the anchor time.
  5. Optional, with pycryptodome installed: the anchor id and the signature hash
     (keccak256 is not in the Python standard library).

The ML-DSA-87 signature itself was checked on chain by the pqcVerify precompile
when the anchor was accepted. The browser verifier also checks it locally.

Usage: python3 verify_receipt.py <receipt.json> <file> [--rpc https://evm-testnet.qore.host]
Exit code 0 only if every check passes.
"""
import hashlib
import json
import sys
import urllib.request
from datetime import datetime, timezone

SEL_GET_ANCHOR = "7feb51d9"  # keccak256("getAnchor(bytes32)")[:4]
SEL_ANCHOR_V2 = "7220498d"  # anchor(bytes32,uint64,uint32,uint32,bytes32,bytes,bytes)
SEL_ANCHOR_V3 = "4aae1d6a"  # anchor((bytes32,uint64,uint32,uint32,bytes32,bytes32,uint64),bytes,bytes)
MAX_PROOF_LENGTH = 32

failed = False


def check(ok, text):
    global failed
    print(("PASS  " if ok else "FAIL  ") + text)
    if not ok:
        failed = True
    return ok


def h(b):
    return hashlib.sha256(b).digest()


def leaf(seg):
    return h(b"\x00" + seg)


def node(left, right):
    return h(b"\x01" + left + right)


def segment_link(prev_link, file_hash, start_ms, duration_ms, source_fp):
    """spec/2: SHA-256(0x02 || prevLink || fileHash || startMs u64 BE || durationMs u32 BE || sourceFp)"""
    return h(b"\x02" + prev_link + file_hash + int(start_ms).to_bytes(8, "big") + int(duration_ms).to_bytes(4, "big") + source_fp)


def verify_proof(root, seg, index, size, proof):
    if index < 0 or index >= size or len(proof) > MAX_PROOF_LENGTH:
        return False
    x, p, i, n = leaf(seg), 0, index, size
    while n > 1:
        if i % 2 == 1:
            if p >= len(proof):
                return False
            x = node(proof[p], x)
            p += 1
        elif i + 1 < n:
            if p >= len(proof):
                return False
            x = node(x, proof[p])
            p += 1
        i //= 2
        n = (n + 1) // 2
    return p == len(proof) and x == root


def rpc(url, method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    # Some RPC front ends refuse the default urllib user agent.
    req = urllib.request.Request(url, body, {"content-type": "application/json", "user-agent": "qorewitness-verify/1"})
    with urllib.request.urlopen(req, timeout=30) as r:
        res = json.loads(r.read())
    if "error" in res:
        raise RuntimeError(res["error"])
    return res["result"]


def b(hexstr):
    return bytes.fromhex(hexstr[2:] if hexstr.startswith("0x") else hexstr)


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    rpc_url = "https://evm-testnet.qore.host"
    if "--rpc" in argv:
        rpc_url = argv[argv.index("--rpc") + 1]
    receipt = json.load(open(argv[1], encoding="utf-8"))
    data = open(argv[2], "rb").read()

    gen = receipt.get("generator")
    if gen:
        print("info  receipt made by %s %s, commit %s, rules %s" % (gen["name"], gen["version"], gen["commit"], gen["spec"]))

    file_hash = h(data)
    seg = next((s for s in receipt["segments"] if b(s["sha256"]) == file_hash), None)
    if not check(seg is not None, "SHA-256 %s is listed in the receipt" % file_hash.hex()):
        return 1
    root = b(receipt["root"])
    v3 = receipt["format"] == "qorewitness-receipt/v3"
    leaf_input = file_hash
    if v3:
        link = segment_link(b(seg["prevLink"]), file_hash, seg["startMs"], seg["durationMs"], b(seg["sourceFp"]))
        check(link == b(seg["link"]), "segment chain link matches file, start time, length, stream and previous segment")
        segs = receipt["segments"]
        check(all(segs[i]["prevLink"] == segs[i - 1]["link"] for i in range(1, len(segs))), "segments of the window form one unbroken chain")
        leaf_input = link
    check(
        verify_proof(root, leaf_input, seg["index"], len(receipt["segments"]), [b(p) for p in seg["proof"]]),
        "Merkle path leads to root 0x%s" % root.hex(),
    )

    registry = receipt["chain"]["registry"].lower()
    anchor_id = receipt["chain"]["anchorId"]
    out = b(rpc(rpc_url, "eth_call", [{"to": registry, "data": "0x" + SEL_GET_ANCHOR + anchor_id[2:]}, "latest"]))
    words = [out[i : i + 32] for i in range(0, len(out), 32)]
    if not check(len(words) == (13 if v3 else 10), "registry %s returns the anchor record" % registry):
        return 1
    as_int = lambda w: int.from_bytes(w, "big")
    if v3:  # root, sigHash, keyHash, prevRoot, owner, keyVersion, windowStart, windowSeconds, leafCount, anchoredAt, block, refBlock, gapBefore
        chain_root, sig_hash, owner_w, start_w = words[0], words[1], words[4], words[6]
        anchored_at, block_no, ref_block, gap = as_int(words[9]), as_int(words[10]), as_int(words[11]), as_int(words[12])
        check(words[3] == b(receipt["prevRoot"]), "window links to the previous window of this camera (prevRoot on chain)")
        if gap:
            print("WARN  no anchor covers the %d seconds before this window" % gap)
    else:
        chain_root, sig_hash, owner_w, start_w = words[0], words[1], words[3], words[5]
        anchored_at, block_no = as_int(words[8]), as_int(words[9])
    check(chain_root == root, "root stored in the registry equals the receipt root")
    check("0x" + owner_w[12:].hex() == receipt["owner"].lower(), "owner on chain is %s" % receipt["owner"])
    check(as_int(start_w) == int(receipt["windowStart"]), "window start on chain equals the receipt")

    tx_hash = receipt["chain"].get("txHash")
    if tx_hash:
        tx = rpc(rpc_url, "eth_getTransactionByHash", [tx_hash])
        inp = b(tx["input"])
        check(tx["to"].lower() == registry, "transaction %s was sent to the registry" % tx_hash)
        check(inp[:4].hex() == (SEL_ANCHOR_V3 if v3 else SEL_ANCHOR_V2), "transaction calls anchor(...)")
        check(inp[4 + 4 * 32 : 4 + 5 * 32] == root, "root is the 5th argument in the transaction input")
        check(int(tx["blockNumber"], 16) == block_no, "transaction block %d equals the anchor block" % block_no)
        blk = rpc(rpc_url, "eth_getBlockByNumber", [hex(block_no), False])
        check(int(blk["timestamp"], 16) == anchored_at, "block time equals the anchor time")
    if v3:
        ref = rpc(rpc_url, "eth_getBlockByNumber", [hex(ref_block), False])
        check(ref["hash"] == receipt["refBlockHash"].lower(), "reference block %d has the hash the camera signed" % ref_block)
        signed_after = datetime.fromtimestamp(int(ref["timestamp"], 16), timezone.utc).isoformat()
        print("info  signed after %s (block %d)" % (signed_after, ref_block))

    try:
        from Crypto.Hash import keccak  # pycryptodome, optional

        k = lambda x: keccak.new(digest_bits=256, data=x).digest()
        enc = b"\x00" * 12 + b(receipt["owner"]) + b(receipt["deviceId"]) + int(receipt["windowStart"]).to_bytes(32, "big")
        check("0x" + k(enc).hex() == anchor_id.lower(), "anchor id = keccak256(owner, device, window start)")
        check(k(b(receipt["signature"])) == sig_hash, "signature in the receipt is the one the contract checked")
    except ImportError:
        print("info  install pycryptodome to also check the anchor id and the signature hash")

    when = datetime.fromtimestamp(anchored_at, timezone.utc).isoformat()
    print("\n%s: the file existed before %s (block %d)." % ("NOT VERIFIED" if failed else "Verified", when, block_no))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
