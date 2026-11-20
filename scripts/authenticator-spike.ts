/**
 * authenticator-spike.ts - T31 spike: anchor with the owner key offline (testnet only).
 *
 * Roles (docs/AGENT_KEY.md):
 *   owner    the test camera owner (QORE_MNEMONIC). Signs only to link and revoke the agent key.
 *   agent    a fresh secp256k1 key, linked by its 20-byte address. Signs each anchor call.
 *   relayer  a funded hybrid account (RELAYER_MNEMONIC). Wraps the call in MsgExecuteEVM and pays.
 *
 * Steps, each printed with PASS or FAIL:
 *   1. Link the agent key with permission "evm" and a spending rule that allows only
 *      anchor() on the registry and bounds value to 1 base unit.
 *   2. Close the owner's EVM window, so the test shows that no window is needed.
 *   3. Anchor one window through MsgExecuteEVM. The record must show the owner as owner.
 *   4. The agent key calls another contract: must fail.
 *   5. The agent key sends value: must fail.
 *   6. Revoke the agent key. The next anchor must fail.
 *
 * Env: QORE_MNEMONIC (test owner), RELAYER_MNEMONIC, QORE_REGISTRY (v4), QW_DEVICE_KEY,
 *      QW_DEVICE (default custody-test), QW_AGENT_KEY_FILE (default ./agent-spike.key).
 * Usage: pnpm tsx --env-file=<env> scripts/authenticator-spike.ts
 */
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner, buildMetaMaskExecuteEvm, closeEvmWindowMsg, deriveUnifiedAccount, fetchAuthNonce,
  linkAuthenticatorMsgs, resolveEvmAuthDigestVersion, revokeAuthenticatorMsg, signAuthenticatorLinkEip191,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { evmWindowStatus } from "@qorechain/evm";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hexToBytes, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AnchorClient, REGISTRY_ABI } from "../src/agent/anchor-client.js";
import { loadDeviceKey } from "../src/agent/device-key.js";
import { hashFile } from "../src/agent/hash-file.js";
import { probeSegment } from "../src/agent/source.js";
import { linkWindow, type Segment, type Window } from "../src/agent/window.js";
import { deviceIdOf } from "../src/core/message.js";

const CHAIN_ID = "qorechain-diana";
const REST = "https://api-testnet.qore.host";
const RPC = "https://rpc-testnet.qore.host";
const OWNER_FEE = { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" };
const RELAY_GAS = 1_500_000n;
const RELAY_FEE = { amount: [{ denom: "uqor", amount: String(RELAY_GAS / 10n) }], gas: String(RELAY_GAS) };
const CALL_GAS = 900_000n;
const ANCHOR_SELECTOR = "0xb813aa2a";

const env = (k: string, d?: string) => {
  const v = process.env[k]?.trim() || d;
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
const registry = env("QORE_REGISTRY") as Address;
const label = env("QW_DEVICE", "custody-test");
const client = await AnchorClient.create(env("QORE_MNEMONIC"), registry);
const owner = client.account;
const relayer = await deriveUnifiedAccount(env("RELAYER_MNEMONIC"), 0);
const deviceKey = loadDeviceKey(env("QW_DEVICE_KEY"));
const deviceId = deviceIdOf(label);

// Agent key: created once, kept in a mode-600 file. Testnet only.
const agentFile = env("QW_AGENT_KEY_FILE", "agent-spike.key");
if (!existsSync(agentFile)) writeFileSync(agentFile, generatePrivateKey(), { mode: 0o600 });
const agentPriv = readFileSync(agentFile, "utf8").trim() as Hex;
const agent = privateKeyToAccount(agentPriv);
const agentPub = hexToBytes(agent.address); // linked by its 20-byte address (EIP-191 scheme)

/** EIP-1193 shape for the SDK's MetaMask builder, backed by the local agent key. */
const provider = {
  async request(args: { method: string; params: unknown[] }): Promise<string> {
    if (args.method !== "personal_sign") throw new Error(`unsupported method ${args.method}`);
    const [data] = args.params as [string];
    const raw = typeof data === "string" && data.startsWith("0x") ? (data as Hex) : toHex(new TextEncoder().encode(String(data)));
    return agent.signMessage({ message: { raw } });
  },
};

const results: { step: string; ok: boolean; note: string }[] = [];
const report = (step: string, ok: boolean, note: string) => {
  results.push({ step, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}: ${note}`);
};

async function accountSequence(address: string) {
  const res = await fetch(`${REST}/cosmos/auth/v1beta1/accounts/${address}`);
  const body = (await res.json()) as { account?: Record<string, unknown> };
  const acc = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
  return { accountNumber: BigInt(acc.account_number ?? "0"), sequence: BigInt(acc.sequence ?? "0") };
}

/** Hybrid-signed tx from `from`, then the delivered result from REST (events included). */
async function sendHybrid(from: UnifiedAccount, messages: Parameters<EthNativeSigner["signAndBroadcast"]>[1]["messages"], fee = OWNER_FEE) {
  const transport = await StargateClient.connect(RPC);
  try {
    const signer = new EthNativeSigner(from, { signMode: "hybrid", rest: REST });
    const r = await signer.signAndBroadcast(transport, { chainId: CHAIN_ID, ...(await accountSequence(from.cosmos)), fee, messages });
    if (r.code !== 0) return { hash: r.transactionHash, code: r.code, log: r.rawLog ?? "", failed: [] as string[] };
    for (let i = 0; i < 30; i++) {
      await new Promise((ok) => setTimeout(ok, 2000));
      const res = await fetch(`${REST}/cosmos/tx/v1beta1/txs/${r.transactionHash}`);
      if (!res.ok) continue;
      const tx = (await res.json()) as { tx_response: { code: number; raw_log: string; events: { type: string; attributes: { key: string; value: string }[] }[] } };
      const failed = tx.tx_response.events
        .filter((e) => e.type === "abstractaccount_execution_failed")
        .map((e) => e.attributes.map((a) => `${a.key}=${a.value}`).join(" "));
      return { hash: r.transactionHash, code: tx.tx_response.code, log: tx.tx_response.raw_log, failed };
    }
    return { hash: r.transactionHash, code: -1, log: "not found after 60 s", failed: [] as string[] };
  } finally {
    transport.disconnect();
  }
}

/** One MsgExecuteEVM from the relayer, signed by the agent key. */
async function execute(to: Address, data: Hex, value = "0") {
  const nonce = (await fetchAuthNonce({ rest: REST, address: owner.cosmos, pubkey: agentPub })).nonce;
  const digestVersion = await resolveEvmAuthDigestVersion({ rest: REST });
  const msg = await buildMetaMaskExecuteEvm({
    provider, address: agent.address, relayer: relayer.cosmos, chainId: CHAIN_ID, account: owner.cosmos,
    to, value, data: hexToBytes(data), gasLimit: CALL_GAS, nonce, digestVersion,
  });
  return sendHybrid(relayer, [msg], RELAY_FEE);
}

/** A window of two short test clips, linked and ready to sign. */
async function testWindow(dir: string): Promise<Window> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const start = Math.floor(Date.now() / 1000) - 60;
  const segments: Segment[] = [];
  for (let i = 0; i < 2; i++) {
    const t = new Date((start + i * 10) * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const f = join(dir, `seg_${t}.mp4`);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=10,hue=h=${i * 120}`, "-t", "5", "-c:v", "libx264", "-pix_fmt", "yuv420p", f]);
    const completedAt = Math.floor(statSync(f).mtimeMs / 1000);
    const h = await hashFile(f);
    segments.push({ path: f, sha256: h.sha256, sha3: h.sha3, size: statSync(f).size, completedAt, ...(await probeSegment(f, completedAt)) });
  }
  const w: Window = { windowStart: BigInt(start), windowSeconds: 60, segments };
  linkWindow(w, new Uint8Array(32));
  return w;
}

console.log(`owner ${owner.cosmos} (${client.address}), relayer ${relayer.cosmos}, agent ${agent.address}, registry ${registry}`);

// 1. Link the agent key.
const proof = signAuthenticatorLinkEip191({ chainId: CHAIN_ID, account: owner.cosmos, privateKey: agentPriv });
const linkMsgs = linkAuthenticatorMsgs({
  owner: owner.cosmos, chainId: CHAIN_ID, scheme: "secp256k1", pubkey: proof.pubkey, possessionProof: proof.possessionProof,
  permissions: ["evm"], expiryUnix: BigInt(Math.floor(Date.now() / 1000) + 86_400), label: "qorewitness-agent-spike",
  spendingRule: { id: "qw-anchor-only", enabled: true, perTxLimit: "1", dailyLimit: "1", allowedEvmCalls: [`${registry.toLowerCase()}/${ANCHOR_SELECTOR}`] },
});
const link = await sendHybrid(owner, linkMsgs);
report("1 link agent key", link.code === 0, `tx ${link.hash} code ${link.code}${link.code ? ` ${link.log.slice(0, 200)}` : ""}`);
if (link.code !== 0) process.exit(1);

// 2. Close the owner's EVM window, if one is open.
const before = await evmWindowStatus({ rest: REST, address: owner.cosmos });
if (before.found && before.live) {
  const close = await sendHybrid(owner, [closeEvmWindowMsg(owner.cosmos)]);
  report("2 close owner EVM window", close.code === 0, `tx ${close.hash} code ${close.code}`);
} else report("2 close owner EVM window", true, "no live window");
const after = await evmWindowStatus({ rest: REST, address: owner.cosmos });
report("2 window closed", !(after.found && after.live), `live ${after.found ? after.live : false}`);

// 3. Anchor through MsgExecuteEVM.
const w = await testWindow("/tmp/qw-agent-spike");
const p = await client.prepareAnchor(deviceId, deviceKey, w);
const ex = await execute(registry, p.data);
const anchorId = await client.pub.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "anchorIdOf", args: [client.address, deviceId, w.windowStart] });
let ownerOnChain = "";
try {
  const a = await client.pub.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "getAnchor", args: [anchorId] });
  ownerOnChain = a.owner;
} catch {
  ownerOnChain = "none";
}
report("3 anchor via MsgExecuteEVM, no window", ex.code === 0 && !ex.failed.length && ownerOnChain.toLowerCase() === client.address.toLowerCase(),
  `tx ${ex.hash} code ${ex.code}${ex.failed.length ? ` failed: ${ex.failed.join("; ").slice(0, 200)}` : ""}, owner on chain ${ownerOnChain}`);

// 4. Another contract (the v3 registry): must fail.
const other = await execute("0x238A1D989c1f0561d4DD51d4B322C491A5cb1CD2", p.data);
report("4 other contract refused", other.code !== 0 || other.failed.length > 0, `tx ${other.hash} code ${other.code} ${other.failed.join("; ").slice(0, 160) || other.log.slice(0, 160)}`);

// 5. Value transfer of 1,000 uqor (rule allows 1 uqor): must fail.
const val = await execute(`0x${Buffer.from(hexToBytes(toHex(0n, { size: 20 }))).toString("hex")}` as Address, "0x", "1000000000000000");
report("5 value transfer refused", val.code !== 0 || val.failed.length > 0, `tx ${val.hash} code ${val.code} ${val.failed.join("; ").slice(0, 160) || val.log.slice(0, 160)}`);

// 6. Revoke, then anchor again: must fail.
const rev = await sendHybrid(owner, [revokeAuthenticatorMsg({ owner: owner.cosmos, scheme: "secp256k1", pubkey: proof.pubkey })]);
report("6 revoke agent key", rev.code === 0, `tx ${rev.hash} code ${rev.code}`);
const w2 = await testWindow("/tmp/qw-agent-spike-2");
const p2 = await client.prepareAnchor(deviceId, deviceKey, w2);
const after6 = await execute(registry, p2.data).catch((e: Error) => ({ hash: "-", code: -2, log: e.message.split("\n")[0], failed: [] as string[] }));
report("6 anchor after revoke refused", after6.code !== 0 || after6.failed.length > 0, `tx ${after6.hash} code ${after6.code} ${after6.log.slice(0, 160)}`);

console.log(`\n${results.filter((r) => r.ok).length} of ${results.length} checks passed.`);
if (results.some((r) => !r.ok)) process.exitCode = 1;
