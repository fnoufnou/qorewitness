/**
 * QoreWitness browser verifier. Runs fully in the browser: the video never leaves
 * the device. It needs only the file, its receipt and the public QoreChain RPC.
 */
import { mldsa } from "@qorechain/pqc";
import { createPublicClient, defineChain, http, keccak256, parseAbi, toBytes, toHex, type Address, type Hex } from "viem";
import { equal, verifyProof } from "../../src/core/merkle.js";
import { signingMessage } from "../../src/core/message.js";

interface Receipt {
  format: string;
  chain: { evmChainId: number; registry: Address; txHash?: Hex; anchorId?: Hex; blockNumber?: string };
  signer: Address;
  deviceId: Hex;
  deviceLabel: string;
  root: Hex;
  signature: Hex;
  segments: { file: string; sha256: Hex; size: number; index: number; proof: Hex[] }[];
}

const chain = defineChain({
  id: 9800,
  name: "QoreChain Testnet (diana)",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: ["https://evm-testnet.qore.host"] } },
});
const pub = createPublicClient({ chain, transport: http() });
const ABI = parseAbi([
  "struct Anchor { bytes32 root; bytes32 sigHash; address signer; uint64 windowStart; uint32 windowSeconds; uint32 leafCount; uint64 anchoredAt; uint64 blockNumber; }",
  "function getAnchor(bytes32 anchorId) view returns (Anchor)",
  "function verifySegment(bytes32 anchorId, bytes32 segmentHash, uint256 index, bytes32[] proof) view returns (bool)",
  "function pqcKeyStatus(address) view returns (bool, uint8, bytes, bool)",
]);
const PQC_KEY_STATUS: Address = "0x0000000000000000000000000000000000000a02";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const steps = $("steps");
const verdict = $("verdict");

function step(state: "pass" | "fail" | "info", text: string): boolean {
  const li = document.createElement("li");
  li.className = state;
  li.textContent = text;
  steps.appendChild(li);
  return state !== "fail";
}

async function sha256(file: File): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
}

async function run(video: File, receiptFile: File): Promise<void> {
  steps.replaceChildren();
  verdict.className = "verdict";
  verdict.textContent = "Checking…";
  let all = true;
  const fail = (t: string) => { all = false; step("fail", t); };
  try {
    const r = JSON.parse(await receiptFile.text()) as Receipt;
    if (r.format !== "qorewitness-receipt/v1") throw new Error("not a QoreWitness receipt");
    if (r.chain.evmChainId !== chain.id) throw new Error(`receipt is for chain ${r.chain.evmChainId}, this page checks ${chain.id}`);

    const h = await sha256(video);
    const seg = r.segments.find((s) => s.sha256 === toHex(h));
    if (!seg) {
      fail(`The file's fingerprint (SHA-256 ${toHex(h).slice(0, 14)}…) is not in this receipt. The file was changed, or it belongs to another receipt.`);
      throw new Error("stop");
    }
    step("pass", `File fingerprint found in the receipt (segment ${seg.index + 1} of ${r.segments.length}).`);

    if (verifyProof(toBytes(r.root), h, seg.index, r.segments.length, seg.proof.map((p) => toBytes(p)))) {
      step("pass", "Merkle path from the file to the window root is valid.");
    } else fail("Merkle path does not lead to the root.");

    const a = await pub.readContract({ address: r.chain.registry, abi: ABI, functionName: "getAnchor", args: [r.chain.anchorId!] });
    if (a.root === r.root) step("pass", `The root is stored on QoreChain in block ${a.blockNumber}.`);
    else fail("The root on chain differs from the receipt.");

    const [registered, alg, pubkey] = await pub.readContract({
      address: PQC_KEY_STATUS, abi: ABI, functionName: "pqcKeyStatus", args: [a.signer],
    });
    if (registered && alg === 1) step("pass", `Signer ${a.signer.slice(0, 10)}… has an ML-DSA-87 (post-quantum) key on chain.`);
    else fail("The signer has no post-quantum key on chain.");

    const msg = signingMessage(BigInt(chain.id), r.chain.registry, {
      signer: a.signer, deviceId: r.deviceId, windowStart: a.windowStart,
      windowSeconds: a.windowSeconds, leafCount: a.leafCount, root: a.root,
    });
    if (mldsa.verify(toBytes(pubkey), msg, toBytes(r.signature))) step("pass", "ML-DSA-87 signature over the root is valid (checked in this browser).");
    else fail("ML-DSA-87 signature is not valid.");
    if (equal(toBytes(a.sigHash), toBytes(keccak256(r.signature)))) step("pass", "Signature matches the one recorded on chain.");
    else fail("Signature differs from the one recorded on chain.");

    const onChain = await pub.readContract({
      address: r.chain.registry, abi: ABI, functionName: "verifySegment",
      args: [r.chain.anchorId!, toHex(h), BigInt(seg.index), seg.proof],
    });
    if (onChain) step("pass", "The contract itself confirms the file (verifySegment).");
    else fail("The contract does not confirm the file.");

    const anchored = new Date(Number(a.anchoredAt) * 1000);
    const start = new Date(Number(a.windowStart) * 1000);
    step("info", `Camera "${r.deviceLabel}" claims recording between ${start.toISOString()} and ${new Date((Number(a.windowStart) + a.windowSeconds) * 1000).toISOString()}.`);
    if (all) {
      verdict.className = "verdict ok";
      verdict.textContent = `Verified: this exact file existed before ${anchored.toLocaleString()} (${anchored.toISOString()}).`;
    } else {
      verdict.className = "verdict bad";
      verdict.textContent = "Not verified. See the failed checks.";
    }
  } catch (e) {
    if ((e as Error).message !== "stop") step("fail", (e as Error).message);
    verdict.className = "verdict bad";
    verdict.textContent = "Not verified.";
  }
}

$("go").addEventListener("click", () => {
  const v = $<HTMLInputElement>("video").files?.[0];
  const r = $<HTMLInputElement>("receipt").files?.[0];
  if (!v || !r) {
    verdict.className = "verdict bad";
    verdict.textContent = "Choose a video file and its receipt first.";
    return;
  }
  void run(v, r);
});
