/**
 * qday-drill.ts - Q-Day Drill tools (testnet only).
 *
 *   fund <qor1-address> <qor>   send test QOR from the QORE_MNEMONIC account (hybrid signed)
 *   export-ecdsa <file>         write the ECDSA private key of the QORE_MNEMONIC account (mode 600).
 *                               This is the key the drill bot gets. Use it ONLY for a throwaway drill account.
 *   dryrun                      act as the drill bot: use ONLY the ECDSA key and try every attack
 *
 * dryrun env:
 *   DRILL_ECDSA_KEY_FILE  file with the 0x... ECDSA key (nothing else is used)
 *   QORE_REGISTRY         AnchorRegistry v2
 *   DRILL_RECEIPT         a receipt of the drill device (public data: device key, signature, window)
 *   DRILL_SEND=1          broadcast the EVM attacks (spends test QOR). Default: simulate EVM calls only.
 *
 * Every attack prints REFUSED (good) or SUCCEEDED (bad). Exit code 1 if any attack succeeded.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner, deriveUnifiedAccount, evmToQor, fetchPqcStatus, isRegisteredPqcKey, openEvmWindowMsg,
  unifiedAccountFromSeed, type UnifiedAccount,
} from "@qorechain/sdk";
import { evmWindowStatus } from "@qorechain/evm";
import {
  createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, parseAbi, parseEther, toBytes, toHex,
  type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { qorechainTestnet, REGISTRY_ABI } from "../src/agent/anchor-client.js";
import type { ReceiptV2 } from "../src/core/verify.js";

const CHAIN_ID = "qorechain-diana";
const REST = "https://api-testnet.qore.host";
const RPC = "https://rpc-testnet.qore.host";
const FEE = { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" };
const ATTACKER: Address = "0x000000000000000000000000000000000000dEaD";
const FAKE_TOKEN = `0x${keccak256(toBytes("qorewitness-drill-token")).slice(26)}` as Address; // not in any window scope

async function accountSequence(address: string) {
  const res = await fetch(`${REST}/cosmos/auth/v1beta1/accounts/${address}`);
  if (!res.ok) throw new Error(`account query failed: HTTP ${res.status}`);
  const body = (await res.json()) as { account?: Record<string, unknown> };
  const acc = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
  return { accountNumber: BigInt(acc.account_number ?? "0"), sequence: BigInt(acc.sequence ?? "0") };
}

async function balanceUqor(qor1: string): Promise<bigint> {
  const res = await fetch(`${REST}/cosmos/bank/v1beta1/balances/${qor1}`);
  const body = (await res.json()) as { balances?: { denom: string; amount: string }[] };
  return BigInt(body.balances?.find((b) => b.denom === "uqor")?.amount ?? "0");
}

/** Waits for a Cosmos tx and returns its final code (CheckTx can pass, DeliverTx can still fail). */
async function finalCode(hash: string): Promise<{ code: number; log: string } | undefined> {
  for (let i = 0; i < 10; i++) {
    await new Promise((ok) => setTimeout(ok, 2000));
    const res = await fetch(`${REST}/cosmos/tx/v1beta1/txs/${hash}`);
    if (res.ok) {
      const b = (await res.json()) as { tx_response?: { code: number; raw_log: string } };
      if (b.tx_response) return { code: b.tx_response.code, log: b.tx_response.raw_log };
    }
  }
  return undefined;
}

async function mnemonicAccount(): Promise<UnifiedAccount> {
  const m = process.env.QORE_MNEMONIC?.trim();
  if (!m) throw new Error("set QORE_MNEMONIC");
  return deriveUnifiedAccount(m, 0);
}

async function fund(to: string, qor: string): Promise<void> {
  if (!/^qor1[0-9a-z]{38,}$/.test(to)) throw new Error("usage: fund <qor1-address> <qor>");
  const from = await mnemonicAccount();
  const amount = [{ denom: "uqor", amount: (BigInt(Math.round(Number(qor) * 1e6))).toString() }];
  const transport = await StargateClient.connect(RPC);
  try {
    const signer = new EthNativeSigner(from, { signMode: "hybrid", rest: REST });
    const r = await signer.bankSend(transport, to, amount, { chainId: CHAIN_ID, ...(await accountSequence(from.cosmos)), fee: FEE });
    console.log(`sent ${qor} QOR from ${from.cosmos} to ${to}: code ${r.code} tx ${r.transactionHash}`);
  } finally {
    transport.disconnect();
  }
}

async function exportEcdsa(file: string): Promise<void> {
  if (!file) throw new Error("usage: export-ecdsa <file>");
  if (existsSync(file)) throw new Error(`${file} exists, refusing to overwrite`);
  const a = await mnemonicAccount();
  writeFileSync(file, a.privateKey + "\n", { mode: 0o600, flag: "wx" });
  console.log(`ECDSA key of ${a.evm} (${a.cosmos}) written to ${file}. Hand this key only to the drill.`);
}

// ------------------------------------------------------------------ dry run

type Outcome = "REFUSED" | "SUCCEEDED" | "SKIPPED";
const results: { name: string; outcome: Outcome; detail: string }[] = [];
const record = (name: string, outcome: Outcome, detail: string) => {
  results.push({ name, outcome, detail });
  console.log(`${outcome.padEnd(9)} ${name}: ${detail}`);
};
const short = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  const sig = /signature:\s*\n?\s*['"]?(0x[0-9a-f]{8})/i.exec(m)?.[1];
  const named = /reverted with the following reason:\s*\n?\s*([A-Za-z]+\([^)]*\))/.exec(m)?.[1]
    ?? /Error: ([A-Za-z]+)\(/.exec(m)?.[1];
  return (named ?? sig ?? m.split("\n").find((l) => l.trim()) ?? m).slice(0, 160);
};

async function dryrun(): Promise<void> {
  const keyFile = process.env.DRILL_ECDSA_KEY_FILE;
  const registry = process.env.QORE_REGISTRY?.trim() as Address | undefined;
  if (!keyFile || !registry) throw new Error("set DRILL_ECDSA_KEY_FILE and QORE_REGISTRY");
  const ecdsa = readFileSync(keyFile, "utf8").trim() as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(ecdsa)) throw new Error("the key file must hold 0x + 64 hex characters");
  const send = process.env.DRILL_SEND === "1";
  const receipt = process.env.DRILL_RECEIPT ? (JSON.parse(readFileSync(process.env.DRILL_RECEIPT, "utf8")) as ReceiptV2) : undefined;

  // What the bot can build from the ECDSA key alone.
  const fake = unifiedAccountFromSeed(toBytes(ecdsa)); // its PQC key is derived from the ECDSA key
  const evm = privateKeyToAccount(ecdsa);
  const pub = createPublicClient({ chain: qorechainTestnet, transport: http() });
  const wallet = createWalletClient({ chain: qorechainTestnet, transport: http(), account: evm });
  console.log(`victim ${evm.address} (${fake.cosmos}), registry ${registry}, mode ${send ? "SEND" : "simulate EVM"}`);
  const before = await balanceUqor(fake.cosmos);
  const wBefore = await evmWindowStatus({ rest: REST, address: fake.cosmos });
  console.log(`balance ${before} uqor. window: ${wBefore.found ? `${wBefore.live ? "live" : "not live"}, ${wBefore.remainingTxs} txs, ${wBefore.remainingValue} uqor` : "none"}`);

  // A0: rebuild the ML-DSA key from the ECDSA key.
  const pqc = await fetchPqcStatus({ rest: REST, address: fake.cosmos });
  const match = pqc.registered ? isRegisteredPqcKey(pqc, fake.pqc.publicKey) : undefined;
  if (!pqc.registered) record("A0 derive ML-DSA key from ECDSA key", "SKIPPED", "no PQC key registered for the account");
  else if (match) record("A0 derive ML-DSA key from ECDSA key", "SUCCEEDED", "unifiedAccountFromSeed(ECDSA key) gives the registered ML-DSA key");
  else record("A0 derive ML-DSA key from ECDSA key", "REFUSED", "the derived key is not the registered key");

  // A1 to A3: native lane.
  const transport = await StargateClient.connect(RPC);
  const native = async (name: string, mode: "classical" | "hybrid", messages: Parameters<EthNativeSigner["signAndBroadcast"]>[1]["messages"]) => {
    try {
      const signer = new EthNativeSigner(fake, { signMode: mode, rest: REST });
      const r = await signer.signAndBroadcast(transport, { chainId: CHAIN_ID, ...(await accountSequence(fake.cosmos)), fee: FEE, messages });
      if (r.code !== 0) return record(name, "REFUSED", `code ${r.code} ${(r.rawLog ?? "").slice(0, 120)}`);
      const f = await finalCode(r.transactionHash);
      if (f && f.code !== 0) return record(name, "REFUSED", `in block: code ${f.code} ${f.log.slice(0, 120)}`);
      record(name, "SUCCEEDED", `tx ${r.transactionHash}`);
    } catch (e) {
      record(name, "REFUSED", short(e));
    }
  };
  const sendMsg = {
    typeUrl: "/cosmos.bank.v1beta1.MsgSend",
    value: { fromAddress: fake.cosmos, toAddress: evmToQor(ATTACKER), amount: [{ denom: "uqor", amount: "1000000" }] },
  };
  try {
    await native("A1 native transfer, ECDSA only", "classical", [sendMsg]);
    await native("A2 native transfer, hybrid with the derived ML-DSA key", "hybrid", [sendMsg]);
    await native("A3 open an unscoped EVM window, ECDSA only", "classical", [
      openEvmWindowMsg({ sender: fake.cosmos, blocks: 1000n, maxTxs: 50n, maxValue: 50_000_000n }),
    ]);
    await native("A3b open an unscoped EVM window, hybrid with the derived key", "hybrid", [
      openEvmWindowMsg({ sender: fake.cosmos, blocks: 1000n, maxTxs: 50n, maxValue: 50_000_000n }),
    ]);
  } finally {
    transport.disconnect();
  }

  // A4 to A10: EVM lane, inside whatever window the owner left open.
  const evmTx = async (name: string, to: Address, data: Hex | undefined, value = 0n) => {
    try {
      await pub.call({ account: evm, to, data, value });
    } catch (e) {
      if (!send) return record(name, "REFUSED", `simulation: ${short(e)}`);
    }
    if (!send) return record(name, "SUCCEEDED", "simulation passed (the window may still stop it, run with DRILL_SEND=1)");
    try {
      const hash = await wallet.sendTransaction({ to, data, value, gas: 900_000n });
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
      record(name, r.status === "success" ? "SUCCEEDED" : "REFUSED", `${r.status === "success" ? "mined OK" : "mined but reverted"}, gas ${r.gasUsed}, tx ${hash}`);
    } catch (e) {
      record(name, "REFUSED", `not admitted: ${short(e)}`);
    }
  };

  await evmTx("A4 EVM transfer of 1 QOR to the attacker", ATTACKER, undefined, parseEther("1"));
  await evmTx("A5 token approval (target outside the window scope)", FAKE_TOKEN,
    encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [ATTACKER, 2n ** 256n - 1n] }));
  await evmTx("A6 send QOR to the registry (in scope)", registry, undefined, parseEther("0.1"));

  const fakeKey = toHex(new Uint8Array(2592).fill(0xa7));
  const fakeSig = toHex(new Uint8Array(4627).fill(0x5c));
  const dev = receipt?.deviceId ?? keccak256(toBytes("QoreWitness/device/drill-cam"));
  await evmTx("A7 revoke the owner's device with a forged owner signature", registry,
    encodeFunctionData({ abi: REGISTRY_ABI, functionName: "revokeDevice", args: [dev, fakeSig] }));
  await evmTx("A8 register an attacker device with a forged owner signature", registry,
    encodeFunctionData({ abi: REGISTRY_ABI, functionName: "registerDevice", args: [keccak256(toBytes("attacker-cam")), fakeKey, fakeSig, fakeSig] }));
  if (receipt) {
    const now = BigInt(Math.floor(Date.now() / 1000));
    await evmTx("A9 rotate the device to an attacker key (real old key, forged signatures)", registry,
      encodeFunctionData({ abi: REGISTRY_ABI, functionName: "rotateDeviceKey", args: [dev, receipt.devicePubkey, fakeKey, fakeSig, fakeSig] }));
    await evmTx("A10 anchor a fake window with the real device key and a forged signature", registry,
      encodeFunctionData({ abi: REGISTRY_ABI, functionName: "anchor", args: [dev, now - 60n, 30, 1, keccak256(toBytes("fake")), receipt.devicePubkey, fakeSig] }));
    await evmTx("A11 replay the last real anchor (same window, real signature)", registry,
      encodeFunctionData({ abi: REGISTRY_ABI, functionName: "anchor", args: [dev, BigInt(receipt.windowStart), receipt.windowSeconds, receipt.segments.length, receipt.root, receipt.devicePubkey, receipt.signature] }));
  } else {
    record("A9 to A11 device attacks", "SKIPPED", "set DRILL_RECEIPT to a receipt of the drill device");
  }

  const after = await balanceUqor(fake.cosmos);
  const wAfter = await evmWindowStatus({ rest: REST, address: fake.cosmos });
  console.log(`\nbalance ${after} uqor (spent ${before - after} uqor on fees). window: ${wAfter.found ? `${wAfter.remainingTxs} txs, ${wAfter.remainingValue} uqor left` : "none"}`);
  const bad = results.filter((r) => r.outcome === "SUCCEEDED");
  console.log(`${results.length} attacks, ${bad.length} succeeded.`);
  if (bad.length) process.exitCode = 1;
}

const [cmd, a1, a2] = process.argv.slice(2);
const run = cmd === "fund" ? () => fund(a1, a2) : cmd === "export-ecdsa" ? () => exportEcdsa(a1) : cmd === "dryrun" ? dryrun : undefined;
if (!run) {
  console.error("commands: fund <qor1> <qor> | export-ecdsa <file> | dryrun");
  process.exit(1);
}
run().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message.split("\n")[0] : e);
  process.exitCode = 1;
});
