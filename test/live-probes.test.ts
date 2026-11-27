/**
 * Unit tests for the live probes (src/live). No network: the RPC is a mock. The mock for the
 * precompile uses the local ML-DSA verifier as the oracle, so the fuzz runs against a verifier
 * that really rejects mutated input.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, parseAbi, toBytes, type Hex } from "viem";
import { mldsa } from "@qorechain/pqc";
import { buildFixtures, exitCodeOf, judge, observe, pool, runFuzz, summarize, type CaseResult } from "../src/live/fuzz.js";
import {
  CASE_CLASSES, flipBit, generateCases, MIN_CASES, PK_LEN, SIG_LEN, SIG_REGION_NAMES, SIG_REGIONS,
} from "../src/live/mutate.js";
import { describeRevert, LIVE_ABI, registryExitCode, type RegistryRun } from "../src/live/registry.js";
import { renderFuzzReport, renderRegistryReport } from "../src/live/report.js";
import { createRpc, RpcDownError, type CallOutcome, type FetchLike, type Rpc } from "../src/live/rpc.js";

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
    startedAt: "2026-11-28T10:00:00.123Z", blockNumber: 123n, blockTime: 1795816200n, chainId: 9800, registry: "0xReg", owner: "0xOwner",
    deviceId: "0xdev", checks: verdicts.map((v, i) => ({ group: i === 0 ? "anchor" : "owner-actions", title: `check ${i} | with pipe`, expected: "BadSignature", got: "BadSignature()", verdict: v })),
    observations: ["override note"], receiptUrl: "https://example.test/r.json",
  });

  it("exit code of the registry run: 0 pass, 3 unexpected answer, 4 not run", () => {
    assert.equal(registryExitCode(run(["pass", "pass"])), 0);
    assert.equal(registryExitCode(run(["pass", "not-run"])), 4);
    assert.equal(registryExitCode(run(["fail", "not-run"])), 3);
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
    for (const needle of ["2026-11-28 10:00:00 UTC", "chain id 9800", "10873167", "abc123", "Seed: 5", "`pnpm probe:pqc:fuzz --seed 5 --cases 300`", "| sig-bitflip | 2 | 1 | 1 | 0 | 0 |", "| z | 2 |", "PASSED", "not a proof of ML-DSA conformance", "execution reverted"]) {
      assert.ok(md.includes(needle), `missing: ${needle}`);
    }
  });

  it("the fuzz report says ABORTED and FAILED loudly", () => {
    const meta = { startedAt: "2026-11-28T10:00:00Z", chainId: 9800, blockNumber: 1n, rpc: "r", commit: "c", command: "x" };
    const bad = { id: 0, cls: "positive-control" as const, label: "key 1", expect: "accept" as const, observed: "false" as const, verdict: "control-failed" as const, inputBytes: { pk: 1, sig: 1, msg: 1 } };
    assert.match(renderFuzzReport({ meta, seed: 1, cases: 60, summary: { ...summarize([bad], []), aborted: true }, durationMs: 1, exitCode: 2 }), /ABORTED/);
    const forged: CaseResult = { id: 3, cls: "pk-bitflip", label: "evil", expect: "reject", observed: "true", verdict: "forgery-accepted", inputBytes: { pk: 1, sig: 1, msg: 1 } };
    const md = renderFuzzReport({ meta, seed: 1, cases: 60, summary: summarize([{ ...bad, observed: "true", verdict: "pass" }], [forged]), durationMs: 1, exitCode: 3 });
    assert.match(md, /FAILED.*ACCEPTED/);
    assert.match(md, /case 3, pk-bitflip: evil/);
  });

  it("renders the registry report and escapes table pipes", () => {
    const md = renderRegistryReport({
      meta: { startedAt: "2026-11-28T10:00:00.123Z", chainId: 9800, blockNumber: 123n, blockTime: 1795816200n, rpc: "https://rpc.test", commit: "abc", command: "pnpm probe:registry" },
      run: run(["pass", "pass"]), durationMs: 5000, exitCode: 0,
    });
    for (const needle of ["PASSED", "Block height at the run: 123", "check 0 \\| with pipe", "override note", "Nothing was sent", "pnpm probe:registry"]) assert.ok(md.includes(needle), `missing: ${needle}`);
    assert.match(renderRegistryReport({ meta: { startedAt: "2026-11-28T10:00:00Z", chainId: 9800, blockNumber: 1n, rpc: "r", commit: "c", command: "x" }, run: run(["pass", "fail"]), durationMs: 1, exitCode: 3 }), /FAILED/);
    assert.match(renderRegistryReport({ meta: { startedAt: "2026-11-28T10:00:00Z", chainId: 9800, blockNumber: 1n, rpc: "r", commit: "c", command: "x" }, run: run(["pass", "not-run"]), durationMs: 1, exitCode: 4 }), /INCOMPLETE/);
  });
});
