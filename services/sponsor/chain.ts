/**
 * Chain access for the sponsor service. Two small interfaces, so tests can mock
 * the chain and never send a transaction:
 *
 * - ChainReader: read-only calls (registry state, balances, chain ids).
 * - Payer: the hot wallet. One hybrid-signed native MsgSend per top-up, the same
 *   send path as `scripts/qday-drill.ts` (fund, self-send) via src/agent/bank.ts.
 */
import { deriveUnifiedAccount, evmToQor, type UnifiedAccount } from "@qorechain/sdk";
import {
  createPublicClient, getAddress, http, parseAbi, type Address, type Hex,
} from "viem";
import { qorechainTestnet, REGISTRY_ABI } from "../../src/agent/anchor-client.js";
import { balanceUqor, finalCode, hybridBankSend, type NativeNet } from "../../src/agent/bank.js";
import { PILOT_CHAIN_ID, PILOT_COSMOS_CHAIN_ID, type SponsorConfig } from "./config.js";

export interface DeviceInfo {
  keyHash: Hex;
  status: "none" | "active" | "revoked";
}

export interface ChainReader {
  evmChainId(): Promise<number>;
  cosmosChainId(): Promise<string>;
  getDevice(owner: Address, deviceId: Hex): Promise<DeviceInfo>;
  anchorCount(owner: Address, deviceId: Hex): Promise<bigint>;
  /** End (unix seconds) of the last anchored window of the device, 0 if none. */
  lastWindowEnd(owner: Address, deviceId: Hex): Promise<number>;
  balanceUqor(owner: Address): Promise<bigint>;
}

export interface Payer {
  /** The hot wallet's EVM address (public). */
  address(): Address;
  floatUqor(): Promise<bigint>;
  /** Sends uqor to the owner. Throws when the result is unknown. Returns ok=false when the chain refused it. */
  pay(owner: Address, uqor: bigint): Promise<{ ok: boolean; txHash: string; code: number }>;
}

/** Throws unless the EVM chain id is 9800 and the Cosmos network is qorechain-diana. */
export async function assertPilotChain(chain: ChainReader): Promise<void> {
  const evm = await chain.evmChainId();
  if (evm !== PILOT_CHAIN_ID) throw new Error(`refusing to run: EVM chain id ${evm}, expected ${PILOT_CHAIN_ID} (testnet only)`);
  const cosmos = await chain.cosmosChainId();
  if (cosmos !== PILOT_COSMOS_CHAIN_ID) {
    throw new Error(`refusing to run: network ${cosmos}, expected ${PILOT_COSMOS_CHAIN_ID} (testnet only)`);
  }
}

const EXTRA_ABI = parseAbi([
  "function anchorCount(address owner, bytes32 deviceId) view returns (uint256)",
  "function nextWindowStart(address owner, bytes32 deviceId) view returns (uint64)",
]);
const STATUS = ["none", "active", "revoked"] as const;

export class RpcChainReader implements ChainReader {
  private readonly pub;

  constructor(private readonly cfg: SponsorConfig) {
    this.pub = createPublicClient({ chain: qorechainTestnet, transport: http(cfg.evmRpc) });
  }

  async evmChainId(): Promise<number> {
    return this.pub.getChainId();
  }

  async cosmosChainId(): Promise<string> {
    const res = await fetch(`${this.cfg.rest}/cosmos/base/tendermint/v1beta1/node_info`);
    if (!res.ok) throw new Error(`node_info failed: HTTP ${res.status}`);
    const b = (await res.json()) as { default_node_info?: { network?: string } };
    return b.default_node_info?.network ?? "";
  }

  async getDevice(owner: Address, deviceId: Hex): Promise<DeviceInfo> {
    const d = await this.pub.readContract({ address: this.cfg.registry, abi: REGISTRY_ABI, functionName: "getDevice", args: [owner, deviceId] });
    return { keyHash: d.keyHash, status: STATUS[d.status] ?? "none" };
  }

  async anchorCount(owner: Address, deviceId: Hex): Promise<bigint> {
    return this.pub.readContract({ address: this.cfg.registry, abi: EXTRA_ABI, functionName: "anchorCount", args: [owner, deviceId] });
  }

  async lastWindowEnd(owner: Address, deviceId: Hex): Promise<number> {
    return Number(await this.pub.readContract({ address: this.cfg.registry, abi: EXTRA_ABI, functionName: "nextWindowStart", args: [owner, deviceId] }));
  }

  async balanceUqor(owner: Address): Promise<bigint> {
    return balanceUqor(this.cfg.rest, evmToQor(owner));
  }
}

/** The hot wallet. Holds the unified account in memory only. Never log this object. */
export class HybridPayer implements Payer {
  private constructor(private readonly acc: UnifiedAccount, private readonly net: NativeNet) {}

  static async create(mnemonic: string, cfg: SponsorConfig): Promise<HybridPayer> {
    const acc = await deriveUnifiedAccount(mnemonic, 0);
    return new HybridPayer(acc, { chainId: PILOT_COSMOS_CHAIN_ID, rest: cfg.rest, rpc: cfg.rpc });
  }

  address(): Address {
    return getAddress(this.acc.evm);
  }

  async floatUqor(): Promise<bigint> {
    return balanceUqor(this.net.rest, this.acc.cosmos);
  }

  async pay(owner: Address, uqor: bigint): Promise<{ ok: boolean; txHash: string; code: number }> {
    const r = await hybridBankSend(this.acc, evmToQor(owner), uqor, this.net);
    if (r.code !== 0) return { ok: false, txHash: r.transactionHash, code: r.code };
    const fin = await finalCode(this.net.rest, r.transactionHash);
    if (fin && fin.code !== 0) return { ok: false, txHash: r.transactionHash, code: fin.code };
    return { ok: true, txHash: r.transactionHash, code: 0 };
  }

  toJSON(): string {
    return `HybridPayer(${this.acc.evm})`;
  }
}
