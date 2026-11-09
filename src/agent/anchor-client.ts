/**
 * Client for AnchorRegistry v2 (with DeviceRegistry).
 *
 * - The owner account is the unified (Ethereum path) account from QORE_MNEMONIC.
 *   Its ML-DSA-87 key is the one the chain returns from pqcKeyStatus. It signs
 *   device registration and revocation.
 * - The device key (see device-key.ts) signs window roots and key rotations.
 */
import { deriveUnifiedAccount, type UnifiedAccount } from "@qorechain/sdk";
import {
  createPublicClient, createWalletClient, defineChain, http, parseAbi, toHex, type Address, type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { merkleRoot } from "../core/merkle.js";
import { registerMessage, revokeMessage, rotateMessage, signingMessage } from "../core/message.js";
import { signChecked, type DeviceKey } from "./device-key.js";
import type { Window } from "./window.js";

/** Local chain definition (the @qorechain/evm one is typed against another viem version). */
export const qorechainTestnet = defineChain({
  id: 9800,
  name: "QoreChain Testnet (diana)",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: ["https://evm-testnet.qore.host"] } },
  blockExplorers: { default: { name: "QoreChain Explorer", url: "https://explore.qore.network" } },
  testnet: true,
});

export const REGISTRY_ABI = parseAbi([
  "struct Device { bytes32 keyHash; uint32 keyVersion; uint8 status; uint64 registeredAt; uint64 revokedAt; }",
  "struct Anchor { bytes32 root; bytes32 sigHash; bytes32 deviceKeyHash; address owner; uint32 deviceKeyVersion; uint64 windowStart; uint32 windowSeconds; uint32 leafCount; uint64 anchoredAt; uint64 blockNumber; }",
  "struct Verification { bool found; bool included; bytes32 anchorId; bytes32 root; uint64 windowStart; uint32 windowSeconds; uint32 leafCount; uint64 anchoredAt; uint64 blockNumber; bytes32 deviceKeyHash; uint32 deviceKeyVersion; uint8 deviceStatus; uint64 deviceRevokedAt; }",
  "function anchor(bytes32 deviceId, uint64 windowStart, uint32 windowSeconds, uint32 leafCount, bytes32 root, bytes devicePubkey, bytes signature) returns (bytes32)",
  "function registerDevice(bytes32 deviceId, bytes devicePubkey, bytes ownerSignature, bytes deviceSignature)",
  "function revokeDevice(bytes32 deviceId, bytes ownerSignature)",
  "function rotateDeviceKey(bytes32 deviceId, bytes oldPubkey, bytes newPubkey, bytes oldSignature, bytes newSignature)",
  "function getDevice(address owner, bytes32 deviceId) view returns (Device)",
  "function getAnchor(bytes32 anchorId) view returns (Anchor)",
  "function nonces(address owner) view returns (uint256)",
  "function anchorIdOf(address owner, bytes32 deviceId, uint64 windowStart) view returns (bytes32)",
  "function nextWindowStart(address owner, bytes32 deviceId) view returns (uint64)",
  "function verifySegment(bytes32 anchorId, bytes32 segmentHash, uint256 index, bytes32[] proof) view returns (bool)",
  "function verifyAnchor(address owner, bytes32 deviceId, uint64 windowStart, bytes32 segmentHash, uint256 index, bytes32[] proof) view returns (Verification)",
  "error NoPqcKey(address account)",
  "error PossessionNotProven(address account)",
  "error BadOwnerSignature()",
  "error BadDeviceSignature()",
  "error BadOldKeySignature()",
  "error BadNewKeySignature()",
  "error BadDeviceKey()",
  "error DeviceExists(bytes32 deviceId)",
  "error DeviceNotActive(bytes32 deviceId)",
  "error DeviceKeyMismatch(bytes32 deviceId)",
  "error SameKey()",
  "error EmptyWindow()",
  "error WindowInFuture(uint64 windowEnd, uint64 blockTime)",
  "error WindowOverlap(uint64 windowStart, uint64 nextAllowed)",
  "error BadSignature()",
  "error UnknownAnchor(bytes32 anchorId)",
  "event Anchored(bytes32 indexed anchorId, address indexed owner, bytes32 indexed deviceId, uint64 windowStart, uint32 windowSeconds, uint32 leafCount, bytes32 root, bytes32 sigHash)",
]);

export const DEVICE_STATUS = ["none", "active", "revoked"] as const;

export interface TxResult {
  txHash: Hex;
  blockNumber: bigint;
  blockTime: bigint;
  gasUsed: bigint;
}

export interface AnchorResult extends TxResult {
  anchorId: Hex;
  root: Hex;
  signature: Hex;
}

export class AnchorClient {
  private constructor(
    readonly account: UnifiedAccount,
    readonly registry: Address,
    readonly pub: ReturnType<typeof createPublicClient>,
    private readonly wallet: ReturnType<typeof createWalletClient>,
  ) {}

  static async create(mnemonic: string, registry: Address, rpc = "https://evm-testnet.qore.host") {
    const account = await deriveUnifiedAccount(mnemonic, 0);
    const evm = mnemonicToAccount(mnemonic); // m/44'/60'/0'/0/0, same key as the unified account
    if (evm.address.toLowerCase() !== account.evm.toLowerCase()) {
      throw new Error("viem and QoreChain SDK derive different accounts from the mnemonic");
    }
    const chain = qorechainTestnet;
    const pub = createPublicClient({ chain, transport: http(rpc) });
    const wallet = createWalletClient({ chain, transport: http(rpc), account: evm });
    return new AnchorClient(account, registry, pub, wallet);
  }

  get address(): Address {
    return this.account.evm as Address;
  }

  private async chainId(): Promise<bigint> {
    return BigInt(await this.pub.getChainId());
  }

  private async nonce(): Promise<bigint> {
    return this.pub.readContract({ address: this.registry, abi: REGISTRY_ABI, functionName: "nonces", args: [this.address] });
  }

  /** Simulates first (clear revert reasons), then sends and waits. */
  private async send(
    functionName: "anchor" | "registerDevice" | "revokeDevice" | "rotateDeviceKey",
    args: readonly unknown[],
  ): Promise<TxResult> {
    const { request } = await this.pub.simulateContract({
      address: this.registry, abi: REGISTRY_ABI, functionName, args, account: this.wallet.account!,
    } as never);
    const txHash = await this.wallet.writeContract(request as never);
    const rcpt = await this.pub.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (rcpt.status !== "success") throw new Error(`${functionName} tx ${txHash} reverted`);
    const block = await this.pub.getBlock({ blockNumber: rcpt.blockNumber });
    return { txHash, blockNumber: rcpt.blockNumber, blockTime: block.timestamp, gasUsed: rcpt.gasUsed };
  }

  async getDevice(deviceId: Hex, owner: Address = this.address) {
    return this.pub.readContract({ address: this.registry, abi: REGISTRY_ABI, functionName: "getDevice", args: [owner, deviceId] });
  }

  /** Owner key and device key sign the same register message. */
  async registerDevice(deviceId: Hex, device: DeviceKey): Promise<TxResult> {
    const msg = registerMessage(await this.chainId(), this.registry, this.address, deviceId, device.keyHash, await this.nonce());
    const ownerSig = signChecked(this.account.pqc.publicKey, this.account.pqc.secretKey, msg);
    const deviceSig = signChecked(device.publicKey, device.secretKey, msg);
    return this.send("registerDevice", [deviceId, device.publicKeyHex, ownerSig, deviceSig]);
  }

  /** Owner key signs the revoke message. */
  async revokeDevice(deviceId: Hex): Promise<TxResult> {
    const msg = revokeMessage(await this.chainId(), this.registry, this.address, deviceId, await this.nonce());
    const ownerSig = signChecked(this.account.pqc.publicKey, this.account.pqc.secretKey, msg);
    return this.send("revokeDevice", [deviceId, ownerSig]);
  }

  /** Old and new device key sign the rotate message. */
  async rotateDeviceKey(deviceId: Hex, oldKey: DeviceKey, newKey: DeviceKey): Promise<TxResult> {
    const msg = rotateMessage(
      await this.chainId(), this.registry, this.address, deviceId, oldKey.keyHash, newKey.keyHash, await this.nonce(),
    );
    const oldSig = signChecked(oldKey.publicKey, oldKey.secretKey, msg);
    const newSig = signChecked(newKey.publicKey, newKey.secretKey, msg);
    return this.send("rotateDeviceKey", [deviceId, oldKey.publicKeyHex, newKey.publicKeyHex, oldSig, newSig]);
  }

  /** Device key signs the window root. */
  async anchorWindow(deviceId: Hex, device: DeviceKey, w: Window): Promise<AnchorResult> {
    const root = toHex(merkleRoot(w.segments.map((s) => s.sha256)));
    const msg = signingMessage(await this.chainId(), this.registry, {
      owner: this.address, deviceId, windowStart: w.windowStart,
      windowSeconds: w.windowSeconds, leafCount: w.segments.length, root,
    });
    const signature = signChecked(device.publicKey, device.secretKey, msg);
    const tx = await this.send("anchor", [
      deviceId, w.windowStart, w.windowSeconds, w.segments.length, root, device.publicKeyHex, signature,
    ]);
    const anchorId = await this.pub.readContract({
      address: this.registry, abi: REGISTRY_ABI, functionName: "anchorIdOf", args: [this.address, deviceId, w.windowStart],
    });
    return { ...tx, anchorId, root, signature };
  }
}
