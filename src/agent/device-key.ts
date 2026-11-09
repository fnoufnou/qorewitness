/**
 * Device key: the ML-DSA-87 key that signs window roots for one camera.
 * It is separate from the owner account. The owner registers, revokes and
 * (with the old key) rotates it in the DeviceRegistry.
 *
 * File format: one line, 64 hex characters (the 32-byte ML-DSA-87 keygen seed).
 * The file must not be readable by others (mode 600). Testnet only.
 */
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { mldsa } from "@qorechain/pqc";
import { toHex, type Hex } from "viem";
import { keyHashOf } from "../core/message.js";

export interface DeviceKey {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  publicKeyHex: Hex;
  keyHash: Hex;
}

export function deviceKeyFromSeed(seed: Uint8Array): DeviceKey {
  if (seed.length !== 32) throw new Error("device key seed must be 32 bytes");
  const kp = mldsa.keygen(seed);
  const publicKeyHex = toHex(kp.publicKey);
  return { ...kp, publicKeyHex, keyHash: keyHashOf(kp.publicKey) };
}

export function loadDeviceKey(path: string): DeviceKey {
  if (!existsSync(path)) throw new Error(`device key file ${path} not found (create it with: pnpm device keygen ${path})`);
  if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
    throw new Error(`device key file ${path} is readable by others: chmod 600 it`);
  }
  const text = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(text)) throw new Error(`device key file ${path} must hold 64 hex characters`);
  return deviceKeyFromSeed(Uint8Array.from(Buffer.from(text, "hex")));
}

/** Writes a new random device key. Refuses to overwrite an existing file. */
export function createDeviceKey(path: string): DeviceKey {
  if (existsSync(path)) throw new Error(`${path} exists already, refusing to overwrite`);
  const seed = randomBytes(32);
  writeFileSync(path, seed.toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return deviceKeyFromSeed(seed);
}

/** Signs and self-checks, so a broken key never reaches the chain. */
export function signChecked(publicKey: Uint8Array, secretKey: Uint8Array, message: Uint8Array): Hex {
  const sig = mldsa.sign(secretKey, message);
  if (!mldsa.verify(publicKey, message, sig)) throw new Error("local ML-DSA self-check failed");
  return toHex(sig);
}
