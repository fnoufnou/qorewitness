/**
 * Runner and result classifier for the live pqcVerify fuzz.
 *
 * The rule that matters: an RPC error is never a pass. A negative case passes only when the
 * node ran the precompile and it answered false or reverted. If the node could not answer,
 * or answered with empty data (precompile not active), the case is "not run".
 */
import { decodeFunctionResult, encodeFunctionData, parseAbi, toHex, type Hex } from "viem";
import { mldsa } from "@qorechain/pqc";
import { createHash } from "node:crypto";
import { CASE_CLASSES, generateCases, SIG_LEN, type CaseClass, type FuzzCase, type FuzzFixtures, type SigRegion } from "./mutate.js";
import type { CallOutcome, Rpc } from "./rpc.js";

export const PQC_VERIFY = "0x0000000000000000000000000000000000000a01" as const;
const ABI = parseAbi(["function pqcVerify(bytes pubkey, bytes signature, bytes message) view returns (bool)"]);

/** What the node said about one call, reduced to the cases that matter. */
export type Observed = "true" | "false" | "revert" | "empty" | "unexpected" | "rpc-error";
export type Verdict = "pass" | "forgery-accepted" | "control-failed" | "not-run";

export function observe(o: CallOutcome): { observed: Observed; detail?: string } {
  if (o.kind === "rpc-error") return { observed: "rpc-error", detail: o.message };
  if (o.kind === "revert") return { observed: "revert", detail: o.message };
  if (o.data === "0x") return { observed: "empty", detail: "empty return data: precompile not active on this call" };
  try {
    return { observed: decodeFunctionResult({ abi: ABI, functionName: "pqcVerify", data: o.data }) ? "true" : "false" };
  } catch {
    return { observed: "unexpected", detail: `return data is not one bool: ${o.data.slice(0, 80)}` };
  }
}

/** A negative case must be rejected. A positive control must be accepted. Anything else is not a pass. */
export function judge(expect: "reject" | "accept", observed: Observed): Verdict {
  if (observed === "rpc-error" || observed === "empty" || observed === "unexpected") return "not-run";
  if (expect === "reject") return observed === "true" ? "forgery-accepted" : "pass";
  return observed === "true" ? "pass" : "control-failed";
}

export interface CaseResult {
  id: number;
  cls: CaseClass | "positive-control";
  label: string;
  region?: SigRegion;
  expect: "reject" | "accept";
  observed: Observed;
  verdict: Verdict;
  detail?: string;
  inputBytes: { pk: number; sig: number; msg: number };
}

export interface ClassCounts { total: number; false: number; revert: number; accepted: number; notRun: number }

export interface FuzzSummary {
  controls: CaseResult[];
  results: CaseResult[]; // negatives
  perClass: Record<string, ClassCounts>;
  perRegion: Record<string, ClassCounts>;
  revertReasons: Record<string, number>;
  notRunReasons: Record<string, number>;
  forgeries: CaseResult[];
  controlsOk: boolean;
  notRun: number;
  notRunShare: number;
}

export const MAX_NOT_RUN_SHARE = 0.02;

export function emptyCounts(): ClassCounts {
  return { total: 0, false: 0, revert: 0, accepted: 0, notRun: 0 };
}

export function tally(c: ClassCounts, r: CaseResult): void {
  c.total++;
  if (r.verdict === "not-run") c.notRun++;
  else if (r.observed === "true") c.accepted++;
  else if (r.observed === "revert") c.revert++;
  else if (r.observed === "false") c.false++;
}

export function summarize(controls: CaseResult[], results: CaseResult[]): FuzzSummary {
  const perClass: Record<string, ClassCounts> = {};
  const perRegion: Record<string, ClassCounts> = {};
  for (const cls of CASE_CLASSES) perClass[cls] = emptyCounts();
  const revertReasons: Record<string, number> = {};
  const notRunReasons: Record<string, number> = {};
  for (const r of results) {
    tally((perClass[r.cls] ??= emptyCounts()), r);
    if (r.region) tally((perRegion[r.region] ??= emptyCounts()), r);
    if (r.observed === "revert") revertReasons[r.detail ?? "revert"] = (revertReasons[r.detail ?? "revert"] ?? 0) + 1;
    if (r.verdict === "not-run") notRunReasons[r.detail ?? r.observed] = (notRunReasons[r.detail ?? r.observed] ?? 0) + 1;
  }
  const notRun = results.filter((r) => r.verdict === "not-run").length;
  return {
    controls,
    results,
    perClass,
    perRegion,
    revertReasons,
    notRunReasons,
    forgeries: results.filter((r) => r.verdict === "forgery-accepted"),
    controlsOk: controls.length > 0 && controls.every((c) => c.verdict === "pass"),
    notRun,
    notRunShare: results.length === 0 ? 0 : notRun / results.length,
  };
}

/** 0 only when all controls pass, no forgery was accepted and few cases failed to run. */
export function exitCodeOf(s: FuzzSummary): number {
  if (!s.controlsOk) return 2;
  if (s.forgeries.length > 0) return 3;
  if (s.notRunShare > MAX_NOT_RUN_SHARE) return 4;
  return 0;
}

const calldata = (pk: Uint8Array, sig: Uint8Array, msg: Uint8Array): Hex =>
  encodeFunctionData({ abi: ABI, functionName: "pqcVerify", args: [toHex(pk), toHex(sig), toHex(msg)] });

export async function runOne(
  rpc: Pick<Rpc, "ethCall">,
  c: { id: number; cls: CaseResult["cls"]; label: string; region?: SigRegion; pk: Uint8Array; sig: Uint8Array; msg: Uint8Array },
  expect: "reject" | "accept",
): Promise<CaseResult> {
  const o = await rpc.ethCall(PQC_VERIFY, calldata(c.pk, c.sig, c.msg));
  const { observed, detail } = observe(o);
  return {
    id: c.id, cls: c.cls, label: c.label, region: c.region, expect, observed, verdict: judge(expect, observed), detail,
    inputBytes: { pk: c.pk.length, sig: c.sig.length, msg: c.msg.length },
  };
}

/** Runs the items with a small worker pool. Results keep the input order. */
export async function pool<T, R>(items: T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return out;
}

const seedBytes = (seed: number, tag: string): Uint8Array => new Uint8Array(createHash("sha256").update(`qw-fuzz/${seed}/${tag}`).digest());

/** Fixtures from the seed: keys and deterministic signatures are reproducible. */
export function buildFixtures(seed: number): FuzzFixtures {
  const a = mldsa.keygen(seedBytes(seed, "keyA"));
  const b = mldsa.keygen(seedBytes(seed, "keyB"));
  // 256 bytes, like the window message of AnchorRegistry, so the lengths look real.
  const full = new Uint8Array(256);
  for (let i = 0; i < 8; i++) full.set(seedBytes(seed, `msg-1/${i}`).slice(0, 32), i * 32);
  const other = full.slice();
  other[0] ^= 0xff;
  const fx: FuzzFixtures = {
    pk: a.publicKey, msg: full,
    sig: mldsa.sign(a.secretKey, full),
    sigOtherKey: mldsa.sign(b.secretKey, full),
    sigOtherMsg: mldsa.sign(a.secretKey, other),
  };
  if (fx.sig.length !== SIG_LEN) throw new Error(`unexpected signature length ${fx.sig.length}`);
  if (!mldsa.verify(a.publicKey, full, fx.sig)) throw new Error("local self-check of the fixture signature failed");
  return fx;
}

export interface FuzzOptions {
  seed: number;
  cases: number;
  controlKeys?: number; // fresh keypairs for the positive controls
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

/** Positive controls first. If one fails, the negatives are not run: a dead precompile must not look like "all rejected". */
export async function runFuzz(rpc: Pick<Rpc, "ethCall">, o: FuzzOptions): Promise<FuzzSummary & { aborted: boolean }> {
  const controls: CaseResult[] = [];
  const nKeys = o.controlKeys ?? 3;
  let id = 0;
  for (let k = 0; k < nKeys; k++) {
    const kp = mldsa.keygen(seedBytes(o.seed, `control-key-${k}`));
    const m = seedBytes(o.seed, `control-msg-${k}`);
    for (const hedged of [false, true]) {
      const sig = mldsa.sign(kp.secretKey, m, { hedged });
      controls.push(await runOne(rpc, {
        id: id++, cls: "positive-control", label: `key ${k + 1}, ${hedged ? "hedged" : "deterministic"} signature`, pk: kp.publicKey, sig, msg: m,
      }, "accept"));
    }
  }
  if (!controls.every((c) => c.verdict === "pass")) {
    return { ...summarize(controls, []), aborted: true };
  }
  const fx = buildFixtures(o.seed);
  const cases: FuzzCase[] = generateCases(o.seed, o.cases, fx);
  let done = 0;
  const results = await pool(cases, o.concurrency ?? 3, async (c) => {
    const r = await runOne(rpc, c, "reject");
    o.onProgress?.(++done, cases.length);
    return r;
  });
  return { ...summarize(controls, results), aborted: false };
}
