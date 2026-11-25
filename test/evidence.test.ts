/** Save evidence: ZIP writer and reader, range selection, local checks, safe names, auth. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";
import { deflateRawSync, crc32 } from "node:zlib";
import { toHex } from "viem";
import { segmentLink, ZERO_LINK } from "../src/core/link.js";
import { merkleProof, merkleRoot } from "../src/core/merkle.js";
import type { VerifyResult } from "../src/core/verify.js";
import { dataPaths, ensureDirs } from "../src/setup/steps.js";
import { csrfToken, issueSession, sessionSecret, setPassword } from "../src/web/auth.js";
import { memEntry, parseRange, planEvidence, writeZip, zipLength, type ZipEntry } from "../src/web/evidence.js";
import { createHandler } from "../src/web/server.js";
import type { Wizard } from "../src/web/wizard.js";
import { checkClips, span, verdictOf, when, type AnyReceipt } from "../web/verifier/package.js";
import { readZip, safeName } from "../web/verifier/zip.js";

const hex = (b: Uint8Array) => toHex(b);
const T0 = Date.UTC(2026, 10, 21, 2, 10, 0); // 02:10:00 UTC
const names = ["seg_20261121T021000Z.mp4", "seg_20261121T021100Z.mp4", "seg_20261121T021200Z.mp4"];
const EVIL = "../secret.mp4"; // a fourth entry whose name leaves the segment folder
const MIN = 60_000;

function fixture(extra?: { badName?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "qw-ev-"));
  const receiptDir = join(root, "cam", "receipts");
  const segmentDir = join(root, "cam", "segments");
  mkdirSync(receiptDir, { recursive: true });
  mkdirSync(segmentDir, { recursive: true });
  const all = extra?.badName ? [...names, EVIL] : names;
  const files = all.map(() => randomBytes(3000));
  let prev: Uint8Array = ZERO_LINK;
  const parts = all.map((file, i) => {
    const sha = createHash("sha256").update(files[i]).digest();
    const sha3 = createHash("sha3-256").update(files[i]).digest();
    const startMs = T0 + i * MIN;
    const link = segmentLink(prev, { fileHash: sha, fileSha3: sha3, startMs: BigInt(startMs), durationMs: MIN, sourceFp: new Uint8Array(32) });
    const p = { file, sha, sha3, startMs, prevLink: prev, link };
    prev = link;
    writeFileSync(join(segmentDir, file), files[i]);
    return p;
  });
  const links = parts.map((p) => p.link);
  const receipt = {
    format: "qorewitness-receipt/v3",
    chain: { evmChainId: 9800, registry: "0x" + "11".repeat(20), txHash: "0x" + "ab".repeat(32), blockNumber: "4242" },
    owner: "0x" + "22".repeat(20), deviceId: "0x" + "33".repeat(32), deviceLabel: "Hall camera", devicePubkey: "0x" + "44".repeat(10),
    windowStart: String(T0 / 1000), windowSeconds: 600, root: hex(merkleRoot(links)), signature: "0x00", prevRoot: "0x" + "00".repeat(32),
    refBlock: "1", refBlockHash: "0x" + "55".repeat(32),
    segments: parts.map((p, index) => ({
      file: p.file, sha256: hex(p.sha), sha3_256: hex(p.sha3), size: 3000, index, proof: merkleProof(links, index).map(hex),
      prevLink: hex(p.prevLink), link: hex(p.link), startMs: String(p.startMs), durationMs: MIN, sourceFp: "0x" + "00".repeat(32), source: "h264",
    })),
  };
  writeFileSync(join(receiptDir, `cam-${T0 / 1000}.json`), JSON.stringify(receipt));
  return { root, receiptDir, segmentDir, files, receipt };
}

const base = (f: ReturnType<typeof fixture>) => ({ device: "cam", receiptDir: f.receiptDir, segmentDir: f.segmentDir });

async function zipBuffer(entries: ZipEntry[]): Promise<Buffer> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (c: Buffer) => chunks.push(c));
  await writeZip(entries, out);
  out.end();
  return Buffer.concat(chunks);
}

describe("evidence: zip round trip", () => {
  it("writes a ZIP that the verifier's reader opens, with exact length and bytes", async () => {
    const f = fixture();
    const plan = await planEvidence({ ...base(f), fromMs: T0, toMs: T0 + 3 * MIN, now: T0 + 3600_000 });
    assert.equal(plan.clips.length, 3);
    const buf = await zipBuffer(plan.entries);
    assert.equal(buf.length, plan.zipBytes);
    assert.equal(buf.length, zipLength(plan.entries));
    const files = readZip(new Uint8Array(buf));
    assert.deepEqual(files.map((x) => x.name).sort(), [
      "HOW-TO-CHECK.txt", "certificate.html", `clips/${names[0]}`, `clips/${names[1]}`, `clips/${names[2]}`, `receipts/cam-${T0 / 1000}.json`,
    ]);
    for (let i = 0; i < 3; i++) {
      const got = await files.find((x) => x.name === `clips/${names[i]}`)!.bytes();
      assert.ok(Buffer.from(got).equals(f.files[i]));
    }
    const cert = Buffer.from(await files.find((x) => x.name === "certificate.html")!.bytes()).toString();
    assert.match(cert, /What this proves/);
    assert.match(cert, /What it cannot prove/);
    assert.match(cert, /Hall camera/);
    assert.match(cert, /block 4242/);
    assert.match(cert, /qorewitness\.fnoufnou\.com\/verifier\.html/);
    assert.match(cert, /3 clips checked against their receipts/);
    const howto = Buffer.from(await files.find((x) => x.name === "HOW-TO-CHECK.txt")!.bytes()).toString();
    assert.equal((howto.match(/^Step \d\./gm) ?? []).length, 3);
    // An independent reader agrees.
    const dir = mkdtempSync(join(tmpdir(), "qw-ev-zip-"));
    writeFileSync(join(dir, "e.zip"), buf);
    const py = spawnSync("python3", ["-I", "-m", "zipfile", "-t", join(dir, "e.zip")], { encoding: "utf8" });
    if (py.error === undefined) assert.equal(py.status, 0, py.stderr);
  });

  it("reads deflate entries too, and stops a file that inflates past its declared size", async () => {
    const data = Buffer.from("hello ".repeat(500));
    const comp = deflateRawSync(data);
    const build = (declared: number) => {
      const name = Buffer.from("clips/x.mp4");
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc32(data), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(declared, 22); lh.writeUInt16LE(name.length, 26);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(crc32(data), 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(declared, 24); cd.writeUInt16LE(name.length, 28);
      const body = Buffer.concat([lh, name, comp]);
      const cdAll = Buffer.concat([cd, name]);
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cdAll.length, 12); end.writeUInt32LE(body.length, 16);
      return new Uint8Array(Buffer.concat([body, cdAll, end]));
    };
    const ok = readZip(build(data.length));
    assert.ok(Buffer.from(await ok[0].bytes()).equals(data));
    await assert.rejects(readZip(build(10))[0].bytes(), /larger than it says|damaged/);
  });
});

describe("evidence: range selection", () => {
  it("takes the clips that touch the range and nothing else", async () => {
    const f = fixture();
    const mid = await planEvidence({ ...base(f), fromMs: T0 + 30_000, toMs: T0 + 90_000 }); // clips 1 and 2
    assert.deepEqual(mid.clips.map((c) => c.file), [names[0], names[1]]);
    assert.equal(mid.coveredMs, 60_000);
    const late = await planEvidence({ ...base(f), fromMs: T0 + 2 * MIN, toMs: T0 + 3 * MIN });
    assert.deepEqual(late.clips.map((c) => c.file), [names[2]]);
    const none = await planEvidence({ ...base(f), fromMs: T0 + 10 * MIN, toMs: T0 + 12 * MIN });
    assert.equal(none.entries.length, 0);
    assert.match(none.problems[0], /No sealed video/);
  });

  it("says what is missing: gaps and clips that wait for a seal", async () => {
    const f = fixture();
    writeFileSync(join(f.segmentDir, "seg_20261121T021300Z.mp4"), "new");
    const p = await planEvidence({ ...base(f), fromMs: T0, toMs: T0 + 6 * MIN });
    assert.equal(p.notSealed, 1);
    assert.ok(p.problems.some((t) => /no sealed video/.test(t)));
    assert.ok(p.problems.some((t) => /not sealed yet/.test(t)));
  });

  it("caps the range at 60 minutes and the ZIP size with a clear message", async () => {
    const f = fixture();
    assert.match((await planEvidence({ ...base(f), fromMs: T0, toMs: T0 + 61 * MIN })).problems[0], /at most 60 minutes/);
    assert.match((await planEvidence({ ...base(f), fromMs: T0, toMs: T0 })).problems[0], /after the start/);
    const big = await planEvidence({ ...base(f), fromMs: T0, toMs: T0 + 3 * MIN, maxBytes: 5000 });
    assert.equal(big.tooLarge, true);
    assert.equal(big.entries.length, 0);
    assert.match(big.problems[0], /Pick a shorter time range/);
  });

  it("reads date and times in the browser's zone, and an end before the start means after midnight", () => {
    const r = parseRange({ date: "2026-11-21", from: "03:10", to: "03:20", tz: "60" }, 0)!;
    assert.equal(r.fromMs, T0);
    assert.equal(r.toMs, T0 + 10 * MIN);
    const n = parseRange({ date: "2026-11-21", from: "23:30", to: "00:15", tz: "0" }, 0)!;
    assert.equal(n.toMs - n.fromMs, 45 * MIN);
    assert.equal(parseRange({ last: "1" }, 7_200_000)!.fromMs, 3_600_000);
    assert.equal(parseRange({ date: "x" }, 0), undefined);
  });
});

describe("evidence: checks and safe names", () => {
  it("leaves out a clip that was changed on the box", async () => {
    const f = fixture();
    const bad = Buffer.from(f.files[1]);
    bad[100] ^= 1;
    writeFileSync(join(f.segmentDir, names[1]), bad);
    const p = await planEvidence({ ...base(f), fromMs: T0, toMs: T0 + 3 * MIN });
    assert.deepEqual(p.clips.map((c) => c.file), [names[0], names[2]]);
    assert.equal(p.leftOut, 1);
    assert.ok(p.problems.some((t) => /left out/.test(t)));
  });

  it("never reads a name from a receipt that could leave the segment folder", async () => {
    const f = fixture({ badName: true });
    const p = await planEvidence({ ...base(f), fromMs: T0, toMs: T0 + 4 * MIN });
    assert.deepEqual(p.clips.map((c) => c.file), names); // the file is on disk, the name is refused
    assert.ok(p.entries.every((e) => /^(clips\/seg_[A-Za-z0-9_-]+\.mp4|receipts\/cam-\d+\.json|certificate\.html|HOW-TO-CHECK\.txt)$/.test(e.name)));
  });

  it("does not follow a link in the segment folder", async () => {
    const f = fixture();
    writeFileSync(join(f.root, "outside.mp4"), randomBytes(3000));
    const target = join(f.segmentDir, names[0]);
    writeFileSync(target + ".keep", "x");
    // replace clip 1 by a link to a file outside
    const { rmSync } = await import("node:fs");
    rmSync(target);
    symlinkSync(join(f.root, "outside.mp4"), target);
    const p = await planEvidence({ ...base(f), fromMs: T0, toMs: T0 + 3 * MIN });
    assert.ok(!p.clips.some((c) => c.file === names[0]));
  });

  it("the ZIP reader refuses unsafe names", async () => {
    for (const bad of ["../evil.txt", "/etc/passwd", "a/../../b", "C:evil", "a\\b"]) {
      assert.equal(safeName(bad), false, bad);
      const buf = await zipBuffer([memEntry(bad, "x")]);
      assert.throws(() => readZip(new Uint8Array(buf)), /unsafe name/, bad);
    }
    assert.equal(safeName("clips/seg_1.mp4"), true);
    assert.throws(() => readZip(new Uint8Array([1, 2, 3])), /not a ZIP/);
  });
});

describe("verifier: package verdict", () => {
  // Stand-in for the chain check: same fingerprint rule as verifyReceipt, no network.
  const verify = async (r: AnyReceipt, h: Uint8Array): Promise<VerifyResult> => {
    const seg = (r as { segments: { sha256: string; startMs: string; durationMs: number }[] }).segments.find((s) => s.sha256 === hex(h));
    if (!seg) return { ok: false, steps: [{ state: "fail", text: "The file fingerprint (SHA-256 0x1234…) is not in this receipt. The file was changed, or it belongs to another receipt." }] };
    const end = Number(seg.startMs) + seg.durationMs;
    return { ok: true, steps: [{ state: "pass", text: "ok" }], anchoredAt: new Date(end + 4 * MIN + 10_000) };
  };

  async function load() {
    const f = fixture();
    const plan = await planEvidence({ ...base(f), fromMs: T0, toMs: T0 + 3 * MIN });
    const files = readZip(new Uint8Array(await zipBuffer(plan.entries)));
    const clips = [];
    const receipts = [];
    for (const z of files) {
      if (z.name.startsWith("clips/")) clips.push({ name: z.name, bytes: await z.bytes() });
      if (z.name.startsWith("receipts/")) receipts.push({ name: z.name, receipt: JSON.parse(Buffer.from(await z.bytes()).toString()) as AnyReceipt });
    }
    return { clips, receipts };
  }

  it("is green for an untouched ZIP, with date, time and seal delay", async () => {
    const { clips, receipts } = await load();
    const v = verdictOf(await checkClips(clips, receipts, verify), "Europe/Amsterdam");
    assert.equal(v.level, "ok");
    assert.equal(v.headline, "Original");
    assert.match(v.detail, /unchanged since they were recorded on 21 Nov 2026, \d\d:\d\d to \d\d:\d\d \(CET, your time\)\./);
    assert.match(v.detail, /Sealed within 5 minutes\./);
    assert.match(v.utc ?? "", /^21 Nov 2026, \d\d:\d\d to \d\d:\d\d$/);
  });

  it("is red when one byte of one clip changed", async () => {
    const { clips, receipts } = await load();
    const copy = new Uint8Array(clips[1].bytes);
    copy[copy.length >> 1] ^= 1;
    clips[1] = { name: clips[1].name, bytes: copy };
    const v = verdictOf(await checkClips(clips, receipts, verify));
    assert.equal(v.level, "bad");
    assert.equal(v.headline, "Changed after sealing");
    assert.match(v.detail, /1 of 3 clips/);
  });

  it("is red for a clip without a receipt and amber when the chain cannot be reached", async () => {
    const { clips, receipts } = await load();
    const none = verdictOf(await checkClips([{ name: "clips/seg_x.mp4", bytes: new Uint8Array(5) }], [], verify));
    assert.equal(none.level, "bad");
    const net = verdictOf(await checkClips(clips, receipts, async () => { throw new Error("fetch failed"); }));
    assert.equal(net.level, "warn");
    assert.equal(net.headline, "Check not finished");
  });

  it("shows one date style with the time zone of the viewer", () => {
    const ms = Date.UTC(2026, 10, 24, 7, 8);
    assert.deepEqual(when(ms, "Europe/Amsterdam"), { date: "24 Nov 2026", time: "08:08", zone: "CET" });
    assert.deepEqual(when(ms, "UTC"), { date: "24 Nov 2026", time: "07:08", zone: "UTC" });
    assert.equal(when(ms, "America/New_York").zone, "EST");
    assert.equal(span(ms, ms + 60_000, "Europe/Amsterdam").text, "24 Nov 2026, 08:08 to 08:09");
  });

  it("still accepts one clip with its receipt, under any file name", async () => {
    const { clips, receipts } = await load();
    const v = verdictOf(await checkClips([{ name: "my video.mp4", bytes: clips[0].bytes }], [receipts[0]], verify));
    assert.equal(v.level, "ok");
    assert.match(v.detail, /This video is unchanged/);
  });
});

describe("evidence: dashboard routes need the session and the CSRF token", () => {
  const paths = dataPaths(mkdtempSync(join(tmpdir(), "qw-ev-web-")));
  let server: Server;
  let port = 0;
  let cookie = "";
  let csrf = "";

  function call(method: string, path: string, form?: Record<string, string>, withCookie = true): Promise<{ status: number; type: string; length: number; body: Buffer }> {
    const host = "192.168.1.50:8080";
    const body = form ? new URLSearchParams(form).toString() : undefined;
    const headers: Record<string, string> = { host };
    if (withCookie) headers.cookie = `qw_session=${encodeURIComponent(cookie)}`;
    if (body !== undefined) Object.assign(headers, { "content-type": "application/x-www-form-urlencoded", origin: `http://${host}` });
    return new Promise((ok, fail) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => ok({ status: res.statusCode ?? 0, type: String(res.headers["content-type"]), length: Number(res.headers["content-length"] ?? -1), body: Buffer.concat(chunks) }));
      });
      req.on("error", fail);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  before(async () => {
    ensureDirs(paths);
    setPassword(paths.uiDir, "a long enough password");
    writeFileSync(paths.done, new Date().toISOString());
    writeFileSync(paths.cameraEnv, "QW_DEVICE=cam\n", { mode: 0o600 });
    const f = fixture();
    const { cpSync } = await import("node:fs");
    cpSync(join(f.root, "cam"), join(paths.data, "cam"), { recursive: true });
    const secret = sessionSecret(paths.uiDir)!;
    cookie = issueSession(secret, Date.now());
    csrf = csrfToken(secret, cookie);
    server = createServer(createHandler({ paths, wizard: {} as unknown as Wizard, appDir: process.cwd(), now: () => T0 + 3 * MIN }));
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    port = (server.address() as AddressInfo).port;
  });
  after(() => server.close());

  it("refuses without a session", async () => {
    const r = await call("POST", "/evidence/download", { fromMs: String(T0), toMs: String(T0 + MIN), _csrf: csrf }, false);
    assert.equal(r.status, 403);
    assert.notEqual(r.type, "application/zip");
  });

  it("refuses a post without the CSRF token", async () => {
    assert.equal((await call("POST", "/evidence/check", { last: "1" })).status, 403);
    assert.equal((await call("POST", "/evidence/download", { last: "1", _csrf: "wrong" })).status, 403);
  });

  it("shows the dashboard form, a check page, then streams the ZIP with its exact length", async () => {
    assert.match((await call("GET", "/")).body.toString(), /Save evidence/);
    const check = await call("POST", "/evidence/check", { fromMs: String(T0), toMs: String(T0 + 3 * MIN), tz: "0", _csrf: csrf });
    assert.equal(check.status, 200);
    assert.match(check.body.toString(), /3 clips ready/);
    const zip = await call("POST", "/evidence/download", { fromMs: String(T0), toMs: String(T0 + 3 * MIN), tz: "0", _csrf: csrf });
    assert.equal(zip.status, 200);
    assert.equal(zip.type, "application/zip");
    assert.equal(zip.length, zip.body.length);
    assert.equal(readZip(new Uint8Array(zip.body)).length, 6);
  });

  it("tells the owner when nothing is sealed for the time", async () => {
    const r = await call("POST", "/evidence/check", { fromMs: String(T0 + 600 * MIN), toMs: String(T0 + 610 * MIN), _csrf: csrf });
    assert.match(r.body.toString(), /No evidence file for this time/);
  });
});
