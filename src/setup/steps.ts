/**
 * Setup steps for one camera, shared by the terminal setup (scripts/setup.ts)
 * and the browser setup (src/web/wizard.ts). Every step checks what exists and
 * skips it, so a step can run again after a crash, a closed browser or a restart.
 *
 *   saveCamera          -> /data/camera.env (mode 600: the stream URL holds the camera password)
 *   ensureOwnerAccount  -> /data/qorewitness.env (new recovery phrase, mode 600, testnet only)
 *   ensureDeviceKey     -> /data/keys/<camera>.key (ML-DSA-87 seed, mode 600, never overwritten)
 *   registerOnChain     -> account ML-DSA-87 key with proof of possession, scoped EVM window,
 *                          camera registration. Checks chain 9800 / qorechain-diana before every write.
 *   finishSetup         -> /data/account.json (public facts only) and /data/setup.done
 *
 * Chain access goes through the ChainOps interface: liveChain() for the testnet,
 * a mock in the tests. Nothing here prints or returns a secret.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner, buildRegisterPqcKeyMsg, deriveUnifiedAccount, fetchPqcStatus, generateMnemonic,
  isRegisteredPqcKey, signProofOfPossession, type UnifiedAccount,
} from "@qorechain/sdk";
import type { Address, Hex } from "viem";
import { AnchorClient } from "../agent/anchor-client.js";
import { createDeviceKey, loadDeviceKey, type DeviceKey } from "../agent/device-key.js";
import { ensureScopedWindow, TESTNET_WINDOW } from "../agent/evm-window.js";
import { deviceIdOf } from "../core/message.js";

export const PUBLIC_REGISTRY_V4 = "0xa1378D6558B32e1f8d37b68cf90e3C93839Da365";
export const FAUCET = "https://dashboard.qorechain.io/faucet";
export const EXPLORER = "https://explore.qore.network";
/** Enough for the key registration, one window and the camera registration. */
export const MIN_SETUP_UQOR = 2_000_000n;
/** About 0.0457 test QOR per anchor plus a share of the EVM window opens (docs/TESTNET_FINDINGS.md). */
export const FEE_PER_ANCHOR_UQOR = 48_000n;
export const TESTNET_EVM_CHAIN_ID = 9800;
export const LABEL_RE = /^[a-z0-9-]{1,40}$/;

export type Plan = "self" | "sponsored";

export interface Paths {
  data: string;
  cameraEnv: string;
  accountEnv: string;
  keysDir: string;
  uiDir: string;
  accountJson: string;
  done: string;
}

export function dataPaths(data = process.env.QW_DATA ?? "/data"): Paths {
  return {
    data,
    cameraEnv: join(data, "camera.env"),
    accountEnv: join(data, "qorewitness.env"),
    keysDir: join(data, "keys"),
    uiDir: join(data, "ui"),
    accountJson: join(data, "account.json"),
    done: join(data, "setup.done"),
  };
}

/** /data, /data/keys and /data/ui: mode 700. */
export function ensureDirs(p: Paths): void {
  for (const d of [p.data, p.keysDir, p.uiDir]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    try {
      chmodSync(d, 0o700);
    } catch {
      // A bind mount owned by another user: the installer sets the mode.
    }
  }
}

// ---------------------------------------------------------------- secret lock

/**
 * After setup the dashboard process has no reason to read the recovery phrase or
 * the camera keys. lockSecrets() makes every read of them in this process throw.
 * The ui calls it as soon as setup.done exists. Defense in depth: the files stay
 * on the same volume, so a bug that runs code in the process can still reach them.
 */
let secretsLocked = false;
export function lockSecrets(): void {
  secretsLocked = true;
}
export const secretsAreLocked = () => secretsLocked;
/** For tests only. */
export function unlockSecretsForTests(): void {
  secretsLocked = false;
}
function assertSecretRead(path: string): void {
  if (secretsLocked && (/(^|\/)qorewitness\.env$/.test(path) || /(^|\/)keys(\/|$)/.test(path))) {
    throw new Error("setup is done: this process no longer reads keys");
  }
}

export function readEnvFile(path: string): Record<string, string> {
  assertSecretRead(path);
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Writes through a temp file and a rename, so a reader never sees half a file. Mode 600. */
export function writeSecretFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Every env file of QoreWitness holds a secret (camera password or recovery phrase): mode 600. */
export function writeEnvFile(path: string, env: Record<string, string>): void {
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k) || /[\r\n]/.test(v)) throw new Error(`invalid env entry ${k}`);
  }
  writeSecretFile(path, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
}

export function writePublicJson(path: string, value: unknown): void {
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o644, flag: "wx" });
  renameSync(tmp, path);
}

// ---------------------------------------------------------------- camera

export interface CameraSettings {
  label: string;
  streamUrl: string;
  retentionDays?: number;
}

export function saveCamera(p: Paths, cam: CameraSettings): void {
  if (!LABEL_RE.test(cam.label)) throw new Error("use lower-case letters, digits and dashes for the camera name");
  if (!/^(rtsps?|rtmps?|https?):\/\//.test(cam.streamUrl) || /\s/.test(cam.streamUrl)) {
    throw new Error("the stream URL must start with rtsp(s)://, rtmp(s):// or http(s)://");
  }
  const old = readEnvFile(p.cameraEnv);
  const info = readAccountInfo(p);
  if (info && info.device !== cam.label) throw new Error(`this box is set up for camera "${info.device}". The name cannot change.`);
  const days = cam.retentionDays ?? Number(old.QW_RETENTION_DAYS ?? 14);
  if (!Number.isInteger(days) || days < 2 || days > 365) throw new Error("keep video for 2 to 365 days");
  ensureDirs(p);
  writeEnvFile(p.cameraEnv, {
    ...old,
    QW_DEVICE: cam.label,
    QW_STREAM_URL: cam.streamUrl,
    QW_SEGMENT_SECONDS: old.QW_SEGMENT_SECONDS ?? "60",
    QW_WINDOW_SECONDS: old.QW_WINDOW_SECONDS ?? "600",
    QW_RETENTION_DAYS: String(days),
  });
}

// ---------------------------------------------------------------- owner account

export interface OwnerPublic {
  cosmos: string; // qor1...
  evm: Address; // 0x...
  registry: Address;
  created: boolean;
}

/** Creates the owner account from a fresh recovery phrase, once. Returns public data only. */
export async function ensureOwnerAccount(p: Paths, registry?: string): Promise<OwnerPublic> {
  ensureDirs(p);
  const acc = readEnvFile(p.accountEnv);
  let created = false;
  if (!acc.QORE_MNEMONIC) {
    // A fresh phrase, so the ECDSA key alone never gives the ML-DSA key.
    acc.QORE_MNEMONIC = generateMnemonic(256);
    created = true;
  }
  acc.QORE_REGISTRY ??= registry ?? process.env.QORE_REGISTRY ?? PUBLIC_REGISTRY_V4;
  acc.QORE_NETWORK = "testnet";
  writeEnvFile(p.accountEnv, acc);
  const owner = await deriveUnifiedAccount(acc.QORE_MNEMONIC, 0);
  return { cosmos: owner.cosmos, evm: owner.evm as Address, registry: acc.QORE_REGISTRY as Address, created };
}

/** Public data of an existing owner account. Reads only, writes nothing. */
export async function readOwnerPublic(p: Paths): Promise<Omit<OwnerPublic, "created"> | undefined> {
  const acc = readEnvFile(p.accountEnv);
  if (!acc.QORE_MNEMONIC) return undefined;
  const owner = await deriveUnifiedAccount(acc.QORE_MNEMONIC, 0);
  return { cosmos: owner.cosmos, evm: owner.evm as Address, registry: (acc.QORE_REGISTRY ?? PUBLIC_REGISTRY_V4) as Address };
}

/** The full owner account, with keys. Only for the steps that sign. Never log or return it. */
export async function loadOwner(p: Paths): Promise<{ account: UnifiedAccount; mnemonic: string; registry: Address }> {
  const acc = readEnvFile(p.accountEnv);
  if (!acc.QORE_MNEMONIC) throw new Error("no owner account yet");
  return {
    account: await deriveUnifiedAccount(acc.QORE_MNEMONIC, 0),
    mnemonic: acc.QORE_MNEMONIC,
    registry: (acc.QORE_REGISTRY ?? PUBLIC_REGISTRY_V4) as Address,
  };
}

// ---------------------------------------------------------------- camera key

export function deviceKeyPath(p: Paths, label: string): string {
  if (!LABEL_RE.test(label)) throw new Error("invalid camera name");
  return join(p.keysDir, `${label}.key`);
}

/** Loads the camera key, or creates it once. createDeviceKey refuses to overwrite. */
export function ensureDeviceKey(p: Paths, label: string): { key: DeviceKey; created: boolean } {
  const path = deviceKeyPath(p, label);
  assertSecretRead(path);
  ensureDirs(p);
  if (existsSync(path)) return { key: loadDeviceKey(path), created: false };
  return { key: createDeviceKey(path), created: true };
}

/** Short, readable fingerprint of the camera key hash, e.g. "3F9A-01C2-77DE-B415". */
export function keyFingerprint(keyHash: string): string {
  return keyHash.replace(/^0x/, "").slice(0, 16).toUpperCase().match(/.{4}/g)!.join("-");
}

// ---------------------------------------------------------------- chain

export interface DeviceOnChain {
  status: number; // 0 none, 1 active, 2 revoked
  keyHash: Hex;
  keyVersion: number;
}

/** Everything the setup does on the chain. liveChain() talks to the testnet. */
export interface ChainOps {
  /** Throws unless the EVM chain id is 9800 and the Cosmos chain id is qorechain-diana. */
  assertTestnet(): Promise<void>;
  balanceUqor(qor1: string): Promise<bigint>;
  /** "none": no key yet. "ours": the account's own key. "other": another key. */
  pqcKeyState(owner: UnifiedAccount): Promise<"none" | "ours" | "other">;
  registerPqcKey(owner: UnifiedAccount): Promise<void>;
  /** Opens a window scoped to the registry when needed. True if it opened one. */
  ensureWindow(owner: UnifiedAccount, registry: Address): Promise<boolean>;
  getDevice(mnemonic: string, registry: Address, deviceId: Hex): Promise<DeviceOnChain>;
  registerDevice(mnemonic: string, registry: Address, deviceId: Hex, key: DeviceKey): Promise<{ txHash: Hex }>;
}

async function getJson(url: string, timeoutMs = 15_000): Promise<unknown> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  return r.json();
}

export async function fetchBalanceUqor(qor1: string, rest = TESTNET_WINDOW.rest, timeoutMs = 15_000): Promise<bigint> {
  const b = (await getJson(`${rest}/cosmos/bank/v1beta1/balances/${encodeURIComponent(qor1)}`, timeoutMs)) as {
    balances?: { denom: string; amount: string }[];
  };
  return BigInt(b.balances?.find((x) => x.denom === "uqor")?.amount ?? "0");
}

export const TESTNET_EVM_RPC = "https://evm-testnet.qore.host";

/**
 * Read-only check for the dashboard: does the seal contract still hold code, and
 * how high is the chain. Used to tell the owner about a test network reset.
 */
export async function fetchRegistryCheck(registry: string, evmRpc = TESTNET_EVM_RPC, timeoutMs = 15_000): Promise<{ hasCode: boolean; head: bigint }> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(registry)) throw new Error("bad registry address");
  const call = async (method: string, params: unknown[]) => {
    const r = await fetch(evmRpc, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(evmRpc).host}`);
    const j = (await r.json()) as { result?: unknown };
    if (typeof j.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(j.result)) throw new Error(`${method}: no result`);
    return j.result;
  };
  const [code, head] = await Promise.all([call("eth_getCode", [registry, "latest"]), call("eth_blockNumber", [])]);
  return { hasCode: code.length > 2, head: BigInt(head) };
}

export function liveChain(cfg = TESTNET_WINDOW, evmRpc = TESTNET_EVM_RPC): ChainOps {
  const assertTestnet = async () => {
    const r = await fetch(evmRpc, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(15_000),
    });
    const evmId = Number(((await r.json()) as { result?: string }).result);
    const node = (await getJson(`${cfg.rest}/cosmos/base/tendermint/v1beta1/node_info`)) as {
      default_node_info?: { network?: string };
    };
    const network = node.default_node_info?.network;
    if (evmId !== TESTNET_EVM_CHAIN_ID || network !== cfg.chainId) {
      throw new Error(`refusing to write: expected testnet ${cfg.chainId} (EVM ${TESTNET_EVM_CHAIN_ID}), got ${network} (EVM ${evmId})`);
    }
  };
  return {
    assertTestnet,
    balanceUqor: (qor1) => fetchBalanceUqor(qor1, cfg.rest),
    async pqcKeyState(owner) {
      const s = await fetchPqcStatus({ rest: cfg.rest, address: owner.cosmos });
      if (!s.registered) return "none";
      return isRegisteredPqcKey(s, owner.pqc.publicKey) === false ? "other" : "ours";
    },
    async registerPqcKey(owner) {
      await assertTestnet();
      const pop = signProofOfPossession({ chainId: cfg.chainId, account: owner.cosmos, keypair: owner.pqc });
      const msg = buildRegisterPqcKeyMsg(owner.cosmos, { pqcKeypair: owner.pqc, proofOfPossession: pop });
      const a = ((await getJson(`${cfg.rest}/cosmos/auth/v1beta1/accounts/${owner.cosmos}`)) as { account?: Record<string, unknown> }).account ?? {};
      const base = (a.base_account ?? a) as Record<string, string>;
      const transport = await StargateClient.connect(cfg.rpc);
      try {
        const r = await new EthNativeSigner(owner, { signMode: "classical", rest: cfg.rest }).signAndBroadcast(transport, {
          chainId: cfg.chainId, accountNumber: BigInt(base.account_number ?? "0"), sequence: BigInt(base.sequence ?? "0"),
          fee: { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" }, messages: [msg],
        });
        if (r.code !== 0) throw new Error(`key registration failed: code ${r.code}`);
      } finally {
        transport.disconnect();
      }
      // Wait until the chain shows the key.
      for (let i = 0; i < 15; i++) {
        await new Promise((ok) => setTimeout(ok, 2000));
        const s = await fetchPqcStatus({ rest: cfg.rest, address: owner.cosmos });
        if (s.registered) return;
      }
      throw new Error("key registration not visible on chain yet");
    },
    async ensureWindow(owner, registry) {
      await assertTestnet();
      return ensureScopedWindow(owner, registry, cfg);
    },
    async getDevice(mnemonic, registry, deviceId) {
      const c = await AnchorClient.create(mnemonic, registry, evmRpc);
      const d = await c.getDevice(deviceId);
      return { status: Number(d.status), keyHash: d.keyHash, keyVersion: Number(d.keyVersion) };
    },
    async registerDevice(mnemonic, registry, deviceId, key) {
      await assertTestnet();
      const c = await AnchorClient.create(mnemonic, registry, evmRpc);
      const tx = await c.registerDevice(deviceId, key);
      return { txHash: tx.txHash };
    },
  };
}

// ---------------------------------------------------------------- registration

export type Progress = (step: number, total: number, text: string) => void;

export interface RegistrationResult {
  deviceId: Hex;
  txHash?: Hex;
  keyVersion: number;
}

/** Registration steps in plain words, for the progress bar. */
export const REGISTER_STEPS = ["Check the network", "Protect your account", "Allow your box to seal", "Connect the camera"] as const;

/**
 * Registers the account key, opens the scoped window and registers the camera.
 * Each part checks the chain first, so running it again changes nothing.
 */
export async function registerOnChain(p: Paths, label: string, chain: ChainOps, progress: Progress = () => {}): Promise<RegistrationResult> {
  const total = REGISTER_STEPS.length;
  const { account, mnemonic, registry } = await loadOwner(p);
  const { key } = ensureDeviceKey(p, label);
  const deviceId = deviceIdOf(label);

  progress(1, total, REGISTER_STEPS[0]);
  await chain.assertTestnet();
  const bal = await chain.balanceUqor(account.cosmos);
  if (bal < MIN_SETUP_UQOR) throw new Error("not enough test QOR on the account yet");

  progress(2, total, REGISTER_STEPS[1]);
  const pq = await chain.pqcKeyState(account);
  if (pq === "other") throw new Error("another post-quantum key is registered for this account. Use the wallet that registered it.");
  if (pq === "none") await chain.registerPqcKey(account);

  let d = await chain.getDevice(mnemonic, registry, deviceId);
  let txHash: Hex | undefined;
  if (d.status === 0) {
    progress(3, total, REGISTER_STEPS[2]);
    await chain.ensureWindow(account, registry);
    progress(4, total, REGISTER_STEPS[3]);
    txHash = (await chain.registerDevice(mnemonic, registry, deviceId, key)).txHash;
    d = await chain.getDevice(mnemonic, registry, deviceId);
  } else {
    progress(4, total, REGISTER_STEPS[3]);
  }
  if (d.status !== 1 || d.keyHash.toLowerCase() !== key.keyHash.toLowerCase()) {
    throw new Error(`camera "${label}" is already registered with another key or revoked. Choose another camera name.`);
  }
  return { deviceId, txHash, keyVersion: d.keyVersion };
}

// ---------------------------------------------------------------- finish

/** Public facts about this box. Safe to show, mode 644. */
export interface AccountInfo {
  device: string;
  deviceId: Hex;
  owner: Address;
  qor1: string;
  registry: Address;
  plan: Plan;
  keyFingerprint: string;
  registeredTx?: Hex;
  setupAt: string;
}

export function readAccountInfo(p: Paths): AccountInfo | undefined {
  try {
    return JSON.parse(readFileSync(p.accountJson, "utf8")) as AccountInfo;
  } catch {
    return undefined;
  }
}

export function finishSetup(p: Paths, info: AccountInfo): void {
  writePublicJson(p.accountJson, info);
  writeFileSync(p.done, `${info.setupAt}\n`, { mode: 0o644 });
}

export const isSetupDone = (p: Paths) => existsSync(p.done);
