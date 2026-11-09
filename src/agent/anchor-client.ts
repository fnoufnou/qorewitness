/**
 * Signs a window root with the account's ML-DSA-87 key and anchors it in
 * AnchorRegistry. The account is the unified (Ethereum path) account from
 * QORE_MNEMONIC, so its registered PQC key matches what pqcKeyStatus returns.
 */
import { mldsa } from "@qorechain/pqc";
import { deriveUnifiedAccount, type UnifiedAccount } from "@qorechain/sdk";
import {
  createPublicClient, createWalletClient, defineChain, http, parseAbi, toHex, type Address, type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { merkleRoot } from "../core/merkle.js";
import { signingMessage } from "../core/message.js";
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
  "function anchor(bytes32 deviceId, uint64 windowStart, uint32 windowSeconds, uint32 leafCount, bytes32 root, bytes signature) returns (bytes32)",
  "function anchorIdOf(address signer, bytes32 deviceId, uint64 windowStart) view returns (bytes32)",
  "function nextWindowStart(address signer, bytes32 deviceId) view returns (uint64)",
  "event Anchored(bytes32 indexed anchorId, address indexed signer, bytes32 indexed deviceId, uint64 windowStart, uint32 windowSeconds, uint32 leafCount, bytes32 root, bytes32 sigHash)",
]);

export interface AnchorResult {
  txHash: Hex;
  anchorId: Hex;
  blockNumber: bigint;
  blockTime: bigint;
  root: Hex;
  signature: Hex;
  gasUsed: bigint;
}

export class AnchorClient {
  private constructor(
    readonly account: UnifiedAccount,
    readonly registry: Address,
    private readonly pub: ReturnType<typeof createPublicClient>,
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

  async anchorWindow(deviceId: Hex, w: Window): Promise<AnchorResult> {
    const root = toHex(merkleRoot(w.segments.map((s) => s.sha256)));
    const chainId = BigInt(await this.pub.getChainId());
    const msg = signingMessage(chainId, this.registry, {
      signer: this.address, deviceId, windowStart: w.windowStart,
      windowSeconds: w.windowSeconds, leafCount: w.segments.length, root,
    });
    const sigBytes = mldsa.sign(this.account.pqc.secretKey, msg);
    if (!mldsa.verify(this.account.pqc.publicKey, msg, sigBytes)) throw new Error("local ML-DSA self-check failed");
    const signature = toHex(sigBytes);
    const args = [deviceId, w.windowStart, w.windowSeconds, w.segments.length, root, signature] as const;
    // Simulate first: a revert reason is clearer here than after broadcast.
    const { request } = await this.pub.simulateContract({
      address: this.registry, abi: REGISTRY_ABI, functionName: "anchor", args, account: this.wallet.account!,
    });
    const txHash = await this.wallet.writeContract(request);
    const rcpt = await this.pub.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (rcpt.status !== "success") throw new Error(`anchor tx ${txHash} reverted`);
    const block = await this.pub.getBlock({ blockNumber: rcpt.blockNumber });
    const anchorId = await this.pub.readContract({
      address: this.registry, abi: REGISTRY_ABI, functionName: "anchorIdOf", args: [this.address, deviceId, w.windowStart],
    });
    return { txHash, anchorId, blockNumber: rcpt.blockNumber, blockTime: block.timestamp, root, signature, gasUsed: rcpt.gasUsed };
  }
}
