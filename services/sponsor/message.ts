/**
 * The enrol proof: the camera's ML-DSA-87 key signs (empty context) the UTF-8 text
 *
 *   qorewitness-sponsor-v1|9800|<registry>|<deviceId>|<owner>|<nonce>
 *
 * registry, deviceId, owner and nonce are 0x-prefixed lowercase hex (canonical).
 * The checker also accepts EIP-55 checksummed registry and owner, because both
 * spellings name the same address.
 */
import { mldsa } from "@qorechain/pqc";
import { getAddress, hexToBytes, keccak256, type Address, type Hex } from "viem";
import { PILOT_CHAIN_ID } from "./config.js";

export const SPONSOR_DOMAIN = "qorewitness-sponsor-v1";
export const ML_DSA_87_PUBKEY_BYTES = 2592;
export const ML_DSA_87_SIG_BYTES = 4627;

export function sponsorMessageText(registry: string, deviceId: string, owner: string, nonce: string): string {
  return [SPONSOR_DOMAIN, String(PILOT_CHAIN_ID), registry, deviceId, owner, nonce].join("|");
}

/** The bytes the camera signs, in canonical (lowercase) form. */
export function sponsorMessage(registry: Address, deviceId: Hex, owner: Address, nonce: Hex): Uint8Array {
  return new TextEncoder().encode(
    sponsorMessageText(registry.toLowerCase(), deviceId.toLowerCase(), owner.toLowerCase(), nonce.toLowerCase()),
  );
}

/**
 * Checks the signature against the public key that is bound on chain:
 * keccak256(pubkey) must equal the device key hash from the registry.
 */
export function verifySponsorSignature(args: {
  registry: Address; deviceId: Hex; owner: Address; nonce: Hex; signature: Hex; devicePubkey: Hex; onChainKeyHash: Hex;
}): boolean {
  const { registry, deviceId, owner, nonce, signature, devicePubkey, onChainKeyHash } = args;
  const pub = hexToBytes(devicePubkey);
  const sig = hexToBytes(signature);
  if (pub.length !== ML_DSA_87_PUBKEY_BYTES || sig.length !== ML_DSA_87_SIG_BYTES) return false;
  if (keccak256(pub).toLowerCase() !== onChainKeyHash.toLowerCase()) return false;
  const d = deviceId.toLowerCase();
  const n = nonce.toLowerCase();
  const variants = new Set([
    sponsorMessageText(registry.toLowerCase(), d, owner.toLowerCase(), n),
    sponsorMessageText(getAddress(registry), d, getAddress(owner), n),
  ]);
  for (const text of variants) {
    try {
      if (mldsa.verify(pub, new TextEncoder().encode(text), sig)) return true;
    } catch {
      return false;
    }
  }
  return false;
}
