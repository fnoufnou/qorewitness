/**
 * Checks an evidence package (clips + receipts) and turns the results into one
 * plain verdict. No DOM and no network here: the chain check is passed in as
 * `verify`, so Node tests can run it with a stand-in.
 */
import { sha3_256 } from "@noble/hashes/sha3.js";
import type { ReceiptV2, ReceiptV3, Step, VerifyResult } from "../../src/core/verify.js";

export type AnyReceipt = ReceiptV2 | ReceiptV3;
export type VerifyFn = (r: AnyReceipt, sha256: Uint8Array, sha3: Uint8Array) => Promise<VerifyResult>;

export interface ClipInput { name: string; bytes: Uint8Array }
export interface ReceiptInput { name: string; receipt: AnyReceipt }

export type ClipKind = "ok" | "warn" | "changed" | "unconfirmed" | "error";
export interface ClipOutcome {
  file: string;
  kind: ClipKind;
  steps: Step[];
  startMs?: number;
  durationMs?: number;
  anchoredAt?: Date;
}
export interface Verdict {
  level: "ok" | "warn" | "bad";
  headline: string;
  detail: string;
  notes: string[];
  clips: ClipOutcome[];
}

export const baseName = (n: string) => n.split("/").pop()!;

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

interface SegLike { file: string; sha256: string; startMs: string; durationMs: number }
const segsOf = (r: AnyReceipt) => ((r as unknown as { segments?: SegLike[] }).segments ?? []);
const hexOf = (b: Uint8Array) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Which receipt belongs to a clip: same file name first, then same fingerprint, then the only receipt there is. */
export function pickReceipt(file: string, hash: Uint8Array, receipts: ReceiptInput[], onlyClip: boolean): { r: ReceiptInput; seg?: SegLike } | undefined {
  const name = baseName(file);
  const h = hexOf(hash);
  for (const r of receipts) {
    const seg = segsOf(r.receipt).find((s) => s.file === name);
    if (seg) return { r, seg };
  }
  for (const r of receipts) {
    const seg = segsOf(r.receipt).find((s) => s.sha256 === h);
    if (seg) return { r, seg };
  }
  if (onlyClip && receipts.length === 1) return { r: receipts[0] };
  return undefined;
}

const MAX_PARALLEL = 6;

export async function checkClips(clips: ClipInput[], receipts: ReceiptInput[], verify: VerifyFn, onProgress?: (done: number, total: number) => void): Promise<ClipOutcome[]> {
  const out: ClipOutcome[] = new Array(clips.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= clips.length) return;
      out[i] = await checkOne(clips[i], receipts, verify, clips.length === 1);
      onProgress?.(++done, clips.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, clips.length) }, worker));
  return out;
}

async function checkOne(clip: ClipInput, receipts: ReceiptInput[], verify: VerifyFn, onlyClip: boolean): Promise<ClipOutcome> {
  const file = baseName(clip.name);
  const h = await sha256(clip.bytes);
  const pick = pickReceipt(file, h, receipts, onlyClip);
  if (!pick) {
    return { file, kind: "unconfirmed", steps: [{ state: "fail", text: `No receipt in this package belongs to ${file}. Without its receipt a clip cannot be confirmed.` }] };
  }
  const base = { file, startMs: pick.seg ? Number(pick.seg.startMs) : undefined, durationMs: pick.seg?.durationMs };
  try {
    const res = await verify(pick.r.receipt, h, sha3_256(clip.bytes));
    const fails = res.steps.filter((s) => s.state === "fail");
    if (fails.length) {
      const changed = fails.some((s) => /fingerprint/i.test(s.text));
      return { ...base, kind: changed ? "changed" : "unconfirmed", steps: res.steps };
    }
    const warn = !res.ok || res.partial || res.steps.some((s) => s.state === "warn");
    return { ...base, kind: warn ? "warn" : "ok", steps: res.steps, anchoredAt: res.anchoredAt };
  } catch (e) {
    return { ...base, kind: "error", steps: [{ state: "fail", text: (e as Error).message.split("\n")[0] }] };
  }
}

const two = (n: number) => String(n).padStart(2, "0");
export function when(ms: number, locale?: string): { date: string; time: string } {
  const d = new Date(ms);
  return {
    date: d.toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" }),
    time: `${two(d.getHours())}:${two(d.getMinutes())}`,
  };
}

export function verdictOf(clips: ClipOutcome[], locale?: string): Verdict {
  const notes = [...new Set(clips.flatMap((c) => c.steps.filter((s) => s.state === "warn").map((s) => s.text)))];
  if (!clips.length) {
    return { level: "bad", headline: "Nothing to check", detail: "No video files were found. Drop a ZIP made by QoreWitness, or choose one clip and its receipt.", notes, clips };
  }
  const changed = clips.filter((c) => c.kind === "changed");
  const unconfirmed = clips.filter((c) => c.kind === "unconfirmed");
  const errors = clips.filter((c) => c.kind === "error");
  if (changed.length) {
    // Name a clip by its recording time. A file name means little to a receiver.
    const list = changed.slice(0, 3).map((c) => (c.startMs ? `the clip recorded at ${when(c.startMs, locale).time}` : c.file)).join(", ");
    return {
      level: "bad", headline: "Changed after sealing", clips, notes,
      detail: `${changed.length === clips.length ? "This video does" : `${changed.length} of ${clips.length} clips do`} not match what was sealed: ${list}${changed.length > 3 ? " and more" : ""}. Do not rely on it.`,
    };
  }
  if (unconfirmed.length) {
    return {
      level: "bad", headline: "Not confirmed", clips, notes,
      detail: `${unconfirmed.length === clips.length ? "This video" : `${unconfirmed.length} of ${clips.length} clips`} could not be confirmed. ${unconfirmed[0].steps.find((s) => s.state === "fail")?.text ?? ""}`.trim(),
    };
  }
  if (errors.length) {
    return {
      level: "warn", headline: "Check not finished", clips, notes,
      detail: `The check could not finish: ${errors[0].steps[0]?.text ?? "unknown error"} Check your internet connection and try again. Nothing was found to be wrong.`,
    };
  }
  const starts = clips.map((c) => c.startMs).filter((x): x is number => !!x);
  const ends = clips.map((c) => (c.startMs && c.durationMs ? c.startMs + c.durationMs : undefined)).filter((x): x is number => !!x);
  let recorded = "";
  if (starts.length) {
    const a = when(Math.min(...starts), locale);
    const e = ends.length ? when(Math.max(...ends), locale) : undefined;
    recorded = e && (e.time !== a.time || e.date !== a.date) ? ` on ${a.date} ${a.time} to ${e.date === a.date ? "" : e.date + " "}${e.time}` : ` on ${a.date} ${a.time}`;
  }
  let sealed = "";
  const delays = clips.map((c) => (c.anchoredAt && c.startMs ? c.anchoredAt.getTime() - (c.startMs + (c.durationMs ?? 0)) : undefined)).filter((x): x is number => x !== undefined);
  if (delays.length) { const m = Math.max(1, Math.ceil(Math.max(...delays) / 60000)); sealed = ` Sealed within ${m} minute${m === 1 ? "" : "s"}.`; }
  const subject = clips.length === 1 ? "This video is" : `These ${clips.length} clips are`;
  const base = `${subject} unchanged since ${clips.length === 1 ? "it was" : "they were"} recorded${recorded}.${sealed}`;
  if (clips.some((c) => c.kind === "warn")) {
    // Missing minutes and camera restarts are normal life for a home camera: say so calmly.
    const calm = notes.length > 0 && notes.every((n) => /of video (is|are) missing|video settings changed|overlaps the one before/.test(n));
    const line = calm
      ? ` ${clips.length === 1 ? "The video is" : "The clips are"} original. Some minutes are missing, for example when the camera was off.`
      : " Read the notes below.";
    return { level: "warn", headline: "Original, with notes", detail: `${base}${line}`, notes, clips };
  }
  return { level: "ok", headline: "Original", detail: base, notes, clips };
}
