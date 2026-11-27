/**
 * probe-registry-live.ts - negative simulations against the LIVE AnchorRegistry v4, eth_call only.
 * No key, no funds, no transaction. `from` is set to the real owner address (eth_call needs no signature).
 *
 * It reads the live state, builds a window claim that passes every check except the signature, and
 * expects the custom error BadSignature() for a random signature, a real old signature (replay) and a
 * valid ML-DSA-87 signature of a fresh attacker key. It also simulates forged owner actions
 * (BadOwnerSignature), a wrong prevRoot (BrokenChain) and a positive control with the public sample receipt.
 * Exit code: 0 all as expected, 3 a check gave an unexpected answer, 4 a check could not run,
 * 5 the RPC is not reachable, 1 the live state could not be read.
 *
 * Usage: pnpm probe:registry [--report file.md] [--rpc url] [--registry 0x..] [--owner 0x..] [--receipt url]
 */
import { writeFileSync } from "node:fs";
import { commandLine, DEFAULT_RPC, parseCli } from "../src/live/cli.js";
import { DEFAULT_OWNER, DEFAULT_RECEIPT_URL, DEFAULT_REGISTRY, ProbeSetupError, registryExitCode, runRegistryProbe } from "../src/live/registry.js";
import { gitCommit, renderRegistryReport } from "../src/live/report.js";
import { createRpc, RpcDownError } from "../src/live/rpc.js";

const argv = process.argv.slice(2);
const args = parseCli(argv, { registry: { type: "string" }, owner: { type: "string" }, receipt: { type: "string" } });
const rpcUrl = args.rpc ?? process.env.QORE_EVM_RPC ?? DEFAULT_RPC;
const rpc = createRpc({ url: rpcUrl, minGapMs: 100 });
const t0 = Date.now();

async function fetchText(url: string): Promise<string> {
  let last = "";
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) return await res.text();
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** i));
  }
  throw new Error(last);
}

try {
  const run = await runRegistryProbe(rpc, {
    registry: args.registry ?? DEFAULT_REGISTRY, owner: args.owner ?? DEFAULT_OWNER, receiptUrl: args.receipt ?? DEFAULT_RECEIPT_URL, fetchText,
  });
  console.log(`registry ${run.registry} on chain ${run.chainId}, block ${run.blockNumber} (${new Date(Number(run.blockTime) * 1000).toISOString()}), run at ${run.startedAt}`);
  console.log(`owner ${run.owner}, device ${run.deviceId}`);
  console.log(`claim: windowStart ${run.window?.start}, windowSeconds ${run.window?.seconds}, refBlock ${run.window?.refBlock}, chainHead ${run.chainHead}`);
  for (const c of run.checks) console.log(`${c.verdict.toUpperCase().padEnd(7)} ${c.title}\n        expected ${c.expected}, got ${c.got}`);
  for (const o of run.observations) console.log(`NOTE    ${o}`);
  const code = registryExitCode(run);
  const pass = run.checks.filter((c) => c.verdict === "pass").length;
  console.log(`\nSUMMARY: ${pass}/${run.checks.length} checks as expected, exit ${code}`);
  if (args.report) {
    writeFileSync(args.report, renderRegistryReport({
      meta: { startedAt: run.startedAt, chainId: run.chainId, blockNumber: run.blockNumber, blockTime: run.blockTime, rpc: rpcUrl, commit: gitCommit(), command: commandLine("probe:registry", argv) },
      run, durationMs: Date.now() - t0, exitCode: code,
    }));
    console.log(`report written to ${args.report}`);
  }
  process.exitCode = code;
} catch (err) {
  if (err instanceof RpcDownError) {
    console.error(`RPC DOWN: ${err.message}`);
    process.exitCode = 5;
  } else {
    console.error(`${err instanceof ProbeSetupError ? "LIVE STATE" : "ERROR"}: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
