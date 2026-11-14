/**
 * The exact bytes that ML-DSA-87 keys sign. Must match AnchorRegistry and
 * DeviceRegistry (abi.encodePacked) byte for byte.
 */
import { encodePacked, keccak256, toBytes, toHex, type Address, type Hex } from "viem";

export const DOMAIN: Hex = keccak256(toBytes("QoreWitness/AnchorRegistry/v3"));
export const REGISTER_TAG: Hex = keccak256(toBytes("QoreWitness/DeviceRegistry/register/v1"));
export const REVOKE_TAG: Hex = keccak256(toBytes("QoreWitness/DeviceRegistry/revoke/v1"));
export const ROTATE_TAG: Hex = keccak256(toBytes("QoreWitness/DeviceRegistry/rotate/v1"));

export interface WindowClaim {
  owner: Address;
  deviceId: Hex; // bytes32
  windowStart: bigint; // unix seconds
  windowSeconds: number;
  leafCount: number;
  root: Hex; // bytes32, Merkle root over the segment links
  prevRoot: Hex; // bytes32, root of the previous window of the device, zero for the first
  refBlock: bigint; // a recent block number
  refBlockHash: Hex; // its hash: nobody knows it before the block exists
}

export const ZERO32: Hex = `0x${"00".repeat(32)}`;

/** Window message, signed by the device key. 256 bytes. */
export function signingMessage(chainId: bigint, registry: Address, w: WindowClaim): Uint8Array {
  return toBytes(
    encodePacked(
      ["bytes32", "uint256", "address", "address", "bytes32", "uint64", "uint32", "uint32", "bytes32", "bytes32", "uint64", "bytes32"],
      [DOMAIN, chainId, registry, w.owner, w.deviceId, w.windowStart, w.windowSeconds, w.leafCount, w.root, w.prevRoot, w.refBlock, w.refBlockHash],
    ),
  );
}

/** Register message, signed by the owner key and by the new device key. */
export function registerMessage(
  chainId: bigint, registry: Address, owner: Address, deviceId: Hex, keyHash: Hex, nonce: bigint,
): Uint8Array {
  return toBytes(
    encodePacked(
      ["bytes32", "uint256", "address", "address", "bytes32", "bytes32", "uint256"],
      [REGISTER_TAG, chainId, registry, owner, deviceId, keyHash, nonce],
    ),
  );
}

/** Revoke message, signed by the owner key. */
export function revokeMessage(chainId: bigint, registry: Address, owner: Address, deviceId: Hex, nonce: bigint): Uint8Array {
  return toBytes(
    encodePacked(
      ["bytes32", "uint256", "address", "address", "bytes32", "uint256"],
      [REVOKE_TAG, chainId, registry, owner, deviceId, nonce],
    ),
  );
}

/** Rotate message, signed by the old and by the new device key. */
export function rotateMessage(
  chainId: bigint, registry: Address, owner: Address, deviceId: Hex, oldKeyHash: Hex, newKeyHash: Hex, nonce: bigint,
): Uint8Array {
  return toBytes(
    encodePacked(
      ["bytes32", "uint256", "address", "address", "bytes32", "bytes32", "bytes32", "uint256"],
      [ROTATE_TAG, chainId, registry, owner, deviceId, oldKeyHash, newKeyHash, nonce],
    ),
  );
}

/** keccak256 of a device public key, as stored on chain. */
export const keyHashOf = (pubkey: Uint8Array | Hex): Hex => keccak256(pubkey);

/** deviceId = keccak256 of a human label such as "front-door". */
export function deviceIdOf(label: string): Hex {
  return keccak256(toBytes(`QoreWitness/device/${label}`));
}

export const hex = (b: Uint8Array): Hex => toHex(b);
