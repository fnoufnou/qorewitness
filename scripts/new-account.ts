/**
 * new-account.ts - creates the testnet account for the anchoring agent and writes
 * it to .env (mode 600) if .env has no QORE_MNEMONIC yet. Prints the addresses only.
 * Usage: pnpm tsx scripts/new-account.ts
 */
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { deriveUnifiedAccount, generateMnemonic } from "@qorechain/sdk";

const env = existsSync(".env") ? readFileSync(".env", "utf8") : "";
let mnemonic = /^QORE_MNEMONIC=(.+)$/m.exec(env)?.[1]?.trim();
if (!mnemonic) {
  mnemonic = generateMnemonic(256);
  const rest = env.split("\n").filter((l) => l && !l.startsWith("QORE_MNEMONIC=")).join("\n");
  writeFileSync(".env", `QORE_MNEMONIC=${mnemonic}\n${rest || "QORE_NETWORK=testnet\nQORE_WINDOW_BLOCKS=600\nQORE_WINDOW_TXS=5"}\n`, { mode: 0o600 });
  chmodSync(".env", 0o600);
  console.log("New account written to .env");
}
const a = await deriveUnifiedAccount(mnemonic, 0);
console.log("qor1:", a.cosmos);
console.log("0x:  ", a.evm);
