/** Markdown evidence reports for the live probes. Pure functions: structured data in, text out. */
import { execFileSync } from "node:child_process";
import { MAX_NOT_RUN_SHARE, type FuzzSummary } from "./fuzz.js";
import { REGISTRY_EXIT, type Check, type RegistryRun } from "./registry.js";

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
  if (i.exitCode === 0 && !s.aborted) {
    out.push(
      "## What this shows",
      "",
      "The live pqcVerify precompile returned true for fresh valid signatures and did not return true for any of the mutated inputs above. It is a black-box sample. It is no proof of ML-DSA conformance and no audit. An RPC error counts as \"not run\".",
      "",
    );
  } else {
    out.push("## What failed", "");
    for (const c of s.controls.filter((x) => x.verdict !== "pass")) out.push(`- Positive control "${cell(c.label)}" gave ${c.observed}${c.detail ? ` (${cell(c.detail)})` : ""}, expected true.`);
    for (const f of s.forgeries) out.push(`- Mutated input accepted: case ${f.id}, ${f.cls}: ${cell(f.label)}.`);
    if (!s.aborted && s.notRunShare > MAX_NOT_RUN_SHARE) out.push(`- ${s.notRun} of ${neg} cases could not run, more than the limit of ${MAX_NOT_RUN_SHARE * 100}%.`);
    out.push("", "A run that did not pass shows nothing about the precompile. Rerun when the cause is fixed.", "");
  }
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
  control: "Gating positive controls (run first, the run stops if one does not hold)",
  sanity: "Message sanity (what we sign is what the contract hashes)",
  anchor: "anchor(): forged and replayed signatures, broken chain",
  "owner-actions": "Owner actions with forged owner signatures",
  receipt: "Public sample receipt with verifyAnchor (no private key needed)",
};

const EXIT_TEXT: Record<number, string> = {
  [REGISTRY_EXIT.control]: "a gating positive control did not hold",
  [REGISTRY_EXIT.accepted]: "a forged or replayed input was accepted",
  [REGISTRY_EXIT.unexpected]: "a check gave another answer than expected",
  [REGISTRY_EXIT.notRun]: "a check could not run",
};

export function renderRegistryReport(i: RegistryReportInput): string {
  const r = i.run;
  const fails = r.checks.filter((c) => c.verdict === "fail").length;
  const nr = r.checks.filter((c) => c.verdict === "not-run").length;
  const out = header("Live AnchorRegistry negative simulations (eth_call)", i.meta);
  out.push(
    `- Every call and state read used block ${r.blockNumber} (head at the start ${r.headAtStart}, pinned ${r.headAtStart - r.blockNumber} blocks below it)${r.retriedAtFreshBlock ? ". The node did not have the first pinned block, so the run started once more at a fresh block" : ""}`,
    `- Registry: ${r.registry} (v4)`,
    `- Owner address used as \`from\`: ${r.owner}`,
    `- Device id: ${r.deviceId ?? "-"}`,
    `- Registered device key hash: ${r.deviceKeyHash ?? "-"}`,
    r.realAnchor
      ? `- Newest real anchor (used by the controls): block ${r.realAnchor.blockNumber}, transaction ${r.realAnchor.txHash}, anchor id ${r.realAnchor.anchorId}, windowStart ${r.realAnchor.windowStart}`
      : "- Newest real anchor: -",
    `- Chain head (root of the newest window): ${r.chainHead ?? "-"}`,
    `- nextWindowStart: ${r.nextWindowStart ?? "-"}`,
    r.window ? `- Claim used: windowStart ${r.window.start}, windowSeconds ${r.window.seconds}, refBlock ${r.window.refBlock}` : "- Claim used: -",
    r.replaySource ? `- Replayed signature copied from block ${r.replaySource.blockNumber}, transaction ${r.replaySource.txHash}` : "- Replayed signature: -",
    `- Sample receipt: ${r.receiptUrl}`,
    `- Exit code: ${i.exitCode}`,
    "",
    "## Result",
    "",
    r.aborted
      ? "**ABORTED.** A gating positive control did not hold, so the negative simulations were not run."
      : i.exitCode === REGISTRY_EXIT.accepted
        ? "**FAILED.** A forged or replayed input was ACCEPTED. See below."
        : fails > 0
          ? `**FAILED.** ${fails} check(s) gave an unexpected answer.`
          : nr > 0
            ? `**INCOMPLETE.** ${r.checks.length - nr} of ${r.checks.length} checks passed, ${nr} could not run.`
            : `**PASSED.** ${r.checks.length} of ${r.checks.length} checks gave the expected answer.`,
    "",
    "Nothing was sent. Every call is an `eth_call`. The owner address is only the `from` field. No owner key or device key was used.",
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
  if (i.exitCode === REGISTRY_EXIT.ok) {
    out.push(
      "## What this shows",
      "",
      "The gating controls show that the live pqcVerify precompile accepts a fresh valid signature and the real signature of the camera over the exact bytes that the live contract builds, and refuses both with one flipped bit. This is a replay with eth_call of a verification the chain already did when it included the newest anchor. No private key was used.",
      "",
      "The deployed contract, running with the same precompiles, refuses forged, replayed and attacker-made signatures with the expected custom errors. BadSignature() means that the precompile did not accept the signature: it returned false or the call failed. Together with the gating controls in the same run, a dead precompile cannot produce a passing run.",
      "",
      "Limits: a simulation is not a transaction, so it says nothing about what a node would include in a block. The real device key signs only on the camera, so this script cannot make a new valid camera signature. The real anchor transactions of the live camera show that path.",
      "",
    );
  } else {
    out.push("## What failed", "", `Exit code ${i.exitCode}: ${EXIT_TEXT[i.exitCode] ?? "see the checks above"}.`, "");
    for (const c of r.checks.filter((x) => x.verdict !== "pass")) out.push(`- ${cell(c.title)}: expected ${cell(c.expected)}, got ${cell(c.got)} (${c.verdict}${c.accepted ? ", ACCEPTED" : ""}).`);
    if (r.aborted) out.push("- The negative simulations were not run.");
    out.push("", "A run that did not pass shows nothing about the contract. Rerun when the cause is fixed.", "");
  }
  return out.join("\n");
}
