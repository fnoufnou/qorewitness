/**
 * qday-drill.ts - Q-Day Drill tools (testnet only).
 *
 *   fund <qor1-address> <qor>   send test QOR from the QORE_MNEMONIC account (hybrid signed)
 *   export-ecdsa <file>         write the ECDSA private key of the QORE_MNEMONIC account (mode 600).
 *                               This is the key the drill bot gets. Use it ONLY for a throwaway drill account.
 *   dryrun                      act as the drill bot: use ONLY the ECDSA key and try every attack
 *   self-send                   drill-day normal transaction: 1 uqor from the QORE_MNEMONIC account to itself,
 *                               hybrid signed, no EVM window, lowest safe fee (a hybrid MsgSend uses about
 *                               190,000 gas, minimum gas price 0.1 uqor: 250,000 gas, 0.025 QOR)
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
import {
  accountSequence as bankAccountSequence, balanceUqor as bankBalanceUqor, finalCode as bankFinalCode, FEE_HYBRID_SEND, hybridBankSend,
} from "../src/agent/bank.js";
import type { ReceiptV3 as ReceiptV2 } from "../src/core/verify.js";

const CHAIN_ID = "qorechain-diana";
const REST = "https://api-testnet.qore.host";
const RPC = "https://rpc-testnet.qore.host";
const FEE = { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" };
const ATTACKER: Address = "0x000000000000000000000000000000000000dEaD";
const FAKE_TOKEN = `0x${keccak256(toBytes("qorewitness-drill-token")).slice(26)}` as Address; // not in any window scope

const NET = { chainId: CHAIN_ID, rest: REST, rpc: RPC };
const accountSequence = (address: string) => bankAccountSequence(REST, address);
const balanceUqor = (qor1: string) => bankBalanceUqor(REST, qor1);
const finalCode = (hash: string) => bankFinalCode(REST, hash);

async function mnemonicAccount(): Promise<UnifiedAccount> {
  const m = process.env.QORE_MNEMONIC?.trim();
  if (!m) throw new Error("set QORE_MNEMONIC");
  return deriveUnifiedAccount(m, 0);
}

async function fund(to: string, qor: string): Promise<void> {
  if (!/^qor1[0-9a-z]{38,}$/.test(to)) throw new Error("usage: fund <qor1-address> <qor>");
  const from = await mnemonicAccount();
  const r = await hybridBankSend(from, to, BigInt(Math.round(Number(qor) * 1e6)), NET, FEE);
  console.log(`sent ${qor} QOR from ${from.cosmos} to ${to}: code ${r.code} tx ${r.transactionHash}`);
}

async function selfSend(): Promise<void> {
  const from = await mnemonicAccount();
  const before = await balanceUqor(from.cosmos);
  const r = await hybridBankSend(from, from.cosmos, 1n, NET, FEE_HYBRID_SEND);
  console.log(`self-send from ${from.cosmos}: code ${r.code} tx ${r.transactionHash}`);
  if (r.code !== 0) throw new Error(`self-send failed: code ${r.code}`);
  const fin = await finalCode(r.transactionHash);
  console.log(`final: ${fin ? `code ${fin.code}${fin.code ? ` ${fin.log}` : " (success)"}` : "not found yet, check the explorer"}`);
  if (fin && fin.code !== 0) throw new Error(`self-send failed on chain: code ${fin.code}`);
  console.log(`balance ${before} uqor before, ${await balanceUqor(from.cosmos)} uqor after`);
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
      encodeFunctionData({ abi: REGISTRY_ABI, functionName: "anchor", args: [
        { deviceId: dev, windowStart: now - 60n, windowSeconds: 30, leafCount: 1, root: keccak256(toBytes("fake")),
          prevRoot: (receipt as { root: Hex }).root, refBlock: (await pub.getBlockNumber()) - 1n, refBlockHash: keccak256(toBytes("guess")) },
        receipt.devicePubkey, fakeSig] }));
    await evmTx("A11 replay the last real anchor (same window, real signature)", registry,
      encodeFunctionData({ abi: REGISTRY_ABI, functionName: "anchor", args: [
        { deviceId: dev, windowStart: BigInt(receipt.windowStart), windowSeconds: receipt.windowSeconds, leafCount: receipt.segments.length,
          root: receipt.root, prevRoot: receipt.prevRoot ?? `0x${"00".repeat(32)}`, refBlock: BigInt(receipt.refBlock ?? "1"), refBlockHash: receipt.refBlockHash ?? `0x${"00".repeat(32)}` },
        receipt.devicePubkey, receipt.signature] }));
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
const run = cmd === "fund" ? () => fund(a1, a2) : cmd === "export-ecdsa" ? () => exportEcdsa(a1) : cmd === "dryrun" ? dryrun
  : cmd === "self-send" ? selfSend : undefined;
if (!run) {
  console.error("commands: fund <qor1> <qor> | export-ecdsa <file> | dryrun | self-send");
  process.exit(1);
}
run().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message.split("\n")[0] : e);
  process.exitCode = 1;
});
