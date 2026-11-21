/**
 * Save evidence: one ZIP with the original clips of a time range, their
 * receipts, a printable certificate and a three step how-to.
 *
 * Every clip is checked on this box against its receipt before it goes in
 * (both file fingerprints, size, chain link and Merkle path). The chain itself is
 * read by the public verifier, which the receiver opens. Clips are never
 * re-encoded or cut. The ZIP uses stored entries, written by hand with Node
 * built-ins (zlib.crc32), streamed with a known length.
 *
 * Safe names: clip names come from receipts, so they must match SEGMENT_NAME and
 * are joined to the segment folder only after that. Entry names in the ZIP are
 * made here, never copied from input.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { crc32 } from "node:zlib";
import { keccak256, toBytes, type Hex } from "viem";
import { segmentLink } from "../core/link.js";
import { verifyProof } from "../core/merkle.js";
import type { ReceiptV3 } from "../core/verify.js";
import { certificateHtml, VERIFIER_URL, type CertClip } from "./certificate.js";
import { esc, hidden } from "./html.js";
import { RECEIPT_NAME } from "./status.js";

export const SEGMENT_NAME = /^seg_[A-Za-z0-9_-]{1,64}\.(mp4|ts)$/;
export const MAX_RANGE_MS = 60 * 60_000;
export const MAX_ZIP_BYTES = 2 * 1024 ** 3;

// ---------------------------------------------------------------- zip writer

export interface ZipEntry {
  name: string;
  size: number;
  crc: number;
  mtime: Date;
  data: Buffer | { path: string };
}

const dosTime = (d: Date) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
const dosDate = (d: Date) => ((Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

function localHeader(e: ZipEntry): Buffer {
  const name = Buffer.from(e.name, "utf8");
  const h = Buffer.alloc(30 + name.length);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4); // version needed
  h.writeUInt16LE(0x0800, 6); // utf-8 names
  h.writeUInt16LE(0, 8); // stored
  h.writeUInt16LE(dosTime(e.mtime), 10);
  h.writeUInt16LE(dosDate(e.mtime), 12);
  h.writeUInt32LE(e.crc >>> 0, 14);
  h.writeUInt32LE(e.size, 18);
  h.writeUInt32LE(e.size, 22);
  h.writeUInt16LE(name.length, 26);
  name.copy(h, 30);
  return h;
}

function centralHeader(e: ZipEntry, offset: number): Buffer {
  const name = Buffer.from(e.name, "utf8");
  const h = Buffer.alloc(46 + name.length);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(0x031e, 4); // made by: unix, 3.0
  h.writeUInt16LE(20, 6);
  h.writeUInt16LE(0x0800, 8);
  h.writeUInt16LE(0, 10);
  h.writeUInt16LE(dosTime(e.mtime), 12);
  h.writeUInt16LE(dosDate(e.mtime), 14);
  h.writeUInt32LE(e.crc >>> 0, 16);
  h.writeUInt32LE(e.size, 20);
  h.writeUInt32LE(e.size, 24);
  h.writeUInt16LE(name.length, 28);
  h.writeUInt32LE(0o100644 << 16 >>> 0, 38);
  h.writeUInt32LE(offset, 42);
  name.copy(h, 46);
  return h;
}

function endRecord(count: number, cdSize: number, cdOffset: number): Buffer {
  const h = Buffer.alloc(22);
  h.writeUInt32LE(0x06054b50, 0);
  h.writeUInt16LE(count, 8);
  h.writeUInt16LE(count, 10);
  h.writeUInt32LE(cdSize, 12);
  h.writeUInt32LE(cdOffset, 16);
  return h;
}

export function memEntry(name: string, content: string | Buffer, mtime = new Date()): ZipEntry {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  return { name, size: data.length, crc: crc32(data), mtime, data };
}

/** Exact byte length of the ZIP (stored entries). */
export function zipLength(entries: ZipEntry[]): number {
  let n = 22;
  for (const e of entries) n += 30 + 46 + 2 * Buffer.byteLength(e.name) + e.size;
  return n;
}

/** Writes the ZIP to `out` with back pressure. Throws if a file changed while it was read. */
export async function writeZip(entries: ZipEntry[], out: Writable): Promise<void> {
  const put = (b: Buffer) => new Promise<void>((ok, fail) => {
    if (out.destroyed) return fail(new Error("connection closed"));
    if (out.write(b)) return ok();
    const onDrain = () => { cleanup(); ok(); };
    const onClose = () => { cleanup(); fail(new Error("connection closed")); };
    const cleanup = () => { out.off("drain", onDrain); out.off("close", onClose); };
    out.once("drain", onDrain);
    out.once("close", onClose);
  });
  let offset = 0;
  const central: Buffer[] = [];
  for (const e of entries) {
    central.push(centralHeader(e, offset));
    const head = localHeader(e);
    await put(head);
    offset += head.length;
    if (Buffer.isBuffer(e.data)) {
      await put(e.data);
    } else {
      let n = 0;
      let crc = 0;
      for await (const chunk of createReadStream(e.data.path) as AsyncIterable<Buffer>) {
        n += chunk.length;
        crc = crc32(chunk, crc);
        if (n > e.size) break;
        await put(chunk);
      }
      if (n !== e.size || crc !== e.crc) throw new Error(`${e.name} changed while the ZIP was written`);
    }
    offset += e.size;
  }
  const cd = Buffer.concat(central);
  await put(cd);
  await put(endRecord(entries.length, cd.length, offset));
}

// ---------------------------------------------------------------- local check

/** Does this clip match its receipt segment? Returns a plain reason when it does not. */
export function localCheck(r: ReceiptV3, file: string, sha256: Hex, sha3: Hex, size: number): string | undefined {
  if (r.format !== "qorewitness-receipt/v3") return "its receipt has an older format";
  const seg = r.segments.find((s) => s.file === file);
  if (!seg) return "its receipt does not list it";
  if (seg.sha256 !== sha256) return "it differs from what was sealed";
  if (seg.sha3_256 && seg.sha3_256 !== sha3) return "it differs from what was sealed (second fingerprint)";
  if (seg.size !== size) return "its size differs from the receipt";
  const link = segmentLink(toBytes(seg.prevLink), {
    fileHash: toBytes(sha256), fileSha3: seg.sha3_256 ? toBytes(sha3) : undefined, startMs: BigInt(seg.startMs), durationMs: seg.durationMs, sourceFp: toBytes(seg.sourceFp),
  });
  if ("0x" + Buffer.from(link).toString("hex") !== seg.link) return "its chain link does not match the receipt";
  if (!verifyProof(toBytes(r.root), link, seg.index, r.segments.length, seg.proof.map((p) => toBytes(p)))) return "its place in the sealed window does not match";
  return undefined;
}

async function fingerprints(path: string): Promise<{ sha256: Hex; sha3: Hex; size: number; crc: number }> {
  const a = createHash("sha256");
  const b = createHash("sha3-256");
  let size = 0;
  let crc = 0;
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    a.update(chunk);
    b.update(chunk);
    crc = crc32(chunk, crc);
    size += chunk.length;
  }
  return { sha256: `0x${a.digest("hex")}`, sha3: `0x${b.digest("hex")}`, size, crc };
}

// ---------------------------------------------------------------- plan

export interface PlanOptions {
  device: string;
  receiptDir: string;
  segmentDir: string;
  fromMs: number;
  toMs: number;
  /** Minutes east of UTC, for the certificate text. */
  tzMinutes?: number;
  now?: number;
  maxBytes?: number;
  account?: { registry?: string; owner?: string; deviceId?: string; keyFingerprint?: string };
}

export interface EvidencePlan {
  clips: CertClip[];
  /** Plain sentences for the owner: what is fine, what is missing. */
  problems: string[];
  /** Clips found but left out (failed check, file gone, older receipt). */
  leftOut: number;
  /** Clip files in the range that no receipt lists yet. */
  notSealed: number;
  coveredMs: number;
  rangeMs: number;
  zipBytes: number;
  tooLarge: boolean;
  zipName: string;
  entries: ZipEntry[];
}

const two = (n: number) => String(n).padStart(2, "0");
const tag = (ms: number, tz: number) => {
  const d = new Date(ms + tz * 60000);
  return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}-${two(d.getUTCHours())}${two(d.getUTCMinutes())}`;
};

function segmentStartFromName(name: string): number | undefined {
  const m = /^seg_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(name);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : undefined;
}

export function rangeProblem(fromMs: number, toMs: number): string | undefined {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return "Pick a date and a start and end time.";
  if (toMs <= fromMs) return "The end time must be after the start time.";
  if (toMs - fromMs > MAX_RANGE_MS) return "Pick at most 60 minutes at a time.";
  return undefined;
}

export async function planEvidence(o: PlanOptions): Promise<EvidencePlan> {
  const tz = o.tzMinutes ?? 0;
  const problems: string[] = [];
  const bad = rangeProblem(o.fromMs, o.toMs);
  const empty = (): EvidencePlan => ({ clips: [], problems, leftOut: 0, notSealed: 0, coveredMs: 0, rangeMs: o.toMs - o.fromMs, zipBytes: 0, tooLarge: false, zipName: "", entries: [] });
  if (bad) return { ...empty(), problems: [bad] };

  // Receipts of windows near the range. The window start is in the file name.
  const margin = 3600;
  const names = existsSync(o.receiptDir) ? readdirSync(o.receiptDir) : [];
  const candidates = names
    .filter((f) => RECEIPT_NAME.test(f) && f.startsWith(`${o.device}-`))
    .filter((f) => {
      const s = Number(/-(\d+)\.json$/.exec(f)![1]);
      return s * 1000 >= o.fromMs - margin * 1000 && s * 1000 <= o.toMs + margin * 1000;
    })
    .sort();

  type Hit = { receiptFile: string; r: ReceiptV3; file: string; startMs: number; durationMs: number };
  const hits: Hit[] = [];
  const sealedFiles = new Set<string>();
  for (const f of candidates) {
    let r: ReceiptV3;
    try {
      r = JSON.parse(readFileSync(join(o.receiptDir, f), "utf8")) as ReceiptV3;
      if (!Array.isArray(r.segments)) continue;
    } catch {
      continue;
    }
    for (const s of r.segments) {
      if (typeof s.file === "string") sealedFiles.add(s.file);
      const start = Number(s.startMs);
      if (!SEGMENT_NAME.test(String(s.file)) || !Number.isFinite(start)) continue; // unsafe name: never read
      if (start < o.toMs && start + (s.durationMs || 0) > o.fromMs) hits.push({ receiptFile: f, r, file: s.file, startMs: start, durationMs: s.durationMs || 0 });
    }
  }
  hits.sort((a, b) => a.startMs - b.startMs);

  let notSealed = 0;
  if (existsSync(o.segmentDir)) {
    for (const f of readdirSync(o.segmentDir)) {
      const st = SEGMENT_NAME.test(f) ? segmentStartFromName(f) : undefined;
      if (st !== undefined && st >= o.fromMs && st < o.toMs && !sealedFiles.has(f)) notSealed++;
    }
  }

  const entries: ZipEntry[] = [];
  const clips: CertClip[] = [];
  const usedReceipts = new Map<string, ReceiptV3>();
  let leftOut = 0;
  const seen = new Set<string>();
  const failed: string[] = [];
  for (const h of hits) {
    if (seen.has(h.file)) continue;
    seen.add(h.file);
    const path = join(o.segmentDir, h.file);
    let st;
    try {
      st = lstatSync(path);
    } catch {
      leftOut++;
      failed.push(`${h.file} is no longer on this box`);
      continue;
    }
    if (!st.isFile()) { // a link or folder: never follow
      leftOut++;
      failed.push(`${h.file} is not a normal file`);
      continue;
    }
    const fp = await fingerprints(path);
    const why = localCheck(h.r, h.file, fp.sha256, fp.sha3, fp.size);
    if (why) {
      leftOut++;
      failed.push(`${h.file}: ${why}`);
      continue;
    }
    usedReceipts.set(h.receiptFile, h.r);
    entries.push({ name: `clips/${h.file}`, size: fp.size, crc: fp.crc, mtime: st.mtime, data: { path } });
    clips.push({ file: h.file, startMs: h.startMs, durationMs: h.durationMs, sha256: fp.sha256, sha3: fp.sha3, block: h.r.chain.blockNumber, tx: h.r.chain.txHash });
  }

  // Covered time inside the asked range.
  let coveredMs = 0;
  let cursor = o.fromMs;
  for (const c of [...clips].sort((a, b) => a.startMs - b.startMs)) {
    const a = Math.max(c.startMs, cursor, o.fromMs);
    const b = Math.min(c.startMs + c.durationMs, o.toMs);
    if (b > a) {
      coveredMs += b - a;
      cursor = b;
    }
  }
  const rangeMs = o.toMs - o.fromMs;

  if (!clips.length) {
    problems.push(notSealed ? "The clips of this time are not sealed yet. Sealing takes about 10 minutes after the recording. Try again later." : "No sealed video was found for this time. Pick another time.");
    if (failed.length) problems.push(`${leftOut} clip(s) were found but could not be used.`);
    return { ...empty(), leftOut, notSealed, rangeMs, problems };
  }
  if (rangeMs - coveredMs > 10_000) problems.push(`About ${Math.max(1, Math.round((rangeMs - coveredMs) / 60000))} minute(s) of this time have no sealed video. The ZIP holds only what exists.`);
  if (notSealed) problems.push(`${notSealed} clip(s) of this time are not sealed yet. Try again in 10 minutes to include them.`);
  if (leftOut) problems.push(`${leftOut} clip(s) were left out because they no longer match their receipt or are gone. ${failed.slice(0, 3).join("; ")}.`);

  const now = o.now ?? Date.now();
  const camera = [...usedReceipts.values()][0].deviceLabel || o.device;
  const first = [...usedReceipts.values()][0];
  const cert = certificateHtml({
    camera, clips, leftOut, uncoveredMinutes: Math.max(0, (rangeMs - coveredMs) / 60000), tzMinutes: tz, createdAtMs: now,
    registry: o.account?.registry ?? first.chain.registry, owner: o.account?.owner ?? first.owner, deviceId: o.account?.deviceId ?? first.deviceId,
    keyFingerprint: o.account?.keyFingerprint ?? keccak256(first.devicePubkey).slice(0, 18), chainId: first.chain.evmChainId,
  });
  const when = new Date(now);
  for (const [name, r] of usedReceipts) entries.push(memEntry(`receipts/${name}`, JSON.stringify(r, null, 2) + "\n", when));
  entries.push(memEntry("certificate.html", cert, when));
  entries.push(memEntry("HOW-TO-CHECK.txt", howTo(clips.length), when));
  const zipBytes = zipLength(entries);
  const max = o.maxBytes ?? MAX_ZIP_BYTES;
  const tooLarge = zipBytes > max;
  if (tooLarge) problems.unshift(`This is ${(zipBytes / 1e9).toFixed(1)} GB. The limit is ${(max / 1e9).toFixed(1)} GB. Pick a shorter time range.`);
  const zipName = `evidence-${o.device.replace(/[^a-z0-9-]/gi, "")}-${tag(o.fromMs, tz)}.zip`;
  return { clips, problems, leftOut, notSealed, coveredMs, rangeMs, zipBytes, tooLarge, zipName, entries: tooLarge ? [] : entries };
}

function howTo(n: number): string {
  return `HOW TO CHECK THIS EVIDENCE
=========================

This ZIP holds ${n} original video clip${n === 1 ? "" : "s"} from a QoreWitness camera box, their receipts and a certificate.

Step 1. Open the checker
  Go to ${VERIFIER_URL}
  (You need an internet connection. Your video does not leave your device.)

Step 2. Drop this ZIP file on the page
  Do not unpack it first. Press "Check".

Step 3. Read the big result
  Green "Original": the video is unchanged since it was recorded.
  Orange: unchanged, but read the notes.
  Red: the video was changed after it was sealed, or it cannot be confirmed.
  Press "Print this result" to keep a copy for a file.

To watch the video, open the files in the "clips" folder with any video player.
To read or print the certificate, open certificate.html in a browser.
`;
}

// ---------------------------------------------------------------- pages

export interface Range { fromMs: number; toMs: number; tzMinutes: number }

/** Form to range. "last" means the last hour. Otherwise exact ms from the check page, or date and times in the browser's zone. */
export function parseRange(f: Record<string, string>, nowMs: number): Range | undefined {
  const tzRaw = Number.parseInt(f.tz ?? "0", 10);
  const tzMinutes = Number.isFinite(tzRaw) ? Math.max(-840, Math.min(840, tzRaw)) : 0;
  if (f.last) return { fromMs: nowMs - 3600_000, toMs: nowMs, tzMinutes };
  if (/^\d{10,14}$/.test(f.fromMs ?? "") && /^\d{10,14}$/.test(f.toMs ?? "")) return { fromMs: Number(f.fromMs), toMs: Number(f.toMs), tzMinutes };
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(f.date ?? "");
  const a = /^(\d{2}):(\d{2})$/.exec(f.from ?? "");
  const b = /^(\d{2}):(\d{2})$/.exec(f.to ?? "");
  if (!d || !a || !b) return undefined;
  const base = Date.UTC(+d[1], +d[2] - 1, +d[3]) - tzMinutes * 60000;
  const fromMs = base + (+a[1] * 60 + +a[2]) * 60000;
  let toMs = base + (+b[1] * 60 + +b[2]) * 60000;
  if (toMs <= fromMs) toMs += 24 * 3600_000; // an end before the start means after midnight
  return { fromMs, toMs, tzMinutes };
}

export function evidenceForm(csrf: string): string {
  return `<div class="card"><h2 style="margin-top:0">Save evidence</h2>
<p>Get one file with the original video of a time you pick, ready to give to an insurer, the police or a lawyer. Up to 60 minutes at a time.</p>
<form id="evf" method="post" action="/evidence/check">${hidden("_csrf", csrf)}${hidden("tz", "0")}
<div class="facts" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">
<div><label for="evd" style="margin-top:0">Date</label><input id="evd" type="date" name="date"></div>
<div><label for="evfrom" style="margin-top:0">From</label><input id="evfrom" type="time" name="from"></div>
<div><label for="evto" style="margin-top:0">To</label><input id="evto" type="time" name="to"></div>
</div>
<div class="row"><button type="submit">Check this time</button><button class="secondary" type="submit" name="last" value="1" formnovalidate>Last hour</button></div>
</form></div>`;
}

const mb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);

export function evidencePage(v: { plan?: EvidencePlan; range?: Range; problems?: string[] }, csrf: string): string {
  const plan = v.plan;
  const problems = v.problems ?? plan?.problems ?? [];
  const list = problems.length ? `<ul>${problems.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : "";
  let body: string;
  if (plan && plan.entries.length && v.range) {
    const minutes = Math.max(1, Math.round(plan.coveredMs / 60000));
    body = `<div class="status ok" role="status"><span class="dot"></span><div><strong>${esc(plan.clips.length)} clip${plan.clips.length === 1 ? "" : "s"} ready, about ${esc(minutes)} minute${minutes === 1 ? "" : "s"} of video</strong><p>Each clip was checked against its receipt on this box.</p></div></div>
${list ? `<div class="note"><strong>Please note</strong>${list}</div>` : ""}
<form method="post" action="/evidence/download">${hidden("_csrf", csrf)}${hidden("fromMs", String(v.range.fromMs))}${hidden("toMs", String(v.range.toMs))}${hidden("tz", String(v.range.tzMinutes))}
<button type="submit">Download evidence (${esc(mb(plan.zipBytes))})</button> <a class="btn secondary" href="/">Back</a></form>
<p class="muted" style="margin-top:14px">The ZIP holds the original clips, their receipts, a certificate to print and a short how-to. The receiver drops it on the public checker.</p>`;
  } else {
    body = `<div class="status warn" role="status"><span class="dot"></span><div><strong>No evidence file for this time</strong></div></div>${list ? `<div class="note">${list}</div>` : ""}<a class="btn" href="/">Back</a>`;
  }
  return `<div class="card"><div class="eyebrow">Save evidence</div><h1>Your evidence file</h1>${body}</div>`;
}
