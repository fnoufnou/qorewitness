/**
 * Live negative simulations against the deployed AnchorRegistry (eth_call only).
 *
 * eth_call needs no signature, so `from` can be the real owner address. The node runs the
 * real contract and the real pqcVerify / pqcKeyStatus precompiles and returns the revert
 * data. Nothing is sent, nothing is signed with the owner key, no funds are needed.
 *
 * Every call and state read of one run uses one block number (two blocks below the head read
 * at the start). A camera anchor that lands during the run does not change what the probe sees.
 *
 * Gating positive controls run first. A direct pqcVerify call with a fresh valid signature must
 * return true. The newest real anchor of the live camera is replayed with eth_call: its device
 * key, its signature and the message that the live contract builds must give true, and one
 * flipped bit in the signature or the message must give false. If a control does not hold, the
 * run stops before the negative simulations and exits with code 2.
 *
 * What a custom error means: anchor() checks the window, the chain head, the reference block
 * and the device key before it calls the precompile. BadSignature() means that the precompile
 * did not accept the signature: it returned false or the call failed (QorePqc.verify returns
 * false for both). An inactive precompile gives PqcPrecompileInactive. Together with the gating
 * controls of the same run, a dead precompile cannot produce a passing run.
 */
import {
  decodeErrorResult, decodeEventLog, decodeFunctionData, decodeFunctionResult, encodeFunctionData, encodePacked, keccak256,
  pad, parseAbi, toBytes, toEventSelector, toHex, type Hex,
} from "viem";
import { mldsa } from "@qorechain/pqc";
import { DOMAIN, REGISTER_TAG, REVOKE_TAG } from "../core/message.js";
import { observe } from "./fuzz.js";
import { flipBit } from "./mutate.js";
import { BlockUnavailableError, RpcDownError, type CallOutcome, type Rpc } from "./rpc.js";

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
  "function getAnchor(bytes32 anchorId) view returns (Anchor)",
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
  "error UnknownAnchor(bytes32 anchorId)",
]);

export const PQC_VERIFY_ADDRESS = "0x0000000000000000000000000000000000000a01" as const;
const PQC_ABI = parseAbi(["function pqcVerify(bytes pubkey, bytes signature, bytes message) view returns (bool)"]);

/** The run is pinned this many blocks below the head, so a node that lags one block still has it. */
export const PIN_LAG = 2n;

/** Exit codes of probe:registry (documented in docs/LIVE_PROBES.md). */
export const REGISTRY_EXIT = {
  ok: 0,
  setup: 1, // the live state could not be used (camera stopped, device not active, bad arguments)
  control: 2, // a gating positive control did not hold, the negative simulations did not run
  accepted: 3, // a forged or replayed input was accepted
  notRun: 4, // a check could not run (revert without data, sample receipt not readable)
  rpcDown: 5, // the RPC did not answer, or did not have the pinned block twice
  unexpected: 6, // a check gave another answer than expected
} as const;

export type CheckVerdict = "pass" | "fail" | "not-run";
export interface Check {
  group: "state" | "control" | "sanity" | "anchor" | "owner-actions" | "receipt";
  /** control: a gating positive control. negative: an input that must be refused. check: anything else. */
  role: "control" | "negative" | "check";
  title: string;
  expected: string;
  got: string;
  verdict: CheckVerdict;
  /** A negative input that was accepted: the simulated call succeeded or pqcVerify returned true. */
  accepted?: boolean;
  note?: string;
}

export type OverrideOutcome = "empty" | "true" | "other" | "error" | "not-made";

export interface RegistryRun {
  startedAt: string; // ISO
  headAtStart: bigint;
  blockNumber: bigint; // the pinned block of every call
  blockTime: bigint;
  retriedAtFreshBlock: boolean;
  chainId: number;
  registry: string;
  owner: string;
  deviceId?: Hex;
  deviceKeyHash?: Hex;
  chainHead?: Hex;
  nextWindowStart?: bigint;
  window?: { start: bigint; seconds: number; refBlock: bigint };
  realAnchor?: { blockNumber: bigint; txHash: Hex; anchorId: Hex; windowStart: bigint };
  replaySource?: { blockNumber: bigint; txHash: Hex };
  /** True when a gating positive control did not hold. The negative simulations were then not run. */
  aborted: boolean;
  checks: Check[];
  observations: string[];
  overrideOutcome: OverrideOutcome;
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

/** The window message as the contract builds it (abi.encodePacked, 256 bytes), built here without the contract. */
export function localWindowMessage(
  chainId: number, registry: Addr, owner: Addr,
  w: { deviceId: Hex; windowStart: bigint; windowSeconds: number; leafCount: number; root: Hex; prevRoot: Hex; refBlock: bigint; refBlockHash: Hex },
): Uint8Array {
  return toBytes(
    encodePacked(
      ["bytes32", "uint256", "address", "address", "bytes32", "uint64", "uint32", "uint32", "bytes32", "bytes32", "uint64", "bytes32"],
      [DOMAIN, BigInt(chainId), registry, owner, w.deviceId, w.windowStart, w.windowSeconds, w.leafCount, w.root, w.prevRoot, w.refBlock, w.refBlockHash],
    ),
  );
}

/**
 * Runs the probe at one pinned block. When the node says it does not have that block, the run
 * starts once more at a fresh block. A second miss ends as BlockUnavailableError (RPC down).
 */
export async function runRegistryProbe(rpc: Rpc, cfg: RegistryConfig): Promise<RegistryRun> {
  const chainId = Number(hexToBig(await rpc.request("eth_chainId", [])));
  if (chainId !== CHAIN_ID) throw new ProbeSetupError(`the RPC serves chain ${chainId}, expected ${CHAIN_ID}`);
  try {
    return await runAt(rpc, cfg, chainId, false);
  } catch (err) {
    if (!(err instanceof BlockUnavailableError)) throw err;
    return await runAt(rpc, cfg, chainId, true);
  }
}

async function runAt(rpc: Rpc, cfg: RegistryConfig, chainId: number, retried: boolean): Promise<RegistryRun> {
  const now = cfg.now ?? (() => new Date());
  const reg = cfg.registry as Addr;
  const owner = cfg.owner as Addr;
  const checks: Check[] = [];
  const observations: string[] = [];

  const headNo = hexToBig(await rpc.request("eth_blockNumber", []));
  const pinned = headNo - PIN_LAG;
  const tag = toHex(pinned);
  const pinnedBlock = (await rpc.request("eth_getBlockByNumber", [tag, false])) as { hash: Hex; timestamp: Hex } | null;
  if (!pinnedBlock) throw new BlockUnavailableError(`eth_getBlockByNumber ${tag} returned null`);
  const run: RegistryRun = {
    startedAt: now().toISOString(), headAtStart: headNo, blockNumber: pinned, blockTime: hexToBig(pinnedBlock.timestamp),
    retriedAtFreshBlock: retried, chainId, registry: cfg.registry, owner: cfg.owner, aborted: false, checks, observations,
    overrideOutcome: "not-made", receiptUrl: cfg.receiptUrl,
  };

  /** eth_call at the pinned block. A return or a revert is an answer. Anything else ends the run as RPC down. */
  async function callAt(to: string, data: Hex, from?: string): Promise<Exclude<CallOutcome, { kind: "rpc-error" }>> {
    const o = await rpc.ethCall(to, data, from, tag);
    if (o.kind !== "rpc-error") return o;
    if (o.blockUnavailable) throw new BlockUnavailableError(`eth_call at ${tag}: ${o.message}`);
    throw new RpcDownError(rpc.url, `eth_call at ${tag}: ${o.message}`);
  }

  type ViewFn = "chainHead" | "nextWindowStart" | "nonces" | "getDevice" | "getAnchor" | "signingMessage" | "revokeMessage";
  /** Reads one view function at the pinned block. A revert here means the live state is not usable. */
  async function view(fn: ViewFn, args: unknown[]): Promise<unknown> {
    const data = encodeFunctionData({ abi: LIVE_ABI, functionName: fn, args } as never);
    const o = await callAt(reg, data);
    if (o.kind !== "return") throw new ProbeSetupError(`${fn} reverted: ${describeRevert(o.data).text}`);
    return decodeFunctionResult({ abi: LIVE_ABI, functionName: fn, data: o.data } as never);
  }

  /** One direct call of the pqcVerify precompile at the pinned block. */
  async function pqc(pk: Hex | Uint8Array, sig: Hex | Uint8Array, msg: Hex | Uint8Array) {
    const h = (x: Hex | Uint8Array): Hex => (typeof x === "string" ? x : toHex(x));
    const data = encodeFunctionData({ abi: PQC_ABI, functionName: "pqcVerify", args: [h(pk), h(sig), h(msg)] });
    return observe(await callAt(PQC_VERIFY_ADDRESS, data));
  }

  // 1. Recent anchors of the owner, up to the pinned block: device id, current device key, real signatures.
  const topic0 = toEventSelector(LIVE_ABI.find((x) => x.type === "event" && x.name === "Anchored")!);
  const chunk = cfg.logChunk ?? 4000;
  const logs: { topics: Hex[]; data: Hex; transactionHash: Hex; blockNumber: Hex }[] = [];
  for (let i = 0; i < (cfg.logChunks ?? 4) && logs.length < 3; i++) {
    const to = pinned - BigInt(i * chunk);
    if (to < 0n) break;
    const from = to - BigInt(chunk) + 1n < 0n ? 0n : to - BigInt(chunk) + 1n;
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

  type Claim = { deviceId: Hex; windowStart: bigint; windowSeconds: number; leafCount: number; root: Hex; prevRoot: Hex; refBlock: bigint; refBlockHash: Hex };
  async function anchorInput(txHash: Hex): Promise<{ w: Claim; pk: Hex; sig: Hex }> {
    const tx = (await rpc.request("eth_getTransactionByHash", [txHash])) as { input?: Hex } | null;
    if (!tx?.input) throw new ProbeSetupError(`transaction ${txHash} not found`);
    const dec = decodeFunctionData({ abi: LIVE_ABI, data: tx.input });
    if (dec.functionName !== "anchor") throw new ProbeSetupError(`transaction ${txHash} is not a direct anchor call`);
    const [w, pk, sig] = dec.args as readonly [Claim, Hex, Hex];
    return { w, pk, sig };
  }
  const cur = await anchorInput(latest.l.transactionHash);
  const devicePk = cur.pk;
  const dev = (await view("getDevice", [owner, deviceId])) as { keyHash: Hex; status: number; keyVersion: number };
  run.deviceKeyHash = dev.keyHash;
  const stateOk = dev.status === 1 && keccak256(devicePk) === dev.keyHash;
  checks.push({
    group: "state", role: "check", title: "device is active and its key (from the newest anchor transaction) is the registered key",
    expected: "status Active, keccak256(key) = registered key hash", got: `status ${dev.status}, key hash ${keccak256(devicePk) === dev.keyHash ? "matches" : "differs"}`,
    verdict: stateOk ? "pass" : "fail",
  });
  if (!stateOk) throw new ProbeSetupError("device is not active or its key changed since the last anchor: cannot build a claim that reaches the signature check");

  // 2. Gating positive controls.
  const control = (title: string, expected: string, got: string, ok: boolean, note?: string) =>
    checks.push({ group: "control", role: "control", title, expected, got, verdict: ok ? "pass" : "fail", note });
  const kp = mldsa.keygen();
  const freshMsg = crypto.getRandomValues(new Uint8Array(32));
  const direct = await pqc(kp.publicKey, mldsa.sign(kp.secretKey, freshMsg), freshMsg);
  control("pqcVerify called directly: fresh ML-DSA-87 key, valid signature", "true", direct.observed + (direct.detail ? ` (${direct.detail})` : ""), direct.observed === "true");

  const anchorId = latest.l.topics[1] as Hex;
  run.realAnchor = { blockNumber: hexToBig(latest.l.blockNumber), txHash: latest.l.transactionHash, anchorId, windowStart: cur.w.windowStart };
  const liveMsg = (await view("signingMessage", [owner, cur.w])) as Hex;
  const localMsg = toHex(localWindowMessage(chainId, reg, owner, cur.w));
  control(
    "newest real anchor: signingMessage(owner, claim) of the live contract equals the message built here", "equal",
    liveMsg === localMsg ? `equal (${(liveMsg.length - 2) / 2} bytes)` : "differs", liveMsg === localMsg,
  );
  const REPLAY_NOTE = "Replay with eth_call of a verification the chain already did when it included the newest anchor transaction. No private key is used.";
  const real = await pqc(devicePk, cur.sig, liveMsg);
  control(
    "newest real anchor: pqcVerify(device key, its signature, message from the live contract)", "true",
    real.observed + (real.detail ? ` (${real.detail})` : ""), real.observed === "true", REPLAY_NOTE,
  );
  // One flipped bit in the signature (byte 100, inside z) and one in the message (byte 40, inside the chain id field).
  checks.push(negativeOf("control", "newest real anchor: the same call with one flipped bit in the signature", await pqc(devicePk, flipBit(toBytes(cur.sig), 8 * 100 + 3), liveMsg)));
  checks.push(negativeOf("control", "newest real anchor: the same call with one flipped bit in the message", await pqc(devicePk, cur.sig, flipBit(toBytes(liveMsg), 8 * 40 + 5))));
  const stored = (await view("getAnchor", [anchorId])) as { sigHash: Hex; deviceKeyHash: Hex; root: Hex };
  const sigHash = keccak256(cur.sig);
  control(
    "newest real anchor: keccak256(signature) equals sigHash in the Anchored event and in getAnchor(anchorId)", "all equal",
    `event ${sigHash === latest.ev.args.sigHash ? "equal" : "differs"}, getAnchor ${sigHash === stored.sigHash ? "equal" : "differs"}`,
    sigHash === latest.ev.args.sigHash && sigHash === stored.sigHash,
  );
  control(
    "newest real anchor: keccak256(device key) equals the stored deviceKeyHash of the anchor", "equal",
    keccak256(devicePk) === stored.deviceKeyHash ? "equal" : "differs", keccak256(devicePk) === stored.deviceKeyHash,
  );
  if (checks.some((c) => c.role === "control" && c.verdict !== "pass")) {
    run.aborted = true;
    await overrideObservation();
    return run;
  }

  // A real older signature of this device (not the newest one).
  const older = sameDevice.length > 1 ? sameDevice[0] : latest;
  const old = older === latest ? cur : await anchorInput(older.l.transactionHash);
  run.replaySource = { blockNumber: hexToBig(older.l.blockNumber), txHash: older.l.transactionHash };

  // 3. Live state and a claim that passes every check except the signature.
  const head2 = (await view("chainHead", [owner, deviceId])) as Hex;
  const nws = (await view("nextWindowStart", [owner, deviceId])) as bigint;
  const nonce = (await view("nonces", [owner])) as bigint;
  const refBlock = pinned - 1n;
  const refB = (await rpc.request("eth_getBlockByNumber", [toHex(refBlock), false])) as { hash: Hex } | null;
  if (!refB) throw new BlockUnavailableError(`eth_getBlockByNumber ${toHex(refBlock)} returned null`);
  const seconds = Number(run.blockTime - nws);
  const windowSeconds = Math.max(1, Math.min(600, seconds));
  run.chainHead = head2;
  run.nextWindowStart = nws;
  run.window = { start: nws, seconds: windowSeconds, refBlock };
  const claim: Claim = {
    deviceId, windowStart: nws, windowSeconds, leafCount: 3,
    root: keccak256(toBytes("qorewitness live probe root")), prevRoot: head2, refBlock, refBlockHash: refB.hash,
  };
  const attacker = mldsa.keygen();
  const claimMsg = localWindowMessage(chainId, reg, owner, claim);
  const msgOut = await callAt(reg, encodeFunctionData({ abi: LIVE_ABI, functionName: "signingMessage", args: [owner, claim] }));
  sanity("signing message built here equals signingMessage() of the live contract (256 bytes)", msgOut, "signingMessage", toHex(claimMsg));

  const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

  /** Simulates one call that must fail and compares the decoded custom error with the expected one. */
  async function expectError(group: Check["group"], title: string, data: Hex, errorName: string, note?: string) {
    const o = await callAt(reg, data, owner);
    let got: string;
    let verdict: CheckVerdict;
    let accepted = false;
    if (o.kind === "return") {
      got = `call SUCCEEDED (return ${o.data.slice(0, 18)})`;
      verdict = "fail";
      accepted = true;
    } else {
      const d = describeRevert(o.data);
      got = d.text;
      verdict = d.name === "(no data)" ? "not-run" : d.name === errorName ? "pass" : "fail";
    }
    checks.push({ group, role: "negative", title, expected: errorName, got, verdict, note, ...(accepted ? { accepted } : {}) });
  }
  const anchorData = (w: Claim, pk: Hex, sig: Hex) => encodeFunctionData({ abi: LIVE_ABI, functionName: "anchor", args: [w, pk, sig] });
  const BAD_SIG_NOTE = "All earlier checks passed (window, chain head, reference block, active device, key hash). The precompile then did not accept the signature: it returned false or the call failed. The gating controls above show that the same precompile accepts the real camera signature in this run.";

  const attackerSig = toHex(mldsa.sign(attacker.secretKey, claimMsg));
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

  // 4. Owner actions with forged owner signatures.
  const revokeMsg = toBytes(encodePackedRevoke(chainId, reg, owner, deviceId, nonce));
  const revokeOut = await callAt(reg, encodeFunctionData({ abi: LIVE_ABI, functionName: "revokeMessage", args: [owner, deviceId, nonce] }));
  sanity("revoke message built here equals revokeMessage() of the live contract", revokeOut, "revokeMessage", toHex(revokeMsg));
  const OWNER_NOTE = "The owner's chain key was found (registered, ML-DSA-87, size ok, possession proven) and the precompile did not accept the forged signature (it returned false or the call failed).";
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

  // 5. The public sample receipt (no private key needed).
  await sampleReceiptChecks(callAt, cfg, checks);

  // 6. What eth_call does when the request has a state override. Never changes the exit code.
  await overrideObservation();
  return run;

  /** Compares a message view of the live contract with the bytes built here. */
  function sanity(title: string, o: Exclude<CallOutcome, { kind: "rpc-error" }>, fn: "signingMessage" | "revokeMessage", expectedHex: Hex) {
    if (o.kind !== "return") {
      const d = describeRevert(o.data);
      checks.push({ group: "sanity", role: "check", title, expected: "equal", got: `eth_call reverted: ${d.text}`, verdict: d.name === "(no data)" ? "not-run" : "fail" });
      return;
    }
    const eq = decodeFunctionResult({ abi: LIVE_ABI, functionName: fn, data: o.data }) === expectedHex;
    checks.push({ group: "sanity", role: "check", title, expected: "equal", got: eq ? "equal" : "differs", verdict: eq ? "pass" : "fail" });
  }

  async function overrideObservation(): Promise<void> {
    const okp = mldsa.keygen();
    const m = crypto.getRandomValues(new Uint8Array(32));
    const data = encodeFunctionData({ abi: PQC_ABI, functionName: "pqcVerify", args: [toHex(okp.publicKey), toHex(mldsa.sign(okp.secretKey, m)), toHex(m)] });
    let seen: string;
    try {
      const r = await rpc.request("eth_call", [{ to: PQC_VERIFY_ADDRESS, data }, tag, {}]);
      const o = typeof r === "string" && /^0x[0-9a-f]*$/i.test(r) ? observe({ kind: "return", data: r as Hex }) : undefined;
      if (r === "0x") {
        run.overrideOutcome = "empty";
        seen = "it returned empty data: with a state override the node answered without the PQC precompile";
      } else if (o?.observed === "true") {
        run.overrideOutcome = "true";
        seen = "it returned true: the node now runs the precompile with overrides";
      } else {
        run.overrideOutcome = "other";
        seen = `it returned ${JSON.stringify(r).slice(0, 80)}`;
      }
    } catch (err) {
      run.overrideOutcome = "error";
      seen = `it got no answer (${(err as Error).message.split("\n")[0]})`;
    }
    observations.push(
      "The probe makes exactly one call with an empty state override, on purpose, to record how the node behaves. " +
        `It called pqcVerify with a fresh valid signature and an empty override object, and ${seen}. ` +
        "This observation does not change the exit code. Every other call of the run has no override.",
    );
  }
}

/** A negative pqcVerify call: false or a revert is a pass, true is an accepted forgery, empty or odd data is not run. */
function negativeOf(group: Check["group"], title: string, r: ReturnType<typeof observe>): Check {
  const got = r.observed + (r.detail ? ` (${r.detail})` : "");
  if (r.observed === "true") return { group, role: "negative", title, expected: "false", got, verdict: "fail", accepted: true };
  if (r.observed === "false" || r.observed === "revert") return { group, role: "negative", title, expected: "false", got, verdict: "pass" };
  return { group, role: "negative", title, expected: "false", got, verdict: "not-run" };
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

type CallAt = (to: string, data: Hex, from?: string) => Promise<Exclude<CallOutcome, { kind: "rpc-error" }>>;

async function sampleReceiptChecks(callAt: CallAt, cfg: RegistryConfig, checks: Check[]): Promise<void> {
  let r: SampleReceipt;
  try {
    r = JSON.parse(await cfg.fetchText(cfg.receiptUrl)) as SampleReceipt;
    if (!r.segments?.[0]?.link) throw new Error("no segment in the receipt");
  } catch (err) {
    for (const t of ["verifyAnchor of the public sample receipt: segment is found and included", "verifyAnchor with one flipped bit in the segment link: not included"]) {
      checks.push({ group: "receipt", role: "check", title: t, expected: "-", got: `sample receipt not readable: ${(err as Error).message}`, verdict: "not-run" });
    }
    return;
  }
  const seg = r.segments[0];
  const ask = async (link: Hex) => {
    const o = await callAt(cfg.registry, encodeFunctionData({
      abi: LIVE_ABI, functionName: "verifyAnchor", args: [r.owner, r.deviceId, BigInt(r.windowStart), link, BigInt(seg.index), seg.proof],
    }));
    if (o.kind !== "return") return { err: `revert: ${describeRevert(o.data).text}` };
    return { v: decodeFunctionResult({ abi: LIVE_ABI, functionName: "verifyAnchor", data: o.data }) as { found: boolean; included: boolean } };
  };
  const good = await ask(seg.link);
  checks.push({
    group: "receipt", role: "check", title: "verifyAnchor of the public sample receipt: segment is found and included", expected: "found=true, included=true",
    got: "v" in good && good.v ? `found=${good.v.found}, included=${good.v.included}` : `no answer: ${good.err}`,
    verdict: !("v" in good) || !good.v ? "not-run" : good.v.found && good.v.included ? "pass" : "fail",
    note: "Control for the tamper check below: the same call with the real link is accepted.",
  });
  const flipped = toHex(flipBit(toBytes(seg.link), 0));
  const bad = await ask(flipped);
  checks.push({
    group: "receipt", role: "check", title: "verifyAnchor with one flipped bit in the segment link: not included", expected: "found=true, included=false",
    got: "v" in bad && bad.v ? `found=${bad.v.found}, included=${bad.v.included}` : `no answer: ${bad.err}`,
    verdict: !("v" in bad) || !bad.v ? "not-run" : bad.v.found && !bad.v.included ? "pass" : "fail",
  });
}

/** 2 a gating control did not hold, 3 a forged input was accepted, 6 another unexpected answer, 4 a check did not run, 0 all good. */
export function registryExitCode(run: Pick<RegistryRun, "aborted" | "checks">): number {
  if (run.aborted || run.checks.some((c) => c.role === "control" && c.verdict !== "pass")) return REGISTRY_EXIT.control;
  if (run.checks.some((c) => c.accepted)) return REGISTRY_EXIT.accepted;
  if (run.checks.some((c) => c.verdict === "fail")) return REGISTRY_EXIT.unexpected;
  if (run.checks.some((c) => c.verdict === "not-run")) return REGISTRY_EXIT.notRun;
  return REGISTRY_EXIT.ok;
}
