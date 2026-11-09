/**
 * Keeps an EVM authorisation window open that is scoped to the registry only.
 * QoreChain refuses every EVM tx without a live window. Opening one is a
 * hybrid-signed (secp256k1 + ML-DSA-87) native-lane tx, so a stolen ECDSA key
 * alone cannot open a window or send anything.
 */
import { StargateClient } from "@cosmjs/stargate";
import { EthNativeSigner, openEvmWindowMsg, type UnifiedAccount } from "@qorechain/sdk";
import { evmWindowCost, evmWindowStatus } from "@qorechain/evm";

export interface WindowConfig {
  chainId: string; // qorechain-diana
  rest: string;
  rpc: string;
  blocks: bigint; // window length in blocks
  maxTxs: bigint;
  gasPerTx: bigint; // gas limit budget per anchor tx
  maxFeePerGas: bigint; // wei
  minBlocksLeft: bigint; // reopen below this
  minTxsLeft: bigint;
}

export const TESTNET_WINDOW: WindowConfig = {
  chainId: "qorechain-diana",
  rest: "https://api-testnet.qore.host",
  rpc: "https://rpc-testnet.qore.host",
  blocks: 17_280n, // protocol maximum
  maxTxs: 200n,
  gasPerTx: 600_000n,
  maxFeePerGas: 250_000_000_000n,
  minBlocksLeft: 300n,
  minTxsLeft: 2n,
};

const FEE = { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" };

async function accountSequence(rest: string, address: string) {
  const res = await fetch(`${rest}/cosmos/auth/v1beta1/accounts/${address}`);
  if (!res.ok) throw new Error(`account query failed: HTTP ${res.status}`);
  const body = (await res.json()) as { account?: Record<string, unknown> };
  const acc = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
  return { accountNumber: BigInt(acc.account_number ?? "0"), sequence: BigInt(acc.sequence ?? "0") };
}

/** Opens a new scoped window when the current one is missing or nearly used up. Returns true if it opened one. */
export async function ensureScopedWindow(acc: UnifiedAccount, registry: string, cfg = TESTNET_WINDOW): Promise<boolean> {
  const w = await evmWindowStatus({ rest: cfg.rest, address: acc.cosmos });
  if (w.found && w.live && BigInt(w.remainingBlocks) >= cfg.minBlocksLeft && BigInt(w.remainingTxs) >= cfg.minTxsLeft) {
    return false;
  }
  const perTx = evmWindowCost({ gas: cfg.gasPerTx, maxFeePerGas: cfg.maxFeePerGas });
  const msg = openEvmWindowMsg({
    sender: acc.cosmos,
    blocks: cfg.blocks,
    maxTxs: cfg.maxTxs,
    maxValue: perTx * cfg.maxTxs,
    allowedTargets: [registry],
  });
  const signer = new EthNativeSigner(acc, { signMode: "hybrid", rest: cfg.rest });
  const transport = await StargateClient.connect(cfg.rpc);
  try {
    const seq = await accountSequence(cfg.rest, acc.cosmos);
    const res = await signer.signAndBroadcast(transport, { chainId: cfg.chainId, ...seq, fee: FEE, messages: [msg] });
    if (res.code !== 0) throw new Error(`open window failed: code ${res.code} ${res.rawLog ?? ""}`);
  } finally {
    transport.disconnect();
  }
  // Wait until the chain shows the new window.
  for (let i = 0; i < 20; i++) {
    await new Promise((ok) => setTimeout(ok, 2000));
    const n = await evmWindowStatus({ rest: cfg.rest, address: acc.cosmos });
    if (n.found && n.live) return true;
  }
  throw new Error("window not live after opening");
}
