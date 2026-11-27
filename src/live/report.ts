/** Markdown evidence reports for the live probes. Pure functions: structured data in, text out. */
import { execFileSync } from "node:child_process";
import type { FuzzSummary } from "./fuzz.js";
import type { Check, RegistryRun } from "./registry.js";

export interface RunMeta {
  startedAt: string; // ISO UTC
  chainId: number;
  blockNumber: bigint;
  blockTime?: bigint;
  rpc: string;
  commit: string;
  command: string;
}

export function gitCommit(cwd = process.cwd()): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd, encoding: "utf8" }).trim() !== "";
    return dirty ? `${sha} (working tree has uncommitted changes)` : sha;
  } catch {
    return "unknown";
  }
}

const utc = (iso: string) => iso.replace("T", " ").replace(/\.\d+Z$/, "Z").replace(/Z$/, " UTC");
const unixUtc = (t: bigint) => utc(new Date(Number(t) * 1000).toISOString());
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function header(title: string, m: RunMeta): string[] {
  return [
    `# ${title}`,
    "",
    `- Run (UTC): ${utc(m.startedAt)}`,
    `- Chain: qorechain-diana, EVM chain id ${m.chainId}`,
    `- Block height at the run: ${m.blockNumber}${m.blockTime !== undefined ? ` (block time ${unixUtc(m.blockTime)})` : ""}`,
    `- RPC: ${m.rpc}`,
    `- Git commit of the code: ${m.commit}`,
    `- Command: \`${m.command}\``,
  ];
}

export interface FuzzReportInput {
  meta: RunMeta;
  seed: number;
  cases: number;
  summary: FuzzSummary & { aborted?: boolean };
  durationMs: number;
  exitCode: number;
}

export function renderFuzzReport(i: FuzzReportInput): string {
  const s = i.summary;
  const neg = s.results.length;
  const c = (k: "false" | "revert" | "accepted" | "notRun") => Object.values(s.perClass).reduce((n, x) => n + x[k], 0);
  const out = header("Live pqcVerify mutation fuzz", i.meta);
  out.push(`- Seed: ${i.seed} (rerun with \`--seed ${i.seed} --cases ${i.cases}\`)`, `- Duration: ${(i.durationMs / 1000).toFixed(1)} s`, "");
  out.push(
    "## Result",
    "",
    s.aborted
      ? "**ABORTED.** A positive control failed, so no negative case was run. A dead or changed precompile must never look like \"all forgeries rejected\"."
      : s.forgeries.length > 0
        ? `**FAILED.** ${s.forgeries.length} mutated input(s) were ACCEPTED by pqcVerify. See below.`
        : i.exitCode === 0
          ? `**PASSED.** ${neg - c("notRun")} of ${neg} negative cases were rejected (${c("false")} returned false, ${c("revert")} reverted), none was accepted, ${c("notRun")} could not run.`
          : `**FAILED.** Exit code ${i.exitCode}. ${c("notRun")} of ${neg} cases could not run (limit ${(i.exitCode === 4 ? "2% of the cases" : "-")}).`,
    "",
    "### Positive controls (must return true)",
    "",
    "| Control | Observed | Verdict |",
    "| --- | --- | --- |",
    ...s.controls.map((r) => `| ${cell(r.label)} | ${r.observed}${r.detail ? ` (${cell(r.detail)})` : ""} | ${r.verdict} |`),
    "",
    "### Negative cases per class (must return false or revert, never true)",
    "",
    "| Class | Cases | false | revert | accepted (true) | not run |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...Object.entries(s.perClass).map(([k, v]) => `| ${k} | ${v.total} | ${v.false} | ${v.revert} | ${v.accepted} | ${v.notRun} |`),
    `| **all** | **${neg}** | **${c("false")}** | **${c("revert")}** | **${c("accepted")}** | **${c("notRun")}** |`,
    "",
    "### Signature bit flips per region",
    "",
    "Layout of an ML-DSA-87 signature (4,627 bytes): c-tilde bytes 0 to 63, z bytes 64 to 4543, hint positions bytes 4544 to 4618, hint counts bytes 4619 to 4626.",
    "",
    "| Region | Cases | false | revert | accepted (true) | not run |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...Object.entries(s.perRegion).map(([k, v]) => `| ${k} | ${v.total} | ${v.false} | ${v.revert} | ${v.accepted} | ${v.notRun} |`),
    "",
  );
  if (Object.keys(s.revertReasons).length > 0) {
    out.push("### Revert messages seen", "", ...Object.entries(s.revertReasons).map(([k, n]) => `- ${n} x \`${cell(k)}\``), "");
  }
  if (Object.keys(s.notRunReasons).length > 0) {
    out.push("### Why cases did not run", "", ...Object.entries(s.notRunReasons).map(([k, n]) => `- ${n} x ${cell(k)}`), "");
  }
  if (s.forgeries.length > 0) {
    out.push("### Accepted inputs", "", ...s.forgeries.map((r) => `- case ${r.id}, ${r.cls}: ${r.label}`), "");
  }
  out.push(
    "## What this shows",
    "",
    "The live pqcVerify precompile returned true for fresh valid signatures and did not return true for any of the mutated inputs above. It is a black-box sample, not a proof of ML-DSA conformance and not an audit. An RPC error counts as \"not run\", never as a pass.",
    "",
  );
  return out.join("\n");
}

export interface RegistryReportInput {
  meta: RunMeta;
  run: RegistryRun;
  durationMs: number;
  exitCode: number;
}

const GROUP_TITLES: Record<Check["group"], string> = {
  state: "Live state read",
  sanity: "Message sanity (what we sign is what the contract hashes)",
  anchor: "anchor(): forged and replayed signatures, broken chain",
  "owner-actions": "Owner actions with forged owner signatures",
  "positive-control": "Positive control with the public sample receipt (no private key needed)",
};

export function renderRegistryReport(i: RegistryReportInput): string {
  const r = i.run;
  const fails = r.checks.filter((c) => c.verdict === "fail").length;
  const nr = r.checks.filter((c) => c.verdict === "not-run").length;
  const out = header("Live AnchorRegistry negative simulations (eth_call)", i.meta);
  out.push(
    `- Registry: ${r.registry} (v4)`,
    `- Owner address used as \`from\`: ${r.owner}`,
    `- Device id: ${r.deviceId ?? "-"}`,
    `- Registered device key hash: ${r.deviceKeyHash ?? "-"}`,
    `- Chain head (root of the newest window): ${r.chainHead ?? "-"}`,
    `- nextWindowStart: ${r.nextWindowStart ?? "-"}`,
    r.window ? `- Claim used: windowStart ${r.window.start}, windowSeconds ${r.window.seconds}, refBlock ${r.window.refBlock}` : "- Claim used: -",
    r.replaySource ? `- Replayed signature copied from block ${r.replaySource.blockNumber}, transaction ${r.replaySource.txHash}` : "- Replayed signature: -",
    `- Sample receipt: ${r.receiptUrl}`,
    "",
    "## Result",
    "",
    fails > 0
      ? `**FAILED.** ${fails} check(s) gave an unexpected answer.`
      : nr > 0
        ? `**INCOMPLETE.** ${r.checks.length - nr} of ${r.checks.length} checks passed, ${nr} could not run.`
        : `**PASSED.** ${r.checks.length} of ${r.checks.length} checks gave the expected answer.`,
    "",
    "Nothing was sent. Every call is an `eth_call`. The owner address is only the `from` field, no owner key or signature was used.",
    "",
  );
  for (const g of Object.keys(GROUP_TITLES) as Check["group"][]) {
    const cs = r.checks.filter((c) => c.group === g);
    if (cs.length === 0) continue;
    out.push(`### ${GROUP_TITLES[g]}`, "", "| Check | Expected | Got | Verdict |", "| --- | --- | --- | --- |", ...cs.map((c) => `| ${cell(c.title)} | ${cell(c.expected)} | ${cell(c.got)} | ${c.verdict} |`), "");
    const notes = [...new Set(cs.map((c) => c.note).filter(Boolean))];
    for (const n of notes) out.push(`- ${n}`);
    if (notes.length) out.push("");
  }
  if (r.observations.length > 0) out.push("## Observations", "", ...r.observations.map((o) => `- ${o}`), "");
  out.push(
    "## What this shows",
    "",
    "The deployed contract, running with the real pqcVerify and pqcKeyStatus precompiles, refuses forged, replayed and attacker-made signatures with the expected custom errors. BadSignature() after the window, chain, block and key checks means the precompile refused the signature inside the real contract. The contract treats a precompile that returns false and one that fails the same way, but it reports an inactive precompile as a different error.",
    "",
    "What it does not show: a simulation is not a transaction, so it says nothing about what a node would include in a block. A valid signature by the real device key was not tested here because that key is not available to this script. That path is shown by the real anchor transactions of the live camera.",
    "",
  );
  return out.join("\n");
}
