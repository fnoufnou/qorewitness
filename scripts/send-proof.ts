/**
 * send-proof.ts - sends the Dev Fest "Connect QoreX" proof: 0.000001 QOR to your
 * own testnet address with the exact memo from build.qorechain.io/register.
 * Fallback for when the dashboard or the extension cannot set the memo.
 *
 * Testnet only. Start it with scripts/send-proof.sh, which asks for the phrase
 * without showing it and without writing it to the shell history.
 * Env: QORE_MNEMONIC, EXPECT (qor1 address), MEMO (bbqd-link:...), SEND=1 to broadcast.
 */
import { StargateClient } from "@cosmjs/stargate";
import {
  createClient,
  deriveNativeAccount,
  deriveUnifiedAccount,
  derivePqcCanonical,
  directSignerFromPrivateKey,
  EthNativeSigner,
  buildRegisterPqcKeyMsg,
  fetchPqcStatus,
  isRegisteredPqcKey,
  signProofOfPossession,
} from "@qorechain/sdk";

const CHAIN_ID = "qorechain-diana";
const REST = "https://api-testnet.qore.host";
const RPC = "https://rpc-testnet.qore.host";
const AMOUNT = [{ denom: "uqor", amount: "1" }]; // 0.000001 QOR
const FEE = { amount: [{ denom: "uqor", amount: "60000" }], gas: "400000" };

const mnemonic = process.env.QORE_MNEMONIC?.trim().replace(/\s+/g, " ");
const expect = process.env.EXPECT?.trim();
const memo = process.env.MEMO?.trim();
if (!mnemonic || !expect || !memo) {
  console.error("Set QORE_MNEMONIC, EXPECT (your qor1 address) and MEMO (bbqd-link:...)");
  process.exit(1);
}
if (!/^bbqd-link:[A-Za-z0-9]+$/.test(memo)) {
  console.error(`MEMO looks wrong: "${memo}"`);
  process.exit(1);
}
const send = process.env.SEND === "1";

async function accountSequence(address: string) {
  const res = await fetch(`${REST}/cosmos/auth/v1beta1/accounts/${address}`);
  if (!res.ok) throw new Error(`account query failed: HTTP ${res.status}`);
  const body = (await res.json()) as { account?: Record<string, unknown> };
  const acc = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
  return { accountNumber: BigInt(acc.account_number ?? "0"), sequence: BigInt(acc.sequence ?? "0") };
}

const native = await deriveNativeAccount(mnemonic); // Cosmos path, coin type 118
const unified = await deriveUnifiedAccount(mnemonic, 0); // Ethereum path, coin type 60
console.log("native  (118):", native.address);
console.log("unified (60): ", unified.cosmos);

if (native.address === expect) {
  console.log("Match: native derivation.");
  if (!send) process.exit(0);
  const client = createClient({ network: "testnet" });
  const signer = await directSignerFromPrivateKey(native.privateKey, "qor");
  const tx = await client.connectTx(signer, { pqcKeypair: derivePqcCanonical(native.address, mnemonic) });
  console.log(await tx.bankSend(expect, AMOUNT, { fee: FEE, memo }));
} else if (unified.cosmos === expect) {
  console.log("Match: unified (Ethereum path) derivation.");
  if (!send) process.exit(0);
  const transport = await StargateClient.connect(RPC);
  try {
    // A new account first needs its ML-DSA-87 key on chain (the one message allowed classical-only).
    const pqc = await fetchPqcStatus({ rest: REST, address: unified.cosmos });
    if (!pqc.registered) {
      console.log("Registering the post-quantum key first...");
      const pop = signProofOfPossession({ chainId: CHAIN_ID, account: unified.cosmos, keypair: unified.pqc });
      const msg = buildRegisterPqcKeyMsg(unified.cosmos, { pqcKeypair: unified.pqc, proofOfPossession: pop });
      const reg = new EthNativeSigner(unified, { signMode: "classical", rest: REST });
      const r = await reg.signAndBroadcast(transport, {
        chainId: CHAIN_ID,
        ...(await accountSequence(unified.cosmos)),
        fee: { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" },
        messages: [msg],
      });
      console.log("registered:", r.transactionHash);
      await new Promise((ok) => setTimeout(ok, 8000)); // wait for the next block
    } else if (isRegisteredPqcKey(pqc, unified.pqc.publicKey) === false) {
      throw new Error("A different PQC key is registered for this address. Use the wallet that registered it.");
    }
    const signer = new EthNativeSigner(unified, { signMode: "hybrid", rest: REST });
    const seq = await accountSequence(unified.cosmos);
    console.log(await signer.bankSend(transport, expect, AMOUNT, { chainId: CHAIN_ID, ...seq, fee: FEE, memo }));
  } finally {
    transport.disconnect();
  }
} else {
  console.error("No match. The phrase does not belong to the address on the register page. Nothing sent.");
  process.exit(1);
}
console.log("Done. Paste the transactionHash on the register page and press 'I have sent it'.");
