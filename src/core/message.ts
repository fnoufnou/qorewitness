/**
 * The exact bytes a device signs for one window. Must match
 * AnchorRegistry.signingMessage() (abi.encodePacked).
 */
import { encodePacked, keccak256, toBytes, toHex, type Address, type Hex } from "viem";

export const DOMAIN: Hex = keccak256(toBytes("QoreWitness/AnchorRegistry/v1"));

export interface WindowClaim {
  signer: Address;
  deviceId: Hex; // bytes32
  windowStart: bigint; // unix seconds
  windowSeconds: number;
  leafCount: number;
  root: Hex; // bytes32
}

export function signingMessage(chainId: bigint, registry: Address, w: WindowClaim): Uint8Array {
  return toBytes(
    encodePacked(
      ["bytes32", "uint256", "address", "address", "bytes32", "uint64", "uint32", "uint32", "bytes32"],
      [DOMAIN, chainId, registry, w.signer, w.deviceId, w.windowStart, w.windowSeconds, w.leafCount, w.root],
    ),
  );
}

/** deviceId = keccak256 of a human label such as "front-door". */
export function deviceIdOf(label: string): Hex {
  return keccak256(toBytes(`QoreWitness/device/${label}`));
}

export const hex = (b: Uint8Array): Hex => toHex(b);
