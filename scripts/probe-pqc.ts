/**
 * probe-pqc.ts - check the live pqcVerify precompile on testnet with eth_call.
 * No account, no window, no funds needed. Answers: does it accept deterministic
 * and hedged ML-DSA-87 signatures with an empty context, and how does it react
 * to bad input (false or revert)?
 *
 * Usage: pnpm tsx scripts/probe-pqc.ts
 */
import { mldsa } from "@qorechain/pqc";
import { createPublicClient, encodeFunctionData, decodeFunctionResult, http, toHex, type Hex } from "viem";

const RPC = process.env.QORE_EVM_RPC ?? "https://evm-testnet.qore.host";
const PQC_VERIFY = "0x0000000000000000000000000000000000000a01" as const;
const ABI = [
  {
    type: "function",
    name: "pqcVerify",
    stateMutability: "view",
    inputs: [
      { name: "pubkey", type: "bytes" },
      { name: "signature", type: "bytes" },
      { name: "message", type: "bytes" },
    ],
    outputs: [{ name: "valid", type: "bool" }],
  },
] as const;

const client = createPublicClient({ transport: http(RPC) });

async function probe(label: string, pk: Uint8Array, sig: Uint8Array, msg: Uint8Array): Promise<void> {
  const data = encodeFunctionData({ abi: ABI, functionName: "pqcVerify", args: [toHex(pk), toHex(sig), toHex(msg)] });
  try {
    const gas = await client.estimateGas({ to: PQC_VERIFY, data }).catch(() => undefined);
    const ret = (await client.call({ to: PQC_VERIFY, data })).data as Hex | undefined;
    if (!ret || ret === "0x") {
      console.log(`${label}: empty return (precompile inactive?)`);
      return;
    }
    const valid = decodeFunctionResult({ abi: ABI, functionName: "pqcVerify", data: ret });
    console.log(`${label}: ${valid}  (gas estimate ${gas ?? "n/a"})`);
  } catch (err) {
    console.log(`${label}: REVERT ${(err as Error).message.split("\n")[0]}`);
  }
}

const { publicKey, secretKey } = mldsa.keygen();
const msg = new TextEncoder().encode("QoreWitness probe " + new Date().toISOString());
const det = mldsa.sign(secretKey, msg);
const hed = mldsa.sign(secretKey, msg, { hedged: true });
const bad = det.slice();
bad[100] ^= 0x01;

await probe("deterministic valid", publicKey, det, msg);
await probe("hedged valid", publicKey, hed, msg);
await probe("tampered signature", publicKey, bad, msg);
await probe("other message", publicKey, det, new TextEncoder().encode("other"));
await probe("short signature", publicKey, det.slice(0, 100), msg);
await probe("empty message", publicKey, mldsa.sign(secretKey, new Uint8Array()), new Uint8Array());
