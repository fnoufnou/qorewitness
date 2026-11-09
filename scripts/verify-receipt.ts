/**
 * verify-receipt.ts - checks a file against a QoreWitness receipt, independent of the camera owner.
 * Usage: pnpm tsx scripts/verify-receipt.ts <receipt.json> <file>
 * Checks: file hash, Merkle path, verifyAnchor on chain, device key hash on chain,
 * ML-DSA-87 signature (locally) and the signature hash stored on chain.
 * Exit code 0 only if every check passes.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { createPublicClient, http, type PublicClient } from "viem";
import { sha256File } from "../src/agent/hash-file.js";
import { qorechainTestnet } from "../src/agent/anchor-client.js";
import { verifyReceipt, type ReceiptV2 } from "../src/core/verify.js";

const [receiptPath, filePath] = process.argv.slice(2);
if (!receiptPath || !filePath) {
  console.error("Usage: verify-receipt.ts <receipt.json> <file>");
  process.exit(1);
}
const r = JSON.parse(readFileSync(receiptPath, "utf8")) as ReceiptV2;
const pub = createPublicClient({ chain: qorechainTestnet, transport: http() }) as PublicClient;
const res = await verifyReceipt(pub, r, await sha256File(filePath));
const seg = r.segments.find((s) => s.file === basename(filePath));
if (seg === undefined) console.log(`note  file name is not in the receipt, the hash decides`);
for (const s of res.steps) console.log(`${s.state.toUpperCase().padEnd(5)} ${s.text}`);
if (res.ok && res.anchoredAt) {
  console.log(`\nVerified: the file existed before ${res.anchoredAt.toISOString()}.`);
} else {
  console.log("\nNot verified.");
  process.exitCode = 1;
}
