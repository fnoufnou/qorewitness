/**
 * setup.ts - first-run wizard for one camera (terminal). Safe to run again: every step
 * checks what exists and skips it.
 *
 *   1. Camera settings      -> /data/camera.env
 *   2. Owner account        -> /data/qorewitness.env (new mnemonic, mode 600, testnet only)
 *   3. Test QOR             -> waits until the faucet funds the account
 *   4. ML-DSA-87 key        -> registered on chain with proof of possession
 *   5. Device key           -> /data/keys/<camera>.key (mode 600), registered in the registry
 *
 * Usage (Docker): docker compose run --rm agent setup [--camera front-door] [--rtsp rtsp://...]
 * Env: QW_DATA (default /data), QORE_REGISTRY (default: the public v3 registry).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner, buildRegisterPqcKeyMsg, deriveUnifiedAccount, fetchPqcStatus, generateMnemonic,
  isRegisteredPqcKey, signProofOfPossession,
} from "@qorechain/sdk";
import type { Address } from "viem";
import { AnchorClient, DEVICE_STATUS } from "../src/agent/anchor-client.js";
import { createDeviceKey, loadDeviceKey } from "../src/agent/device-key.js";
import { ensureScopedWindow, TESTNET_WINDOW } from "../src/agent/evm-window.js";
import { deviceIdOf } from "../src/core/message.js";

const DATA = process.env.QW_DATA ?? "/data";
const PUBLIC_REGISTRY_V3 = "0x238A1D989c1f0561d4DD51d4B322C491A5cb1CD2";
const FAUCET = "https://dashboard.qorechain.io";
const MIN_UQOR = 2_000_000n; // enough for key registration, a window and the device registration

const rl = createInterface({ input: process.stdin, output: process.stdout });
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const say = (s: string) => console.log(s);
const step = (n: number, s: string) => say(`\n[${n}/5] ${s}`);

function readEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}
function writeEnv(path: string, env: Record<string, string>, secret: boolean): void {
  writeFileSync(path, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: secret ? 0o600 : 0o644 });
  if (secret) chmodSync(path, 0o600);
}

async function uqor(qor1: string): Promise<bigint> {
  const r = await fetch(`${TESTNET_WINDOW.rest}/cosmos/bank/v1beta1/balances/${qor1}`);
  const b = (await r.json()) as { balances?: { denom: string; amount: string }[] };
  return BigInt(b.balances?.find((x) => x.denom === "uqor")?.amount ?? "0");
}

async function main(): Promise<void> {
  say("QoreWitness setup (QoreChain testnet). Nothing here touches mainnet funds.");
  mkdirSync(join(DATA, "keys"), { recursive: true, mode: 0o700 });

  step(1, "Camera");
  const camPath = join(DATA, "camera.env");
  const cam = readEnv(camPath);
  const label = cam.QW_DEVICE ?? arg("camera") ?? ((await rl.question("Camera name (letters, digits, dashes) [camera]: ")).trim() || "camera");
  if (!/^[a-z0-9-]{1,40}$/.test(label)) throw new Error("use lower-case letters, digits and dashes for the camera name");
  const rtsp = cam.QW_RTSP_URL ?? arg("rtsp") ?? (await rl.question("RTSP URL of the camera (rtsp://...): ")).trim();
  if (!/^rtsps?:\/\//.test(rtsp)) throw new Error("the stream URL must start with rtsp:// or rtsps://");
  writeEnv(camPath, {
    QW_DEVICE: label, QW_RTSP_URL: rtsp,
    QW_SEGMENT_SECONDS: cam.QW_SEGMENT_SECONDS ?? "60", QW_WINDOW_SECONDS: cam.QW_WINDOW_SECONDS ?? "600",
    QW_RETENTION_DAYS: cam.QW_RETENTION_DAYS ?? "14",
  }, false);
  say(`  camera "${label}" saved in ${camPath}`);

  step(2, "Owner account");
  const accPath = join(DATA, "qorewitness.env");
  const acc = readEnv(accPath);
  if (!acc.QORE_MNEMONIC) {
    acc.QORE_MNEMONIC = generateMnemonic(256);
    say("  new account created (from a fresh mnemonic, so the ECDSA key alone never gives the ML-DSA key)");
  }
  acc.QORE_REGISTRY ??= process.env.QORE_REGISTRY ?? PUBLIC_REGISTRY_V3;
  acc.QORE_NETWORK = "testnet";
  writeEnv(accPath, acc, true);
  const owner = await deriveUnifiedAccount(acc.QORE_MNEMONIC, 0);
  say(`  address ${owner.cosmos} (EVM ${owner.evm})`);
  say(`  the mnemonic is in ${accPath} (mode 600). Back it up. Never use it on mainnet.`);

  step(3, "Test QOR");
  for (let bal = await uqor(owner.cosmos); bal < MIN_UQOR; bal = await uqor(owner.cosmos)) {
    say(`  balance ${Number(bal) / 1e6} QOR. Claim test QOR for ${owner.cosmos} at ${FAUCET} (Faucet).`);
    await rl.question("  Press Enter when the faucet has sent it... ");
  }
  say(`  balance ${Number(await uqor(owner.cosmos)) / 1e6} QOR`);

  step(4, "Post-quantum key of the account");
  const pqc = await fetchPqcStatus({ rest: TESTNET_WINDOW.rest, address: owner.cosmos });
  if (pqc.registered && isRegisteredPqcKey(pqc, owner.pqc.publicKey) === false) {
    throw new Error("another ML-DSA key is registered for this account. Use the wallet that registered it.");
  }
  if (!pqc.registered) {
    const pop = signProofOfPossession({ chainId: TESTNET_WINDOW.chainId, account: owner.cosmos, keypair: owner.pqc });
    const msg = buildRegisterPqcKeyMsg(owner.cosmos, { pqcKeypair: owner.pqc, proofOfPossession: pop });
    const seqRes = await fetch(`${TESTNET_WINDOW.rest}/cosmos/auth/v1beta1/accounts/${owner.cosmos}`);
    const a = ((await seqRes.json()) as { account?: Record<string, unknown> }).account ?? {};
    const base = ((a.base_account ?? a) as Record<string, string>);
    const transport = await StargateClient.connect(TESTNET_WINDOW.rpc);
    try {
      const r = await new EthNativeSigner(owner, { signMode: "classical", rest: TESTNET_WINDOW.rest }).signAndBroadcast(transport, {
        chainId: TESTNET_WINDOW.chainId, accountNumber: BigInt(base.account_number ?? "0"), sequence: BigInt(base.sequence ?? "0"),
        fee: { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" }, messages: [msg],
      });
      if (r.code !== 0) throw new Error(`key registration failed: code ${r.code} ${r.rawLog ?? ""}`);
    } finally {
      transport.disconnect();
    }
    await new Promise((ok) => setTimeout(ok, 8000));
    say("  ML-DSA-87 key registered with proof of possession");
  } else say("  already registered");

  step(5, "Camera key");
  const keyPath = join(DATA, "keys", `${label}.key`);
  const key = existsSync(keyPath) ? loadDeviceKey(keyPath) : createDeviceKey(keyPath);
  const client = await AnchorClient.create(acc.QORE_MNEMONIC, acc.QORE_REGISTRY as Address);
  const deviceId = deviceIdOf(label);
  let d = await client.getDevice(deviceId);
  if (d.status === 0) {
    if (await ensureScopedWindow(owner, acc.QORE_REGISTRY)) say("  opened an EVM window scoped to the registry");
    const tx = await client.registerDevice(deviceId, key);
    say(`  camera registered: tx ${tx.txHash}`);
    d = await client.getDevice(deviceId);
  }
  if (d.status !== 1 || d.keyHash !== key.keyHash) {
    throw new Error(`camera "${label}" is ${DEVICE_STATUS[d.status]} with another key. Choose another camera name.`);
  }
  say(`  camera "${label}" is active, key version ${d.keyVersion}`);

  say("\nDone. Start recording and anchoring with: docker compose up -d");
  say("Receipts appear in ./data/" + label + "/receipts every 10 minutes.");
}

main()
  .catch((e: unknown) => {
    console.error(`\nSetup stopped: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
