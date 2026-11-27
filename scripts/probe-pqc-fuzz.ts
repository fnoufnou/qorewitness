/**
 * probe-pqc-fuzz.ts - mutation fuzz of the LIVE pqcVerify precompile (eth_call only).
 * No account, no key, no funds, no transaction.
 *
 * 1. Positive controls: fresh valid ML-DSA-87 signatures (deterministic and hedged) must return true.
 *    If one does not, the run stops. A dead precompile must not look like "all forgeries rejected".
 * 2. Negative cases (seeded, reproducible): bit flips over the whole signature, the public key and the
 *    message, other key, other message, truncated and extended input, zero and 0xff signatures,
 *    swapped arguments, wrong lengths, empty inputs. Each must return false or revert, never true.
 *
 * An RPC error is not a pass: it is retried, and if it persists the case counts as "not run".
 * Exit code: 0 ok, 2 positive control failed, 3 a mutated input was accepted, 4 too many cases not run,
 * 5 the RPC is not reachable.
 *
 * Usage: pnpm probe:pqc:fuzz [--seed N] [--cases N] [--report file.md] [--rpc url]
 */
import { writeFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import { commandLine, DEFAULT_RPC, parseCli, parseIntArg } from "../src/live/cli.js";
import { exitCodeOf, MAX_NOT_RUN_SHARE, runFuzz } from "../src/live/fuzz.js";
import { MIN_CASES } from "../src/live/mutate.js";
import { gitCommit, renderFuzzReport } from "../src/live/report.js";
import { createRpc, RpcDownError } from "../src/live/rpc.js";

const argv = process.argv.slice(2);
const args = parseCli(argv, { seed: { type: "string" }, cases: { type: "string" } });
const seed = parseIntArg("seed", args.seed, randomInt(1, 2 ** 32), 0, 2 ** 32 - 1);
const cases = parseIntArg("cases", args.cases, 300, MIN_CASES, 5000);
const rpcUrl = args.rpc ?? process.env.QORE_EVM_RPC ?? DEFAULT_RPC;
const rpc = createRpc({ url: rpcUrl, minGapMs: 40 });
const t0 = Date.now();

try {
  const chainId = Number(BigInt((await rpc.request("eth_chainId", [])) as string));
  const block = BigInt((await rpc.request("eth_blockNumber", [])) as string);
  const startedAt = new Date().toISOString();
  console.log(`pqcVerify fuzz on chain ${chainId}, block ${block}, ${startedAt}`);
  console.log(`seed ${seed}, ${cases} cases (rerun: pnpm probe:pqc:fuzz --seed ${seed} --cases ${cases})`);
  const summary = await runFuzz(rpc, {
    seed, cases, concurrency: 3,
    onProgress: (d, n) => { if (d % 50 === 0 || d === n) console.log(`  ${d}/${n} cases`); },
  });
  for (const c of summary.controls) console.log(`control ${c.label}: ${c.observed} -> ${c.verdict}${c.detail ? ` (${c.detail})` : ""}`);
  if (summary.aborted) console.log("ABORT: a positive control failed. The negative cases were not run, because the result would mean nothing.");
  for (const [k, v] of Object.entries(summary.perClass)) {
    console.log(`${k.padEnd(18)} cases ${String(v.total).padStart(3)}  false ${String(v.false).padStart(3)}  revert ${String(v.revert).padStart(3)}  ACCEPTED ${v.accepted}  not run ${v.notRun}`);
  }
  for (const [k, v] of Object.entries(summary.perRegion)) console.log(`sig region ${k.padEnd(14)} cases ${v.total}  accepted ${v.accepted}  not run ${v.notRun}`);
  const code = exitCodeOf(summary);
  const total = summary.results.length;
  const sum = (k: "false" | "revert" | "accepted" | "notRun") => Object.values(summary.perClass).reduce((n, x) => n + x[k], 0);
  console.log(`\nSUMMARY: ${total} negative cases, false ${sum("false")}, revert ${sum("revert")}, accepted ${sum("accepted")}, not run ${sum("notRun")} (limit ${MAX_NOT_RUN_SHARE * 100}%), controls ${summary.controlsOk ? "all true" : "FAILED"}, exit ${code}`);
  if (summary.forgeries.length > 0) {
    console.log("CRITICAL: pqcVerify returned true for a mutated input:");
    for (const f of summary.forgeries) console.log(`  case ${f.id} ${f.cls}: ${f.label}`);
  }
  if (args.report) {
    const md = renderFuzzReport({
      meta: { startedAt, chainId, blockNumber: block, rpc: rpcUrl, commit: gitCommit(), command: commandLine("probe:pqc:fuzz", argv) },
      seed, cases, summary, durationMs: Date.now() - t0, exitCode: code,
    });
    writeFileSync(args.report, md);
    console.log(`report written to ${args.report}`);
  }
  process.exitCode = code;
} catch (err) {
  console.error(err instanceof RpcDownError ? `RPC DOWN: ${err.message}` : `ERROR: ${(err as Error).message}`);
  process.exitCode = err instanceof RpcDownError ? 5 : 1;
}
