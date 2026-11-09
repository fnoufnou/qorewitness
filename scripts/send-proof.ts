/**
 * send-proof.ts - sends the Dev Fest "Connect QoreX" proof: 0.000001 QOR to your
 * own testnet address with the exact memo from build.qorechain.io/register.
 * Fallback for when the dashboard or the extension cannot set the memo.
 *
 * Testnet only. Run it on your own computer. The phrase stays in your shell.
 *   QORE_MNEMONIC="word1 ... word24" EXPECT=qor1... MEMO="bbqd-link:..." pnpm tsx scripts/send-proof.ts
 * Add SEND=1 to broadcast. Without it the script only checks the address.
 */
import {
  createClient,
  deriveNativeAccount,
  deriveUnifiedAccount,
  derivePqcCanonical,
  directSignerFromPrivateKey,
} from "@qorechain/sdk";

const mnemonic = process.env.QORE_MNEMONIC?.trim();
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

const client = createClient({ network: "testnet" });
const native = await deriveNativeAccount(mnemonic); // Cosmos path, coin type 118
const unified = await deriveUnifiedAccount(mnemonic, 0); // Ethereum path, coin type 60
console.log("native  (118):", native.address);
console.log("unified (60): ", unified.cosmos);

if (native.address === expect) {
  console.log("Match: native derivation.");
  if (process.env.SEND !== "1") process.exit(0);
  const signer = await directSignerFromPrivateKey(native.privateKey, "qor");
  const pqcKeypair = derivePqcCanonical(native.address, mnemonic);
  const tx = await client.connectTx(signer, { pqcKeypair });
  const res = await tx.bankSend(expect, [{ denom: "uqor", amount: "1" }], { fee: "auto", memo });
  console.log(res);
} else if (unified.cosmos === expect) {
  console.log("Match: unified (Ethereum path) derivation. This script does not send for that path yet.");
  console.log("Tell Claude: the QoreX address uses the Ethereum path.");
} else {
  console.error("No match. The phrase does not belong to the address on the register page. Nothing sent.");
  process.exit(1);
}
