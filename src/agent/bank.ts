/**
 * Native-lane bank helpers (testnet only): account sequence, uqor balance, final tx
 * code, and one hybrid-signed (secp256k1 + ML-DSA-87) MsgSend. Shared by the Q-Day
 * drill (`fund`, `self-send`) and the sponsor service. A hybrid MsgSend needs no
 * EVM window.
 */
import { StargateClient } from "@cosmjs/stargate";
import { EthNativeSigner, type UnifiedAccount } from "@qorechain/sdk";

export interface NativeNet {
  chainId: string; // Cosmos chain id, qorechain-diana
  rest: string;
  rpc: string;
}

export const TESTNET_NATIVE: NativeNet = {
  chainId: "qorechain-diana",
  rest: "https://api-testnet.qore.host",
  rpc: "https://rpc-testnet.qore.host",
};

export interface Fee {
  amount: { denom: string; amount: string }[];
  gas: string;
}

/** A hybrid MsgSend uses about 190,000 gas. Minimum gas price 0.1 uqor: 250,000 gas, 0.025 QOR. */
export const FEE_HYBRID_SEND: Fee = { amount: [{ denom: "uqor", amount: "25000" }], gas: "250000" };

export async function accountSequence(rest: string, address: string) {
  const res = await fetch(`${rest}/cosmos/auth/v1beta1/accounts/${address}`);
  if (!res.ok) throw new Error(`account query failed: HTTP ${res.status}`);
  const body = (await res.json()) as { account?: Record<string, unknown> };
  const acc = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
  return { accountNumber: BigInt(acc.account_number ?? "0"), sequence: BigInt(acc.sequence ?? "0") };
}

export async function balanceUqor(rest: string, qor1: string): Promise<bigint> {
  const res = await fetch(`${rest}/cosmos/bank/v1beta1/balances/${qor1}`);
  if (!res.ok) throw new Error(`balance query failed: HTTP ${res.status}`);
  const body = (await res.json()) as { balances?: { denom: string; amount: string }[] };
  return BigInt(body.balances?.find((b) => b.denom === "uqor")?.amount ?? "0");
}

/** Waits for a Cosmos tx and returns its final code (CheckTx can pass, DeliverTx can still fail). */
export async function finalCode(rest: string, hash: string, tries = 10): Promise<{ code: number; log: string } | undefined> {
  for (let i = 0; i < tries; i++) {
    await new Promise((ok) => setTimeout(ok, 2000));
    const res = await fetch(`${rest}/cosmos/tx/v1beta1/txs/${hash}`);
    if (res.ok) {
      const b = (await res.json()) as { tx_response?: { code: number; raw_log: string } };
      if (b.tx_response) return { code: b.tx_response.code, log: b.tx_response.raw_log };
    }
  }
  return undefined;
}

/** Sends `uqor` from `from` to the qor1 address `to`, hybrid signed. Returns the broadcast result. */
export async function hybridBankSend(
  from: UnifiedAccount, to: string, uqor: bigint, net: NativeNet = TESTNET_NATIVE, fee: Fee = FEE_HYBRID_SEND,
): Promise<{ code: number; transactionHash: string }> {
  if (uqor <= 0n) throw new Error("amount must be positive");
  const transport = await StargateClient.connect(net.rpc);
  try {
    const signer = new EthNativeSigner(from, { signMode: "hybrid", rest: net.rest });
    const r = await signer.bankSend(transport, to, [{ denom: "uqor", amount: uqor.toString() }], {
      chainId: net.chainId, ...(await accountSequence(net.rest, from.cosmos)), fee,
    });
    return { code: r.code, transactionHash: r.transactionHash };
  } finally {
    transport.disconnect();
  }
}
