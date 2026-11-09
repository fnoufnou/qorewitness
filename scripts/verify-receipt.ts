/**
 * verify-receipt.ts - checks a file against a QoreWitness receipt, independent of the camera owner.
 * Usage: pnpm tsx scripts/verify-receipt.ts <receipt.json> <file>
 * Checks: file hash, Merkle path to the root, anchor record on chain, ML-DSA-87 signature
 * against the key the chain has registered for the signer, and the contract's own verifySegment.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { mldsa } from "@qorechain/pqc";
import { createPublicClient, http, keccak256, parseAbi, toBytes, toHex, type Address, type Hex } from "viem";
import { sha256File } from "../src/agent/hash-file.js";
import { qorechainTestnet } from "../src/agent/anchor-client.js";
import { equal, verifyProof } from "../src/core/merkle.js";
import { signingMessage } from "../src/core/message.js";
import type { Receipt } from "../src/agent/receipt.js";

const [receiptPath, filePath] = process.argv.slice(2);
if (!receiptPath || !filePath) {
  console.error("Usage: verify-receipt.ts <receipt.json> <file>");
  process.exit(1);
}
const r = JSON.parse(readFileSync(receiptPath, "utf8")) as Receipt;
const pub = createPublicClient({ chain: qorechainTestnet, transport: http() });
const ABI = parseAbi([
  "struct Anchor { bytes32 root; bytes32 sigHash; address signer; uint64 windowStart; uint32 windowSeconds; uint32 leafCount; uint64 anchoredAt; uint64 blockNumber; }",
  "function getAnchor(bytes32 anchorId) view returns (Anchor)",
  "function verifySegment(bytes32 anchorId, bytes32 segmentHash, uint256 index, bytes32[] proof) view returns (bool)",
]);
const KEY_ABI = parseAbi(["function pqcKeyStatus(address) view returns (bool, uint8, bytes, bool)"]);
const ok = (b: boolean, what: string) => {
  console.log(`${b ? "PASS" : "FAIL"}  ${what}`);
  if (!b) process.exitCode = 1;
  return b;
};

const fileHash = await sha256File(filePath);
const found = r.segments.find((s) => s.sha256 === toHex(fileHash));
if (!ok(!!found, `file hash ${toHex(fileHash).slice(0, 18)}... is listed in the receipt`)) process.exit(1);
const seg = found!;
if (seg.file !== basename(filePath)) console.log(`note  file name differs from receipt (${seg.file}), the hash decides`);

ok(
  verifyProof(toBytes(r.root), fileHash, seg.index, r.segments.length, seg.proof.map((p) => toBytes(p))),
  `Merkle path leads to root ${r.root.slice(0, 18)}...`,
);

const registry = r.chain.registry;
const a = await pub.readContract({ address: registry, abi: ABI, functionName: "getAnchor", args: [r.chain.anchorId!] });
ok(a.root === r.root, "root on chain equals root in receipt");
ok(a.signer.toLowerCase() === r.signer.toLowerCase(), `signer on chain is ${a.signer}`);

const [registered, alg, pubkey] = await pub.readContract({
  address: "0x0000000000000000000000000000000000000a02", abi: KEY_ABI, functionName: "pqcKeyStatus", args: [a.signer],
});
const msg = signingMessage(BigInt(qorechainTestnet.id), registry as Address, {
  signer: a.signer, deviceId: r.deviceId as Hex, windowStart: a.windowStart,
  windowSeconds: a.windowSeconds, leafCount: a.leafCount, root: a.root,
});
ok(registered && alg === 1, "signer has an ML-DSA-87 key registered on chain");
ok(mldsa.verify(toBytes(pubkey), msg, toBytes(r.signature)), "ML-DSA-87 signature is valid (checked locally)");
ok(equal(toBytes(a.sigHash), toBytes(keccak256(r.signature))), "signature matches the hash stored on chain");
ok(
  await pub.readContract({
    address: registry, abi: ABI, functionName: "verifySegment",
    args: [r.chain.anchorId!, toHex(fileHash), BigInt(seg.index), seg.proof as Hex[]],
  }),
  "contract verifySegment() confirms the file",
);
console.log(`\nThe file existed before ${new Date(Number(a.anchoredAt) * 1000).toISOString()} (block ${a.blockNumber}).`);
console.log(`Device claim: recorded in the window starting ${new Date(Number(a.windowStart) * 1000).toISOString()}.`);
