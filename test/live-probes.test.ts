/**
 * Unit tests for the live probes (src/live). No network: the RPC is a mock. The mock for the
 * precompile uses the local ML-DSA verifier as the oracle, so the fuzz runs against a verifier
 * that really rejects mutated input.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, encodeFunctionData, encodeFunctionResult, encodePacked, keccak256, parseAbi,
  toBytes, toHex, type Hex,
} from "viem";
import { mldsa } from "@qorechain/pqc";
import { buildFixtures, exitCodeOf, judge, observe, pool, runFuzz, summarize, type CaseResult } from "../src/live/fuzz.js";
import {
  CASE_CLASSES, flipBit, generateCases, MIN_CASES, PK_LEN, SIG_LEN, SIG_REGION_NAMES, SIG_REGIONS,
} from "../src/live/mutate.js";
import {
  DEFAULT_OWNER, DEFAULT_REGISTRY, describeRevert, LIVE_ABI, localWindowMessage, PIN_LAG, REGISTRY_EXIT, registryExitCode, runRegistryProbe, type RegistryRun,
} from "../src/live/registry.js";
import { renderFuzzReport, renderRegistryReport } from "../src/live/report.js";
import { BlockUnavailableError, createRpc, RpcDownError, type CallOutcome, type FetchLike, type Rpc } from "../src/live/rpc.js";

const FX = buildFixtures(7);
const bitDiff = (a: Uint8Array, b: Uint8Array): number => {
  let n = 0;
  for (let i = 0; i < a.length; i++) for (let x = a[i] ^ b[i]; x; x >>= 1) n += x & 1;
  return n;
};
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && bitDiff(a, b) === 0;

describe("live probes: mutation generator", () => {
  it("is deterministic for a seed and differs between seeds", () => {
    const a = generateCases(42, 300, FX);
    const b = generateCases(42, 300, FX);
    assert.equal(a.length, 300);
    assert.deepEqual(a, b);
    const c = generateCases(43, 300, FX);
    assert.notDeepEqual(a.map((x) => x.label), c.map((x) => x.label));
  });

  it("covers every class and every signature region, also with few cases", () => {
    for (const total of [MIN_CASES, 100, 300]) {
      const cases = generateCases(1, total, FX);
      assert.equal(cases.length, total);
      for (const cls of CASE_CLASSES) assert.ok(cases.some((c) => c.cls === cls), `${cls} missing at ${total} cases`);
      for (const r of SIG_REGION_NAMES) assert.ok(cases.some((c) => c.region === r), `region ${r} missing at ${total} cases`);
    }
  });

  it("flips exactly one bit, inside the stated region", () => {
    for (const c of generateCases(5, 300, FX).filter((x) => x.cls === "sig-bitflip")) {
      assert.equal(c.sig.length, SIG_LEN);
      assert.equal(bitDiff(c.sig, FX.sig), 1);
      assert.ok(same(c.pk, FX.pk) && same(c.msg, FX.msg));
      const byte = c.sig.findIndex((v, i) => v !== FX.sig[i]);
      const [lo, hi] = SIG_REGIONS[c.region!];
      assert.ok(byte >= lo && byte < hi, `byte ${byte} outside ${c.region}`);
    }
    for (const c of generateCases(5, 300, FX).filter((x) => x.cls === "pk-bitflip")) assert.equal(bitDiff(c.pk, FX.pk), 1);
    for (const c of generateCases(5, 300, FX).filter((x) => x.cls === "msg-bitflip")) assert.equal(bitDiff(c.msg, FX.msg), 1);
  });

  it("never returns the unmodified valid triple", () => {
    for (const c of generateCases(9, 300, FX)) {
      assert.ok(!(same(c.pk, FX.pk) && same(c.sig, FX.sig) && same(c.msg, FX.msg)), `case ${c.id} ${c.label} is the valid triple`);
    }
  });

  it("rejects fewer than the minimum number of cases and foreign fixtures", () => {
    assert.throws(() => generateCases(1, MIN_CASES - 1, FX), /at least/);
    assert.throws(() => generateCases(1, 100, { ...FX, sig: new Uint8Array(10) }), /sized/);
  });

  it("flipBit does not change its input", () => {
    const a = new Uint8Array(4);
    const b = flipBit(a, 9);
    assert.deepEqual([...a], [0, 0, 0, 0]);
    assert.deepEqual([...b], [0, 2, 0, 0]);
    assert.equal(FX.pk.length, PK_LEN);
  });
});

describe("live probes: result classifier", () => {
  const ret = (b: boolean): CallOutcome => ({ kind: "return", data: `0x${"00".repeat(31)}0${b ? 1 : 0}` });

  it("reads true, false, revert, empty and odd return data", () => {
    assert.equal(observe(ret(true)).observed, "true");
    assert.equal(observe(ret(false)).observed, "false");
    assert.equal(observe({ kind: "revert", message: "execution reverted" }).observed, "revert");
    assert.equal(observe({ kind: "return", data: "0x" }).observed, "empty");
    assert.equal(observe({ kind: "return", data: "0x1234" }).observed, "unexpected");
  });

  it("treats an RPC error, empty data and odd data as not run, never as a pass", () => {
    for (const expect of ["reject", "accept"] as const) {
      assert.equal(judge(expect, observe({ kind: "rpc-error", message: "HTTP 502" }).observed), "not-run");
      assert.equal(judge(expect, "empty"), "not-run");
      assert.equal(judge(expect, "unexpected"), "not-run");
    }
  });

  it("passes a rejected negative, flags an accepted one, fails a rejected control", () => {
    assert.equal(judge("reject", "false"), "pass");
    assert.equal(judge("reject", "revert"), "pass");
    assert.equal(judge("reject", "true"), "forgery-accepted");
    assert.equal(judge("accept", "true"), "pass");
    assert.equal(judge("accept", "false"), "control-failed");
    assert.equal(judge("accept", "revert"), "control-failed");
  });

  const res = (observed: CaseResult["observed"], expect: CaseResult["expect"] = "reject", cls: CaseResult["cls"] = "sig-bitflip"): CaseResult => ({
    id: 0, cls, label: "x", expect, observed, verdict: judge(expect, observed), inputBytes: { pk: 0, sig: 0, msg: 0 },
  });
  const okControls = [res("true", "accept", "positive-control")];

  it("exit codes: 0 ok, 2 control failed, 3 forgery, 4 too many not run", () => {
    const many = (n: number, notRun: number) => [...Array(n - notRun).fill(0).map(() => res("false")), ...Array(notRun).fill(0).map(() => res("rpc-error"))];
    assert.equal(exitCodeOf(summarize(okControls, many(100, 0))), 0);
    assert.equal(exitCodeOf(summarize(okControls, many(100, 2))), 0); // 2% is allowed
    assert.equal(exitCodeOf(summarize(okControls, many(100, 3))), 4);
    assert.equal(exitCodeOf(summarize(okControls, [...many(99, 0), res("true")])), 3);
    assert.equal(exitCodeOf(summarize([res("false", "accept", "positive-control")], many(100, 0))), 2);
    assert.equal(exitCodeOf(summarize([], many(100, 0))), 2); // no control at all is not a pass
  });

  it("counts false, revert, accepted and not run apart per class and region", () => {
    const r1 = { ...res("false"), region: "z" as const };
    const r2 = { ...res("revert"), region: "z" as const };
    const r3 = { ...res("rpc-error"), region: "ctilde" as const, detail: "HTTP 502" };
    const s = summarize(okControls, [r1, r2, r3]);
    assert.deepEqual(s.perClass["sig-bitflip"], { total: 3, false: 1, revert: 1, accepted: 0, notRun: 1 });
    assert.equal(s.perRegion.z.total, 2);
    assert.equal(s.notRunReasons["HTTP 502"], 1);
  });
});

const PQC_ABI = parseAbi(["function pqcVerify(bytes,bytes,bytes) view returns (bool)"]);

/** A mock node: the precompile is the local ML-DSA verifier. `tweak` can break it on purpose. */
function mockNode(tweak: (n: number, verdict: boolean) => CallOutcome | undefined = () => undefined) {
  let calls = 0;
  const rpc: Pick<Rpc, "ethCall"> = {
    async ethCall(_to, data): Promise<CallOutcome> {
      const n = calls++;
      const [pk, sig, msg] = decodeFunctionData({ abi: PQC_ABI, data }).args as [Hex, Hex, Hex];
      let ok = false;
      try {
        ok = mldsa.verify(toBytes(pk), toBytes(msg), toBytes(sig));
      } catch {
        ok = false;
      }
      return tweak(n, ok) ?? { kind: "return", data: encodeAbiParameters([{ type: "bool" }], [ok]) };
    },
  };
  return { rpc, calls: () => calls };
}

describe("live probes: fuzz run against a mock node with a real verifier", () => {
  it("passes when the verifier rejects every mutation", async () => {
    const node = mockNode();
    const s = await runFuzz(node.rpc, { seed: 3, cases: MIN_CASES, controlKeys: 1 });
    assert.equal(s.aborted, false);
    assert.equal(s.controls.length, 2); // deterministic and hedged
    assert.equal(exitCodeOf(s), 0);
    assert.equal(s.forgeries.length, 0);
    assert.equal(node.calls(), 2 + MIN_CASES);
  });

  it("aborts before the negatives when a positive control fails", async () => {
    const node = mockNode(() => ({ kind: "return", data: encodeAbiParameters([{ type: "bool" }], [false]) })); // a dead verifier says false to all
    const s = await runFuzz(node.rpc, { seed: 3, cases: MIN_CASES, controlKeys: 1 });
    assert.equal(s.aborted, true);
    assert.equal(exitCodeOf(s), 2);
    assert.equal(node.calls(), 2, "no negative case may run after a failed control");
  });

  it("aborts when the precompile is inactive (empty return)", async () => {
    const node = mockNode(() => ({ kind: "return", data: "0x" }));
    const s = await runFuzz(node.rpc, { seed: 3, cases: MIN_CASES, controlKeys: 1 });
    assert.equal(s.aborted, true);
    assert.notEqual(exitCodeOf(s), 0);
  });

  it("reports an accepted forgery and exits non-zero", async () => {
    const node = mockNode((n) => (n === 2 + 10 ? { kind: "return", data: encodeAbiParameters([{ type: "bool" }], [true]) } : undefined));
    const s = await runFuzz(node.rpc, { seed: 3, cases: MIN_CASES, controlKeys: 1, concurrency: 1 });
    assert.equal(s.forgeries.length, 1);
    assert.equal(exitCodeOf(s), 3);
  });

  it("does not count RPC errors as rejected", async () => {
    const node = mockNode((n) => (n >= 2 ? { kind: "rpc-error", message: "HTTP 503" } : undefined));
    const s = await runFuzz(node.rpc, { seed: 3, cases: MIN_CASES, controlKeys: 1 });
    assert.equal(s.notRun, MIN_CASES);
    assert.equal(Object.values(s.perClass).reduce((n, c) => n + c.false + c.revert, 0), 0);
    assert.equal(exitCodeOf(s), 4);
  });

  it("counts a revert as a rejection and keeps its message", async () => {
    const node = mockNode((n, ok) => (n >= 2 && !ok && n % 2 === 0 ? { kind: "revert", message: "invalid length" } : undefined));
    const s = await runFuzz(node.rpc, { seed: 3, cases: MIN_CASES, controlKeys: 1, concurrency: 1 });
    assert.equal(exitCodeOf(s), 0);
    assert.ok((s.revertReasons["invalid length"] ?? 0) > 0);
  });
});

describe("live probes: rpc client", () => {
  const reply = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
  const mk = (responses: ReturnType<typeof reply>[], retries = 2) => {
    let i = 0;
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (_u, init) => {
      seen.push(init.body);
      const r = responses[Math.min(i++, responses.length - 1)];
      return r;
    };
    const rpc = createRpc({ url: "http://mock", fetchImpl, retries, baseDelayMs: 1, minGapMs: 0, sleep: async () => {} });
    return { rpc, seen };
  };

  it("retries a 5xx and then returns the data", async () => {
    const { rpc, seen } = mk([reply(502, "bad gateway"), reply(200, { jsonrpc: "2.0", id: 1, result: "0x01" })]);
    assert.deepEqual(await rpc.ethCall("0xa01", "0x"), { kind: "return", data: "0x01" });
    assert.equal(seen.length, 2);
  });

  it("returns an rpc-error, not a revert and not data, when the node keeps failing", async () => {
    const { rpc, seen } = mk([reply(503, "down")], 2);
    const o = await rpc.ethCall("0xa01", "0x");
    assert.equal(o.kind, "rpc-error");
    assert.equal(seen.length, 3);
  });

  it("does not retry a revert and keeps the revert data", async () => {
    const { rpc, seen } = mk([reply(200, { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "execution reverted", data: "0x5cd5d233" } })]);
    const o = await rpc.ethCall("0xa01", "0x", "0x0000000000000000000000000000000000000001");
    assert.deepEqual(o, { kind: "revert", data: "0x5cd5d233", message: "execution reverted" });
    assert.equal(seen.length, 1);
    assert.match(seen[0], /"from":"0x0000000000000000000000000000000000000001"/);
  });

  it("treats a JSON-RPC error that is not a revert as a failure to answer", async () => {
    const { rpc } = mk([reply(200, { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Missing or invalid parameters." } })], 1);
    assert.equal((await rpc.ethCall("0xa01", "0x")).kind, "rpc-error");
  });

  it("does not retry \"header not found\" and marks it as a missing block", async () => {
    const gone = reply(200, { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "header not found" } });
    const a = mk([gone], 3);
    assert.deepEqual(await a.rpc.ethCall("0xa01", "0x", undefined, "0x10"), { kind: "rpc-error", message: "JSON-RPC -32000 header not found", blockUnavailable: true });
    assert.equal(a.seen.length, 1);
    assert.match(a.seen[0], /"0x10"\]/);
    const b = mk([gone], 3);
    await assert.rejects(b.rpc.request("eth_getBlockByNumber", ["0x10", false]), BlockUnavailableError);
    assert.equal(b.seen.length, 1);
  });

  it("request() throws a clear error when the RPC is down", async () => {
    const { rpc } = mk([reply(500, "x")], 1);
    await assert.rejects(rpc.request("eth_chainId", []), (e: Error) => e instanceof RpcDownError && /did not answer/.test(e.message) && /may be down/.test(e.message));
  });

  it("only ever sends read methods in these tests: no eth_sendRawTransaction", async () => {
    const { rpc, seen } = mk([reply(200, { jsonrpc: "2.0", id: 1, result: "0x2648" })]);
    await rpc.request("eth_chainId", []);
    await rpc.ethCall("0xa01", "0x");
    assert.ok(seen.every((b) => !/sendRawTransaction|sendTransaction/.test(b)));
  });

  it("pool keeps the order of the results", async () => {
    const out = await pool([1, 2, 3, 4, 5], 3, async (x) => {
      await new Promise((r) => setTimeout(r, 5 - x));
      return x * 2;
    });
    assert.deepEqual(out, [2, 4, 6, 8, 10]);
  });
});

describe("live probes: registry helpers and reports", () => {
  it("decodes the custom errors of the registry by selector", () => {
    assert.equal(describeRevert("0x5cd5d233").name, "BadSignature");
    assert.equal(describeRevert("0x9a10af23").name, "BadOwnerSignature");
    assert.equal(describeRevert("0xc0975f58").name, "PqcPrecompileInactive");
    const brk = encodeErrorResult({ abi: LIVE_ABI, errorName: "BrokenChain", args: [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`] });
    assert.equal(describeRevert(brk).name, "BrokenChain");
    assert.match(describeRevert(brk).text, /^BrokenChain\(0x1111/);
    assert.equal(describeRevert("0xdeadbeef").name, "(unknown)");
    assert.equal(describeRevert(undefined).name, "(no data)");
  });

  const run = (verdicts: ("pass" | "fail" | "not-run")[]): RegistryRun => ({
    startedAt: "2026-11-28T10:00:00.123Z", headAtStart: 125n, blockNumber: 123n, blockTime: 1795816200n, retriedAtFreshBlock: false, chainId: 9800,
    registry: "0xReg", owner: "0xOwner", deviceId: "0xdev", aborted: false, overrideOutcome: "empty",
    checks: verdicts.map((v, i) => ({ group: i === 0 ? "anchor" : "owner-actions", role: "negative", title: `check ${i} | with pipe`, expected: "BadSignature", got: "BadSignature()", verdict: v })),
    observations: ["override note"], receiptUrl: "https://example.test/r.json",
  });

  it("exit code of the registry run: 0 pass, 2 control, 3 accepted, 6 unexpected answer, 4 not run", () => {
    assert.equal(registryExitCode(run(["pass", "pass"])), 0);
    assert.equal(registryExitCode(run(["pass", "not-run"])), 4);
    assert.equal(registryExitCode(run(["fail", "not-run"])), 6);
    const acc = run(["pass", "fail"]);
    acc.checks[1].accepted = true;
    assert.equal(registryExitCode(acc), 3);
    const ctl = run(["pass", "fail"]);
    ctl.checks.push({ group: "control", role: "control", title: "c", expected: "true", got: "empty", verdict: "not-run" });
    assert.equal(registryExitCode(ctl), 2);
    assert.equal(registryExitCode({ ...run(["pass"]), aborted: true }), 2);
  });

  it("renders the fuzz report with date, chain, block, commit, seed, command and counts", () => {
    const controls = [{ id: 0, cls: "positive-control" as const, label: "key 1", expect: "accept" as const, observed: "true" as const, verdict: "pass" as const, inputBytes: { pk: 1, sig: 1, msg: 1 } }];
    const negs: CaseResult[] = [
      { id: 1, cls: "sig-bitflip", region: "z", label: "a", expect: "reject", observed: "false", verdict: "pass", inputBytes: { pk: 1, sig: 1, msg: 1 } },
      { id: 2, cls: "sig-bitflip", region: "z", label: "b", expect: "reject", observed: "revert", verdict: "pass", detail: "execution reverted", inputBytes: { pk: 1, sig: 1, msg: 1 } },
    ];
    const summary = summarize(controls, negs);
    const md = renderFuzzReport({
      meta: { startedAt: "2026-11-28T10:00:00.123Z", chainId: 9800, blockNumber: 10873167n, rpc: "https://rpc.test", commit: "abc123", command: "pnpm probe:pqc:fuzz --seed 5 --cases 300" },
      seed: 5, cases: 300, summary, durationMs: 15_000, exitCode: 0,
    });
    for (const needle of ["2026-11-28 10:00:00 UTC", "chain id 9800", "10873167", "abc123", "Seed: 5", "`pnpm probe:pqc:fuzz --seed 5 --cases 300`", "| sig-bitflip | 2 | 1 | 1 | 0 | 0 |", "| z | 2 |", "PASSED", "no proof of ML-DSA conformance", "execution reverted", "What this shows"]) {
      assert.ok(md.includes(needle), `missing: ${needle}`);
    }
  });

  it("the fuzz report says ABORTED and FAILED loudly", () => {
    const meta = { startedAt: "2026-11-28T10:00:00Z", chainId: 9800, blockNumber: 1n, rpc: "r", commit: "c", command: "x" };
    const bad = { id: 0, cls: "positive-control" as const, label: "key 1", expect: "accept" as const, observed: "false" as const, verdict: "control-failed" as const, inputBytes: { pk: 1, sig: 1, msg: 1 } };
    const aborted = renderFuzzReport({ meta, seed: 1, cases: 60, summary: { ...summarize([bad], []), aborted: true }, durationMs: 1, exitCode: 2 });
    assert.match(aborted, /ABORTED/);
    assert.match(aborted, /## What failed/);
    assert.doesNotMatch(aborted, /What this shows/);
    const forged: CaseResult = { id: 3, cls: "pk-bitflip", label: "evil", expect: "reject", observed: "true", verdict: "forgery-accepted", inputBytes: { pk: 1, sig: 1, msg: 1 } };
    const md = renderFuzzReport({ meta, seed: 1, cases: 60, summary: summarize([{ ...bad, observed: "true", verdict: "pass" }], [forged]), durationMs: 1, exitCode: 3 });
    assert.match(md, /FAILED.*ACCEPTED/);
    assert.match(md, /case 3, pk-bitflip: evil/);
    assert.doesNotMatch(md, /What this shows/);
  });

  it("renders the registry report and escapes table pipes", () => {
    const md = renderRegistryReport({
      meta: { startedAt: "2026-11-28T10:00:00.123Z", chainId: 9800, blockNumber: 123n, blockTime: 1795816200n, rpc: "https://rpc.test", commit: "abc", command: "pnpm probe:registry" },
      run: run(["pass", "pass"]), durationMs: 5000, exitCode: 0,
    });
    for (const needle of ["PASSED", "Block height at the run: 123", "used block 123 (head at the start 125", "check 0 \\| with pipe", "override note", "Nothing was sent", "pnpm probe:registry", "What this shows"]) assert.ok(md.includes(needle), `missing: ${needle}`);
    const meta = { startedAt: "2026-11-28T10:00:00Z", chainId: 9800, blockNumber: 1n, rpc: "r", commit: "c", command: "x" };
    const failed = renderRegistryReport({ meta, run: run(["pass", "fail"]), durationMs: 1, exitCode: 6 });
    assert.match(failed, /FAILED/);
    assert.match(failed, /## What failed/);
    assert.doesNotMatch(failed, /What this shows/);
    const inc = renderRegistryReport({ meta, run: run(["pass", "not-run"]), durationMs: 1, exitCode: 4 });
    assert.match(inc, /INCOMPLETE/);
    assert.doesNotMatch(inc, /What this shows/);
    const ab = renderRegistryReport({ meta, run: { ...run(["pass"]), aborted: true }, durationMs: 1, exitCode: 2 });
    assert.match(ab, /ABORTED/);
    assert.match(ab, /negative simulations were not run/);
    assert.doesNotMatch(ab, /What this shows/);
  });
});

// ---------------------------------------------------------------------------------------------
// runRegistryProbe against a mocked node. The mock runs the registry rules that matter here and
// uses the local ML-DSA-87 verifier as pqcVerify. A real device key signs two real windows.

const REG = DEFAULT_REGISTRY;
const OWNER = DEFAULT_OWNER;
const HEAD = 5_000n;
const PINNED = HEAD - PIN_LAG;
const seed32 = (tag: string) => toBytes(keccak256(toBytes(tag)));
const DEVICE = mldsa.keygen(seed32("mock device"));
const DEVICE_PK = toHex(DEVICE.publicKey);
const DEVICE_ID = keccak256(toBytes("mock device id"));
const T_NOW = 1_795_830_000n;
type MockClaim = { deviceId: Hex; windowStart: bigint; windowSeconds: number; leafCount: number; root: Hex; prevRoot: Hex; refBlock: bigint; refBlockHash: Hex };
const mkWindow = (i: number, prevRoot: Hex): { w: MockClaim; sig: Hex; block: bigint; txHash: Hex; anchorId: Hex } => {
  const w: MockClaim = {
    deviceId: DEVICE_ID, windowStart: T_NOW - 1_800n + BigInt(i) * 600n, windowSeconds: 600, leafCount: 10, root: keccak256(toBytes(`root ${i}`)), prevRoot,
    refBlock: HEAD - 400n + BigInt(i) * 100n, refBlockHash: keccak256(toBytes(`block ${i}`)),
  };
  const sig = toHex(mldsa.sign(DEVICE.secretKey, localWindowMessage(9800, REG, OWNER, w)));
  return { w, sig, block: w.refBlock + 2n, txHash: keccak256(toBytes(`tx ${i}`)), anchorId: keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }, { type: "uint64" }], [OWNER, DEVICE_ID, w.windowStart])) };
};
const W1 = mkWindow(0, `0x${"00".repeat(32)}`);
const W2 = mkWindow(1, W1.w.root);
const NEXT_START = W2.w.windowStart + 600n;
const RECEIPT_LINK = keccak256(toBytes("segment 0"));
const RECEIPT = JSON.stringify({ owner: OWNER, deviceId: DEVICE_ID, windowStart: String(W1.w.windowStart), segments: [{ link: RECEIPT_LINK, index: 0, proof: [] }] });

interface MockOpts {
  /** Replace the answer of a direct pqcVerify call. `ok` is what the real verifier says. */
  pqc?: (pk: Hex, sig: Hex, msg: Hex, ok: boolean) => CallOutcome | undefined;
  /** Replace the answer of a registry call by function name. */
  registry?: (fn: string, args: readonly unknown[]) => CallOutcome | undefined;
  /** Raw answer to the one eth_call with a state override. */
  override?: () => unknown;
  /** The first eth_call at the first pinned block says "header not found". */
  blockGoneOnce?: boolean;
}

function registryNode(o: MockOpts = {}) {
  const tags = new Set<string>();
  const calls: string[] = [];
  let head = HEAD;
  let blockGone = o.blockGoneOnce ?? false;
  const ok = (data: Hex): CallOutcome => ({ kind: "return", data });
  const err = (name: string, args: unknown[] = []): CallOutcome => ({ kind: "revert", message: "execution reverted", data: encodeErrorResult({ abi: LIVE_ABI, errorName: name, args } as never) });
  const anchored = (x: typeof W1) => ({
    address: REG, transactionHash: x.txHash, blockNumber: toHex(x.block),
    topics: encodeEventTopics({ abi: LIVE_ABI, eventName: "Anchored", args: { anchorId: x.anchorId, owner: OWNER, deviceId: DEVICE_ID } }),
    data: encodeAbiParameters([{ type: "uint64" }, { type: "uint32" }, { type: "uint32" }, { type: "bytes32" }, { type: "bytes32" }], [x.w.windowStart, x.w.windowSeconds, x.w.leafCount, x.w.root, keccak256(x.sig)]),
  });
  const anchorRecord = (x: typeof W1) => ({
    root: x.w.root, sigHash: keccak256(x.sig), deviceKeyHash: keccak256(DEVICE_PK), prevRoot: x.w.prevRoot, owner: OWNER, deviceKeyVersion: 1,
    windowStart: x.w.windowStart, windowSeconds: x.w.windowSeconds, leafCount: x.w.leafCount, anchoredAt: T_NOW - 100n, blockNumber: x.block, refBlock: x.w.refBlock, gapBefore: 0n,
  });
  const result = (fn: string, v: unknown) => ok(encodeFunctionResult({ abi: LIVE_ABI, functionName: fn, result: v } as never));

  function registryCall(data: Hex): CallOutcome {
    const { functionName: fn, args } = decodeFunctionData({ abi: LIVE_ABI, data });
    calls.push(fn);
    const hook = o.registry?.(fn, args ?? []);
    if (hook) return hook;
    const a = (args ?? []) as readonly unknown[];
    switch (fn) {
      case "getDevice": return result(fn, { keyHash: keccak256(DEVICE_PK), keyVersion: 1, status: 1, registeredAt: T_NOW - 9_000n, revokedAt: 0n });
      case "chainHead": return result(fn, W2.w.root);
      case "nextWindowStart": return result(fn, NEXT_START);
      case "nonces": return result(fn, 7n);
      case "getAnchor": return a[0] === W2.anchorId ? result(fn, anchorRecord(W2)) : a[0] === W1.anchorId ? result(fn, anchorRecord(W1)) : err("UnknownAnchor", [a[0]]);
      case "signingMessage": return result(fn, toHex(localWindowMessage(9800, REG, a[0] as Hex, a[1] as MockClaim)));
      case "revokeMessage": return result(fn, revokeBytes(a));
      case "verifyAnchor": {
        const included = a[3] === RECEIPT_LINK;
        return result(fn, { found: true, included, anchorId: W1.anchorId, anchor: anchorRecord(W1), deviceStatus: 1, deviceRevokedAt: 0n, chainHead: W2.w.root });
      }
      case "anchor": {
        const [w, pk, sig] = a as [MockClaim, Hex, Hex];
        if (w.prevRoot !== W2.w.root) return err("BrokenChain", [W2.w.root, w.prevRoot]);
        if (keccak256(pk) !== keccak256(DEVICE_PK)) return err("DeviceKeyMismatch", [w.deviceId]);
        let good = false;
        try { good = mldsa.verify(toBytes(pk), localWindowMessage(9800, REG, OWNER, w), toBytes(sig)); } catch { good = false; }
        return good ? ok(`0x${"ab".repeat(32)}`) : err("BadSignature");
      }
      case "revokeDevice":
      case "registerDevice": return err("BadOwnerSignature");
      default: throw new Error(`mock: unexpected call ${fn}`);
    }
  }
  function revokeBytes(a: readonly unknown[]): Hex {
    return encodePacked(["bytes32", "uint256", "address", "address", "bytes32", "uint256"], [keccak256(toBytes("QoreWitness/DeviceRegistry/revoke/v1")), 9800n, REG, a[0] as Hex, a[1] as Hex, a[2] as bigint]);
  }

  const rpc: Rpc = {
    url: "mock://registry",
    async request(method, params) {
      calls.push(method);
      switch (method) {
        case "eth_chainId": return "0x2648";
        case "eth_blockNumber": return toHex(head);
        case "eth_getBlockByNumber": {
          const n = BigInt(params[0] as string);
          return { hash: keccak256(toBytes(`hash ${n}`)), timestamp: toHex(T_NOW + (n - HEAD) * 2n) };
        }
        case "eth_getLogs": {
          const f = params[0] as { fromBlock: Hex; toBlock: Hex };
          return [W1, W2].filter((x) => x.block >= BigInt(f.fromBlock) && x.block <= BigInt(f.toBlock)).map(anchored);
        }
        case "eth_getTransactionByHash": {
          const x = [W1, W2].find((y) => y.txHash === params[0]);
          return x ? { input: encodeFunctionData({ abi: LIVE_ABI, functionName: "anchor", args: [x.w, DEVICE_PK, x.sig] }) } : null;
        }
        case "eth_call": {
          assert.equal(params.length, 3, "only the override observation goes through request()");
          assert.deepEqual(params[2], {}, "the override object is empty");
          tags.add(params[1] as string);
          return o.override ? o.override() : "0x";
        }
        default: throw new Error(`mock: unexpected method ${method}`);
      }
    },
    async ethCall(to, data, _from, block) {
      tags.add(block ?? "latest");
      if (blockGone) {
        blockGone = false;
        head += 10n;
        return { kind: "rpc-error", message: "JSON-RPC -32000 header not found", blockUnavailable: true };
      }
      if (to.toLowerCase() === REG.toLowerCase()) return registryCall(data);
      assert.equal(to, "0x0000000000000000000000000000000000000a01");
      calls.push("pqcVerify");
      const [pk, sig, msg] = decodeFunctionData({ abi: PQC_ABI, data }).args as [Hex, Hex, Hex];
      let good = false;
      try { good = mldsa.verify(toBytes(pk), toBytes(msg), toBytes(sig)); } catch { good = false; }
      return o.pqc?.(pk, sig, msg, good) ?? ok(encodeAbiParameters([{ type: "bool" }], [good]));
    },
  };
  return { rpc, tags, calls };
}

const probeCfg = { registry: REG, owner: OWNER, receiptUrl: "https://example.test/r.json", fetchText: async () => RECEIPT, now: () => new Date("2026-11-28T10:00:00Z") };
const boolRet = (b: boolean): CallOutcome => ({ kind: "return", data: encodeAbiParameters([{ type: "bool" }], [b]) });

describe("live probes: registry probe against a mocked node", () => {
  it("passes with 21 checks when everything holds, and pins every call to one block", async () => {
    const node = registryNode();
    const run = await runRegistryProbe(node.rpc, probeCfg);
    assert.equal(registryExitCode(run), REGISTRY_EXIT.ok, JSON.stringify(run.checks.filter((c) => c.verdict !== "pass"), (_k, v) => (typeof v === "bigint" ? String(v) : v)));
    assert.equal(run.checks.length, 21);
    assert.equal(run.checks.filter((c) => c.role === "control").length, 5);
    assert.equal(run.aborted, false);
    assert.equal(run.blockNumber, PINNED);
    assert.deepEqual([...node.tags], [toHex(PINNED)], "every eth_call uses the pinned block");
    assert.equal(run.realAnchor?.txHash, W2.txHash);
    assert.ok(node.calls.indexOf("pqcVerify") < node.calls.indexOf("anchor"), "controls run before the negatives");
    assert.equal(renderRegistryReport({ meta: { startedAt: run.startedAt, chainId: 9800, blockNumber: run.blockNumber, rpc: "mock", commit: "c", command: "x" }, run, durationMs: 1, exitCode: 0 }).includes("What this shows"), true);
  });

  for (const dead of [{ kind: "return", data: "0x" } as CallOutcome, boolRet(false)]) {
    it(`fails with the control exit code when the precompile is dead (${dead.kind === "return" && dead.data === "0x" ? "empty return" : "false for everything"})`, async () => {
      const node = registryNode({ pqc: () => dead });
      const run = await runRegistryProbe(node.rpc, probeCfg);
      assert.equal(run.aborted, true);
      assert.equal(registryExitCode(run), REGISTRY_EXIT.control);
      assert.ok(!node.calls.includes("anchor") && !node.calls.includes("revokeDevice"), "no negative simulation after a failed control");
      const md = renderRegistryReport({ meta: { startedAt: run.startedAt, chainId: 9800, blockNumber: run.blockNumber, rpc: "mock", commit: "c", command: "x" }, run, durationMs: 1, exitCode: 2 });
      assert.match(md, /ABORTED/);
      assert.doesNotMatch(md, /What this shows/);
    });
  }

  it("fails with the control exit code when only the real camera signature is refused", async () => {
    const node = registryNode({ pqc: (_pk, sig, _m, good) => (sig === W2.sig ? boolRet(false) : boolRet(good)) });
    const run = await runRegistryProbe(node.rpc, probeCfg);
    const c = run.checks.find((x) => x.title.includes("pqcVerify(device key, its signature"));
    assert.equal(c?.verdict, "fail");
    assert.equal(registryExitCode(run), REGISTRY_EXIT.control);
  });

  it("fails with the control exit code when the live signing message differs", async () => {
    const node = registryNode({ registry: (fn) => (fn === "signingMessage" ? { kind: "return", data: encodeFunctionResult({ abi: LIVE_ABI, functionName: "signingMessage", result: "0x1234" }) } : undefined) });
    assert.equal(registryExitCode(await runRegistryProbe(node.rpc, probeCfg)), REGISTRY_EXIT.control);
  });

  it("exits as forgery accepted when a forged anchor simulation succeeds", async () => {
    const node = registryNode({ registry: (fn) => (fn === "anchor" ? { kind: "return", data: `0x${"cd".repeat(32)}` } : undefined) });
    const run = await runRegistryProbe(node.rpc, probeCfg);
    assert.ok(run.checks.some((c) => c.accepted));
    assert.equal(registryExitCode(run), REGISTRY_EXIT.accepted);
  });

  it("exits as forgery accepted when pqcVerify accepts a flipped bit of the real signature", async () => {
    const node = registryNode({ pqc: (_pk, sig, _m, good) => (sig !== W2.sig && keccak256(sig) !== keccak256(W2.sig) && sig.length === W2.sig.length && _pk === DEVICE_PK ? boolRet(true) : boolRet(good)) });
    assert.equal(registryExitCode(await runRegistryProbe(node.rpc, probeCfg)), REGISTRY_EXIT.accepted);
  });

  it("exits with 6 when a negative gives another custom error", async () => {
    const node = registryNode({ registry: (fn) => (fn === "revokeDevice" ? { kind: "revert", message: "execution reverted", data: encodeErrorResult({ abi: LIVE_ABI, errorName: "PqcPrecompileInactive" }) } : undefined) });
    assert.equal(registryExitCode(await runRegistryProbe(node.rpc, probeCfg)), REGISTRY_EXIT.unexpected);
  });

  it("counts a revert without data as not run, never as a failure", async () => {
    const node = registryNode({ registry: (fn) => (fn === "revokeDevice" ? { kind: "revert", message: "execution reverted" } : undefined) });
    const run = await runRegistryProbe(node.rpc, probeCfg);
    const c = run.checks.filter((x) => x.title.startsWith("revokeDevice"));
    assert.deepEqual(c.map((x) => x.verdict), ["not-run", "not-run"]);
    assert.ok(!run.checks.some((x) => x.verdict === "fail"));
    assert.equal(registryExitCode(run), REGISTRY_EXIT.notRun);
  });

  it("throws RpcDownError (exit 5) for an RPC error in a setup view call and in a negative", async () => {
    for (const at of ["getDevice", "anchor"]) {
      const node = registryNode({ registry: (fn) => (fn === at ? { kind: "rpc-error", message: "HTTP 502" } : undefined) });
      await assert.rejects(runRegistryProbe(node.rpc, probeCfg), (e: Error) => e instanceof RpcDownError, at);
    }
    const node = registryNode({ pqc: () => ({ kind: "rpc-error", message: "timeout" }) });
    await assert.rejects(runRegistryProbe(node.rpc, probeCfg), RpcDownError);
  });

  it("starts once more at a fresh block when the node does not have the pinned block", async () => {
    const node = registryNode({ blockGoneOnce: true });
    const run = await runRegistryProbe(node.rpc, probeCfg);
    assert.equal(run.retriedAtFreshBlock, true);
    assert.equal(run.blockNumber, HEAD + 10n - PIN_LAG);
    assert.equal(registryExitCode(run), REGISTRY_EXIT.ok);
    const twice: Rpc = { ...node.rpc, ethCall: async () => ({ kind: "rpc-error", message: "header not found", blockUnavailable: true }) };
    await assert.rejects(runRegistryProbe(twice, probeCfg), BlockUnavailableError);
  });

  it("reports what the override call returned and never changes the exit code with it", async () => {
    const empty = await runRegistryProbe(registryNode().rpc, probeCfg);
    assert.equal(empty.overrideOutcome, "empty");
    assert.match(empty.observations.join(" "), /exactly one call with an empty state override/);
    assert.match(empty.observations.join(" "), /with a state override the node answered without the PQC precompile/);
    const yes = await runRegistryProbe(registryNode({ override: () => `0x${"00".repeat(31)}01` }).rpc, probeCfg);
    assert.equal(yes.overrideOutcome, "true");
    assert.match(yes.observations.join(" "), /the node now runs the precompile with overrides/);
    const down = await runRegistryProbe(registryNode({ override: () => { throw new RpcDownError("mock", "x"); } }).rpc, probeCfg);
    assert.equal(down.overrideOutcome, "error");
    for (const r of [empty, yes, down]) assert.equal(registryExitCode(r), REGISTRY_EXIT.ok);
  });
});
