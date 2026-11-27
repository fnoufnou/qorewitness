/**
 * Live negative simulations against the deployed AnchorRegistry (eth_call only).
 *
 * eth_call needs no signature, so `from` can be the real owner address. The node runs the
 * real contract and the real pqcVerify / pqcKeyStatus precompiles and returns the revert
 * data. Nothing is sent, nothing is signed with the owner key, no funds are needed.
 *
 * What a custom error proves: contract checks run in source order. anchor() checks the
 * window, the chain head, the reference block and the device key before it calls the
 * precompile. So BadSignature() means all of those passed. The contract also cannot tell
 * "precompile returned false" from "precompile call failed" (QorePqc.verify returns false
 * for both). It does tell both apart from "precompile inactive" (PqcPrecompileInactive).
 */
import {
  decodeErrorResult, decodeEventLog, decodeFunctionData, decodeFunctionResult, encodeFunctionData, encodePacked, keccak256,
  pad, parseAbi, toBytes, toEventSelector, toHex, type Hex,
} from "viem";
import { mldsa } from "@qorechain/pqc";
import { DOMAIN, REGISTER_TAG, REVOKE_TAG } from "../core/message.js";
import { flipBit } from "./mutate.js";
import type { Rpc } from "./rpc.js";

export const DEFAULT_REGISTRY = "0xa1378D6558B32e1f8d37b68cf90e3C93839Da365" as const;
export const DEFAULT_OWNER = "0xD6C6bDfBE567BcE731907789800205Df0B78ca52" as const;
export const DEFAULT_RECEIPT_URL = "https://qorewitness.fnoufnou.com/sample-receipt.json";
export const CHAIN_ID = 9800;

export const LIVE_ABI = parseAbi([
  "struct Device { bytes32 keyHash; uint32 keyVersion; uint8 status; uint64 registeredAt; uint64 revokedAt; }",
  "struct WindowClaim { bytes32 deviceId; uint64 windowStart; uint32 windowSeconds; uint32 leafCount; bytes32 root; bytes32 prevRoot; uint64 refBlock; bytes32 refBlockHash; }",
  "struct Anchor { bytes32 root; bytes32 sigHash; bytes32 deviceKeyHash; bytes32 prevRoot; address owner; uint32 deviceKeyVersion; uint64 windowStart; uint32 windowSeconds; uint32 leafCount; uint64 anchoredAt; uint64 blockNumber; uint64 refBlock; uint64 gapBefore; }",
  "struct Verification { bool found; bool included; bytes32 anchorId; Anchor anchor; uint8 deviceStatus; uint64 deviceRevokedAt; bytes32 chainHead; }",
  "function anchor(WindowClaim w, bytes devicePubkey, bytes signature) returns (bytes32)",
  "function registerDevice(bytes32 deviceId, bytes devicePubkey, bytes ownerSignature, bytes deviceSignature)",
  "function revokeDevice(bytes32 deviceId, bytes ownerSignature)",
  "function getDevice(address owner, bytes32 deviceId) view returns (Device)",
  "function chainHead(address owner, bytes32 deviceId) view returns (bytes32)",
  "function nextWindowStart(address owner, bytes32 deviceId) view returns (uint64)",
  "function nonces(address owner) view returns (uint256)",
  "function signingMessage(address owner, WindowClaim w) view returns (bytes)",
  "function registerMessage(address owner, bytes32 deviceId, bytes32 keyHash, uint256 nonce) view returns (bytes)",
  "function revokeMessage(address owner, bytes32 deviceId, uint256 nonce) view returns (bytes)",
  "function verifyAnchor(address owner, bytes32 deviceId, uint64 windowStart, bytes32 segmentLink, uint256 index, bytes32[] proof) view returns (Verification)",
  "event Anchored(bytes32 indexed anchorId, address indexed owner, bytes32 indexed deviceId, uint64 windowStart, uint32 windowSeconds, uint32 leafCount, bytes32 root, bytes32 sigHash)",
  "error NoPqcKey(address account)",
  "error PossessionNotProven(address account)",
  "error BadOwnerSignature()",
  "error BadDeviceSignature()",
  "error BadDeviceKey()",
  "error DeviceExists(bytes32 deviceId)",
  "error DeviceNotActive(bytes32 deviceId)",
  "error DeviceKeyMismatch(bytes32 deviceId)",
  "error EmptyWindow()",
  "error WindowTooLong(uint32 windowSeconds, uint32 maxSeconds)",
  "error WindowInFuture(uint64 windowEnd, uint64 blockTime)",
  "error WindowOverlap(uint64 windowStart, uint64 nextAllowed)",
  "error BadSignature()",
  "error BrokenChain(bytes32 expectedPrevRoot, bytes32 givenPrevRoot)",
  "error BadRefBlock(uint64 refBlock)",
  "error PqcPrecompileInactive()",
]);

export type CheckVerdict = "pass" | "fail" | "not-run";
export interface Check {
  group: "state" | "sanity" | "anchor" | "owner-actions" | "positive-control";
  title: string;
  expected: string;
  got: string;
  verdict: CheckVerdict;
  note?: string;
}

export interface RegistryRun {
  startedAt: string; // ISO
  blockNumber: bigint;
  blockTime: bigint;
  chainId: number;
  registry: string;
  owner: string;
  deviceId?: Hex;
  deviceKeyHash?: Hex;
  chainHead?: Hex;
  nextWindowStart?: bigint;
  window?: { start: bigint; seconds: number; refBlock: bigint };
  replaySource?: { blockNumber: bigint; txHash: Hex };
  checks: Check[];
  observations: string[];
  receiptUrl: string;
}

export interface RegistryConfig {
  registry: string;
  owner: string;
  receiptUrl: string;
  fetchText: (url: string) => Promise<string>;
  now?: () => Date;
  /** How many blocks one getLogs call covers (the public node refuses large ranges). */
  logChunk?: number;
  logChunks?: number;
}

type Addr = `0x${string}`;
const hexToBig = (h: unknown): bigint => BigInt(h as string);

export class ProbeSetupError extends Error {}

/** Decodes the revert data of the registry to "Name(args)". */
export function describeRevert(data: Hex | undefined): { name: string; text: string } {
  if (!data || data === "0x") return { name: "(no data)", text: "revert without data" };
  try {
    const e = decodeErrorResult({ abi: LIVE_ABI, data });
    const args = (e.args ?? []).map((a) => String(a)).join(", ");
    return { name: e.errorName, text: `${e.errorName}(${args})` };
  } catch {
    return { name: "(unknown)", text: `unknown selector ${data.slice(0, 10)}` };
  }
}

export async function runRegistryProbe(rpc: Rpc, cfg: RegistryConfig): Promise<RegistryRun> {
  const now = cfg.now ?? (() => new Date());
  const reg = cfg.registry as Addr;
  const owner = cfg.owner as Addr;
  const checks: Check[] = [];
  const observations: string[] = [];

  const chainId = Number(hexToBig(await rpc.request("eth_chainId", [])));
  if (chainId !== CHAIN_ID) throw new ProbeSetupError(`the RPC serves chain ${chainId}, expected ${CHAIN_ID}`);
  const headNo = hexToBig(await rpc.request("eth_blockNumber", []));
  const head = (await rpc.request("eth_getBlockByNumber", [toHex(headNo), false])) as { hash: Hex; timestamp: Hex };
  const run: RegistryRun = {
    startedAt: now().toISOString(), blockNumber: headNo, blockTime: hexToBig(head.timestamp), chainId, registry: cfg.registry,
    owner: cfg.owner, checks, observations, receiptUrl: cfg.receiptUrl,
  };

  /** Reads one view function. Throws ProbeSetupError when the node reverts or cannot answer. */
  async function view<N extends "chainHead" | "nextWindowStart" | "nonces" | "getDevice">(fn: N, args: unknown[]) {
    const data = encodeFunctionData({ abi: LIVE_ABI, functionName: fn, args } as never);
    const o = await rpc.ethCall(reg, data);
    if (o.kind !== "return") throw new ProbeSetupError(`${fn} failed: ${o.kind} ${"message" in o ? o.message : ""}`);
    return decodeFunctionResult({ abi: LIVE_ABI, functionName: fn, data: o.data } as never) as never;
  }

  // 1. Recent anchors of the owner: device id, current device key, real old signatures.
  const topic0 = toEventSelector(LIVE_ABI.find((x) => x.type === "event" && x.name === "Anchored")!);
  const chunk = cfg.logChunk ?? 4000;
  const logs: { topics: Hex[]; data: Hex; transactionHash: Hex; blockNumber: Hex }[] = [];
  for (let i = 0; i < (cfg.logChunks ?? 4) && logs.length < 3; i++) {
    const to = headNo - BigInt(i * chunk);
    const from = to - BigInt(chunk) + 1n;
    const part = (await rpc.request("eth_getLogs", [
      { address: cfg.registry, topics: [topic0, null, pad(owner, { size: 32 })], fromBlock: toHex(from), toBlock: toHex(to) },
    ])) as typeof logs;
    logs.unshift(...part);
  }
  if (logs.length === 0) throw new ProbeSetupError("no Anchored event of the owner in the last blocks: the live camera may be stopped");
  const decoded = logs.map((l) => ({ l, ev: decodeEventLog({ abi: LIVE_ABI, eventName: "Anchored", data: l.data, topics: l.topics as [Hex, ...Hex[]] }) }));
  const latest = decoded[decoded.length - 1];
  const deviceId = latest.ev.args.deviceId;
  run.deviceId = deviceId;
  const sameDevice = decoded.filter((d) => d.ev.args.deviceId === deviceId);

  async function anchorInput(txHash: Hex, sigHash: Hex) {
    const tx = (await rpc.request("eth_getTransactionByHash", [txHash])) as { input?: Hex } | null;
    if (!tx?.input) throw new ProbeSetupError(`transaction ${txHash} not found`);
    const dec = decodeFunctionData({ abi: LIVE_ABI, data: tx.input });
    if (dec.functionName !== "anchor") throw new ProbeSetupError(`transaction ${txHash} is not a direct anchor call`);
    const [, pk, sig] = dec.args as readonly [unknown, Hex, Hex];
    if (keccak256(sig) !== sigHash) throw new ProbeSetupError(`signature in ${txHash} does not match the sigHash of its event`);
    return { pk, sig };
  }
  const cur = await anchorInput(latest.l.transactionHash, latest.ev.args.sigHash);
  const devicePk = cur.pk;
  const dev = (await view("getDevice", [owner, deviceId])) as { keyHash: Hex; status: number; keyVersion: number };
  run.deviceKeyHash = dev.keyHash;
  const stateOk = dev.status === 1 && keccak256(devicePk) === dev.keyHash;
  checks.push({
    group: "state", title: "device is active and its key (from a recent anchor transaction) is the registered key",
    expected: "status Active, keccak256(key) = registered key hash", got: `status ${dev.status}, key hash ${keccak256(devicePk) === dev.keyHash ? "matches" : "differs"}`,
    verdict: stateOk ? "pass" : "fail",
  });
  if (!stateOk) throw new ProbeSetupError("device is not active or its key changed since the last anchor: cannot build a claim that reaches the signature check");

  // A real older signature of this device (not the latest one, which is the live window).
  const older = sameDevice.length > 1 ? sameDevice[0] : latest;
  const old = older === latest ? cur : await anchorInput(older.l.transactionHash, older.ev.args.sigHash);
  run.replaySource = { blockNumber: hexToBig(older.l.blockNumber), txHash: older.l.transactionHash };

  // 2. Live state and a claim that passes every check except the signature.
  const head2 = (await view("chainHead", [owner, deviceId])) as Hex;
  const nws = (await view("nextWindowStart", [owner, deviceId])) as bigint;
  const nonce = (await view("nonces", [owner])) as bigint;
  const blkNo = hexToBig(await rpc.request("eth_blockNumber", []));
  const refBlock = blkNo - 1n;
  const refB = (await rpc.request("eth_getBlockByNumber", [toHex(refBlock), false])) as { hash: Hex; timestamp: Hex };
  const latestB = (await rpc.request("eth_getBlockByNumber", [toHex(blkNo), false])) as { timestamp: Hex };
  const seconds = Number(hexToBig(latestB.timestamp) - nws);
  const windowSeconds = Math.max(1, Math.min(600, seconds));
  run.chainHead = head2;
  run.nextWindowStart = nws;
  run.window = { start: nws, seconds: windowSeconds, refBlock };
  const claim = {
    deviceId, windowStart: nws, windowSeconds, leafCount: 3,
    root: keccak256(toBytes("qorewitness live probe root")), prevRoot: head2, refBlock, refBlockHash: refB.hash,
  };
  const attacker = mldsa.keygen();
  const msgData = encodeFunctionData({ abi: LIVE_ABI, functionName: "signingMessage", args: [owner, claim] });
  const msgOut = await rpc.ethCall(reg, msgData);
  const localMsg = toBytes(
    encodePacked(
      ["bytes32", "uint256", "address", "address", "bytes32", "uint64", "uint32", "uint32", "bytes32", "bytes32", "uint64", "bytes32"],
      [DOMAIN, BigInt(chainId), reg, owner, deviceId, claim.windowStart, claim.windowSeconds, claim.leafCount, claim.root, claim.prevRoot, claim.refBlock, claim.refBlockHash],
    ),
  );
  const contractMsg = msgOut.kind === "return" ? (decodeFunctionResult({ abi: LIVE_ABI, functionName: "signingMessage", data: msgOut.data }) as Hex) : undefined;
  const msgMatches = contractMsg === toHex(localMsg);
  checks.push({
    group: "sanity", title: "signing message built here equals signingMessage() of the live contract (256 bytes)",
    expected: "equal", got: contractMsg === undefined ? `eth_call ${msgOut.kind}` : msgMatches ? "equal" : "differs",
    verdict: contractMsg === undefined ? "not-run" : msgMatches ? "pass" : "fail",
  });

  const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
  const call = (data: Hex) => rpc.ethCall(reg, data, owner);

  /** Simulates one call and compares the decoded custom error with the expected one. */
  async function expectError(group: Check["group"], title: string, data: Hex, errorName: string, note?: string) {
    const o = await call(data);
    let got: string;
    let verdict: CheckVerdict;
    if (o.kind === "rpc-error") {
      got = `no answer: ${o.message}`;
      verdict = "not-run";
    } else if (o.kind === "return") {
      got = `call SUCCEEDED (return ${o.data.slice(0, 18)})`;
      verdict = "fail";
    } else {
      const d = describeRevert(o.data);
      got = d.text;
      verdict = d.name === errorName ? "pass" : "fail";
    }
    checks.push({ group, title, expected: errorName, got, verdict, note });
    return o;
  }
  const anchorData = (w: typeof claim, pk: Hex, sig: Hex) => encodeFunctionData({ abi: LIVE_ABI, functionName: "anchor", args: [w, pk, sig] });
  const BAD_SIG_NOTE = "All earlier checks passed (window, chain head, reference block, active device, key hash). pqcVerify then refused the signature.";

  const attackerSig = toHex(mldsa.sign(attacker.secretKey, localMsg));
  await expectError("anchor", "anchor: random 4,627-byte signature", anchorData(claim, devicePk, toHex(random(4627))), "BadSignature", BAD_SIG_NOTE);
  await expectError("anchor", "anchor: real old signature of this device, replayed on a new window", anchorData(claim, devicePk, old.sig), "BadSignature", BAD_SIG_NOTE);
  await expectError(
    "anchor", "anchor: valid ML-DSA-87 signature of a fresh attacker key over the exact signing message, device key as registered",
    anchorData(claim, devicePk, attackerSig), "BadSignature", BAD_SIG_NOTE,
  );
  await expectError(
    "anchor", "anchor: same attacker signature with the attacker's own public key",
    anchorData(claim, toHex(attacker.publicKey), attackerSig), "DeviceKeyMismatch", "The key hash check stops it before the signature check.",
  );
  await expectError(
    "anchor", "anchor: correct device key, wrong prevRoot", anchorData({ ...claim, prevRoot: keccak256(toBytes("wrong prevRoot")) }, devicePk, old.sig), "BrokenChain",
    "The chain head check stops it before the signature check.",
  );

  // 3. Owner actions with forged owner signatures.
  const revokeMsg = toBytes(encodePackedRevoke(chainId, reg, owner, deviceId, nonce));
  const revokeOnChain = await rpc.ethCall(reg, encodeFunctionData({ abi: LIVE_ABI, functionName: "revokeMessage", args: [owner, deviceId, nonce] }));
  const revokeEq = revokeOnChain.kind === "return" && decodeFunctionResult({ abi: LIVE_ABI, functionName: "revokeMessage", data: revokeOnChain.data }) === toHex(revokeMsg);
  checks.push({
    group: "sanity", title: "revoke message built here equals revokeMessage() of the live contract", expected: "equal",
    got: revokeOnChain.kind !== "return" ? `eth_call ${revokeOnChain.kind}` : revokeEq ? "equal" : "differs",
    verdict: revokeOnChain.kind !== "return" ? "not-run" : revokeEq ? "pass" : "fail",
  });
  const OWNER_NOTE = "The owner's chain key was found (registered, ML-DSA-87, size ok) and pqcVerify refused the forged signature.";
  await expectError("owner-actions", "revokeDevice from the owner address, random signature", encodeFunctionData({ abi: LIVE_ABI, functionName: "revokeDevice", args: [deviceId, toHex(random(4627))] }), "BadOwnerSignature", OWNER_NOTE);
  await expectError(
    "owner-actions", "revokeDevice from the owner address, valid signature of a fresh attacker key over the exact revoke message",
    encodeFunctionData({ abi: LIVE_ABI, functionName: "revokeDevice", args: [deviceId, toHex(mldsa.sign(attacker.secretKey, revokeMsg))] }), "BadOwnerSignature", OWNER_NOTE,
  );
  const newId = keccak256(toBytes("qorewitness live probe: device that does not exist"));
  const regMsg = toBytes(encodePacked(
    ["bytes32", "uint256", "address", "address", "bytes32", "bytes32", "uint256"],
    [REGISTER_TAG, BigInt(chainId), reg, owner, newId, keccak256(attacker.publicKey), nonce],
  ));
  const attackerPk = toHex(attacker.publicKey);
  await expectError(
    "owner-actions", "registerDevice from the owner address, random owner signature",
    encodeFunctionData({ abi: LIVE_ABI, functionName: "registerDevice", args: [newId, attackerPk, toHex(random(4627)), toHex(mldsa.sign(attacker.secretKey, regMsg))] }),
    "BadOwnerSignature", OWNER_NOTE,
  );
  await expectError(
    "owner-actions", "registerDevice from the owner address, valid attacker signature as owner signature",
    encodeFunctionData({ abi: LIVE_ABI, functionName: "registerDevice", args: [newId, attackerPk, toHex(mldsa.sign(attacker.secretKey, regMsg)), toHex(mldsa.sign(attacker.secretKey, regMsg))] }),
    "BadOwnerSignature", OWNER_NOTE,
  );

  // 4. Positive control without a private key: the public sample receipt.
  await sampleReceiptChecks(rpc, cfg, checks);

  // 5. What eth_call does when the request has a state override.
  try {
    const kp = mldsa.keygen();
    const m = random(32);
    const data = encodeFunctionData({
      abi: parseAbi(["function pqcVerify(bytes,bytes,bytes) view returns (bool)"]), functionName: "pqcVerify",
      args: [toHex(kp.publicKey), toHex(mldsa.sign(kp.secretKey, m)), toHex(m)],
    });
    const plain = await rpc.ethCall("0x0000000000000000000000000000000000000a01", data);
    const withOverride = await rpc.request("eth_call", [{ to: "0x0000000000000000000000000000000000000a01", data }, "latest", {}]);
    observations.push(
      `pqcVerify of a valid signature: plain eth_call returns ${plain.kind === "return" ? plain.data.slice(-1) === "1" ? "true" : plain.data : plain.kind}, ` +
        `eth_call with an empty state override object returns ${JSON.stringify(withOverride)}. ` +
        "So the node does not run the PQC precompile when a state override is present, and a simulation with overrides cannot be used as a positive control. These probes never use overrides.",
    );
  } catch (err) {
    observations.push(`state override observation not made: ${(err as Error).message}`);
  }
  return run;
}

function encodePackedRevoke(chainId: number, reg: Addr, owner: Addr, deviceId: Hex, nonce: bigint): Hex {
  return encodePacked(["bytes32", "uint256", "address", "address", "bytes32", "uint256"], [REVOKE_TAG, BigInt(chainId), reg, owner, deviceId, nonce]);
}

interface SampleReceipt {
  owner: Addr;
  deviceId: Hex;
  windowStart: string;
  segments: { link: Hex; index: number; proof: Hex[] }[];
}

async function sampleReceiptChecks(rpc: Rpc, cfg: RegistryConfig, checks: Check[]): Promise<void> {
  let r: SampleReceipt;
  try {
    r = JSON.parse(await cfg.fetchText(cfg.receiptUrl)) as SampleReceipt;
    if (!r.segments?.[0]?.link) throw new Error("no segment in the receipt");
  } catch (err) {
    for (const t of ["verifyAnchor of the public sample receipt: segment is found and included", "verifyAnchor with one flipped bit in the segment link: not included"]) {
      checks.push({ group: "positive-control", title: t, expected: "-", got: `sample receipt not readable: ${(err as Error).message}`, verdict: "not-run" });
    }
    return;
  }
  const seg = r.segments[0];
  const ask = async (link: Hex) => {
    const o = await rpc.ethCall(cfg.registry, encodeFunctionData({
      abi: LIVE_ABI, functionName: "verifyAnchor", args: [r.owner, r.deviceId, BigInt(r.windowStart), link, BigInt(seg.index), seg.proof],
    }));
    if (o.kind !== "return") return { err: o.kind === "revert" ? "revert" : o.message };
    return { v: decodeFunctionResult({ abi: LIVE_ABI, functionName: "verifyAnchor", data: o.data }) as { found: boolean; included: boolean } };
  };
  const good = await ask(seg.link);
  checks.push({
    group: "positive-control", title: "verifyAnchor of the public sample receipt: segment is found and included", expected: "found=true, included=true",
    got: "v" in good && good.v ? `found=${good.v.found}, included=${good.v.included}` : `no answer: ${good.err}`,
    verdict: !("v" in good) || !good.v ? "not-run" : good.v.found && good.v.included ? "pass" : "fail",
    note: "Control for the tamper check below: the same call with the real link is accepted.",
  });
  const flipped = toHex(flipBit(toBytes(seg.link), 0));
  const bad = await ask(flipped);
  checks.push({
    group: "positive-control", title: "verifyAnchor with one flipped bit in the segment link: not included", expected: "found=true, included=false",
    got: "v" in bad && bad.v ? `found=${bad.v.found}, included=${bad.v.included}` : `no answer: ${bad.err}`,
    verdict: !("v" in bad) || !bad.v ? "not-run" : bad.v.found && !bad.v.included ? "pass" : "fail",
  });
}

export function registryExitCode(run: RegistryRun): number {
  if (run.checks.some((c) => c.verdict === "fail")) return 3;
  if (run.checks.some((c) => c.verdict === "not-run")) return 4;
  return 0;
}
