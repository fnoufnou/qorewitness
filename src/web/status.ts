/**
 * Local status of one camera, read from the files the recorder and the agent
 * write. No network access and no keys: safe to show in the local dashboard.
 */
import { existsSync, readdirSync, readFileSync, statSync, statfsSync } from "node:fs";
import { join } from "node:path";

export interface AnchorSummary {
  file: string;
  windowStart: number; // unix seconds
  windowSeconds: number;
  segments: number;
  blockNumber?: string;
  txHash?: string;
  spec?: string;
  registry?: string; // the contract that holds the seal
  warnings: number; // segments with a gap, overlap or stream change
  videoStartMs?: number; // start of the first clip (real clip times, a first window can be partial)
  videoEndMs?: number; // end of the last clip
  videoMs: number; // total length of the clips
  bytes: number; // total size of the clips: about the size of the evidence file
}

export interface LocalStatus {
  device: string;
  receipts: number;
  unanchored: string[];
  unanchoredAgeSeconds?: number; // age of the newest window that could not be sealed
  latest: AnchorSummary[];
  lastAnchorAgeSeconds?: number;
  pendingWindows: number;
  openSegments: number;
  segmentFiles: number;
  segmentBytes: number;
  newestSegmentAgeSeconds?: number; // age of the newest change to a segment file: the camera is online if small
  diskFreeBytes?: number;
  diskTotalBytes?: number;
}

/** Receipt files the agent writes: `<device>-<windowStart>.json`. */
export const RECEIPT_NAME = /^[a-z0-9-]{1,40}-\d{9,11}\.json$/;

export function summarize(file: string, json: string): AnchorSummary | undefined {
  try {
    const r = JSON.parse(json) as {
      windowStart?: string; windowSeconds?: number;
      segments?: { gapBeforeMs?: number; overlapMs?: number; sourceChanged?: boolean; startMs?: string; durationMs?: number; size?: number }[];
      chain?: { blockNumber?: string; txHash?: string; registry?: string }; generator?: { spec?: string };
    };
    if (!r.windowStart || !Array.isArray(r.segments)) return undefined;
    const starts = r.segments.map((x) => Number(x.startMs)).filter((x) => Number.isFinite(x) && x > 0);
    const ends = r.segments.map((x) => Number(x.startMs) + (x.durationMs ?? 0)).filter((x) => Number.isFinite(x) && x > 0);
    return {
      file,
      windowStart: Number(r.windowStart),
      windowSeconds: r.windowSeconds ?? 0,
      segments: r.segments.length,
      blockNumber: r.chain?.blockNumber,
      txHash: r.chain?.txHash,
      spec: r.generator?.spec,
      registry: r.chain?.registry,
      warnings: r.segments.filter((s) => s.gapBeforeMs || s.overlapMs || s.sourceChanged).length,
      videoStartMs: starts.length ? Math.min(...starts) : undefined,
      videoEndMs: ends.length ? Math.max(...ends) : undefined,
      videoMs: r.segments.reduce((t, x) => t + (x.durationMs ?? 0), 0),
      bytes: r.segments.reduce((t, x) => t + (x.size ?? 0), 0),
    };
  } catch {
    return undefined;
  }
}

export function collectStatus(opts: { device: string; receiptDir: string; segmentDir: string; now?: number; latest?: number }): LocalStatus {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const files = existsSync(opts.receiptDir) ? readdirSync(opts.receiptDir) : [];
  const receipts = files.filter((f) => RECEIPT_NAME.test(f) && f.startsWith(`${opts.device}-`));
  receipts.sort((a, b) => Number(b.match(/-(\d+)\.json$/)![1]) - Number(a.match(/-(\d+)\.json$/)![1]));
  const latest: AnchorSummary[] = [];
  for (const f of receipts) {
    if (latest.length >= (opts.latest ?? 12)) break;
    const s = summarize(f, readFileSync(join(opts.receiptDir, f), "utf8"));
    if (s) latest.push(s);
  }
  let pendingWindows = 0;
  let openSegments = 0;
  const statePath = join(opts.receiptDir, `.state-${opts.device}.json`);
  if (existsSync(statePath)) {
    try {
      const st = JSON.parse(readFileSync(statePath, "utf8")) as { pending?: unknown[]; open?: unknown[] };
      pendingWindows = st.pending?.length ?? 0;
      openSegments = st.open?.length ?? 0;
    } catch {
      // A state file that is being replaced: show zeros rather than fail.
    }
  }
  let segmentFiles = 0;
  let segmentBytes = 0;
  let newestMtime = 0;
  if (existsSync(opts.segmentDir)) {
    for (const f of readdirSync(opts.segmentDir)) {
      if (!f.startsWith("seg_")) continue;
      segmentFiles++;
      try {
        const st = statSync(join(opts.segmentDir, f));
        segmentBytes += st.size;
        newestMtime = Math.max(newestMtime, st.mtimeMs);
      } catch {
        // Deleted by retention between readdir and stat.
      }
    }
  }
  let diskFreeBytes: number | undefined;
  let diskTotalBytes: number | undefined;
  try {
    const fs = statfsSync(existsSync(opts.segmentDir) ? opts.segmentDir : opts.receiptDir);
    diskFreeBytes = fs.bavail * fs.bsize;
    diskTotalBytes = fs.blocks * fs.bsize;
  } catch {
    // statfs is not available on every platform.
  }
  const newest = latest[0];
  const unanchored = files.filter((f) => f.startsWith(`unanchored-${opts.device}-`));
  const unanchoredStarts = unanchored.map((f) => Number(f.match(/-(\d{9,11})\.json$/)?.[1])).filter((n) => Number.isFinite(n));
  return {
    device: opts.device,
    receipts: receipts.length,
    unanchored,
    unanchoredAgeSeconds: unanchoredStarts.length ? Math.max(0, now - Math.max(...unanchoredStarts)) : undefined,
    latest,
    lastAnchorAgeSeconds: newest ? now - (newest.windowStart + newest.windowSeconds) : undefined,
    pendingWindows,
    openSegments,
    segmentFiles,
    segmentBytes,
    newestSegmentAgeSeconds: newestMtime ? Math.max(0, now - Math.floor(newestMtime / 1000)) : undefined,
    diskFreeBytes,
    diskTotalBytes,
  };
}

/** Plain-language health line for the dashboard header. */
export function health(s: LocalStatus, windowSeconds: number): { level: "ok" | "warn" | "bad"; text: string } {
  if (s.lastAnchorAgeSeconds === undefined) return { level: "warn", text: "No anchored window yet." };
  if (s.unanchored.length) return { level: "bad", text: `${s.unanchored.length} window(s) could not be anchored. See the files named unanchored-*.` };
  if (s.lastAnchorAgeSeconds > 3 * windowSeconds) {
    return { level: "bad", text: `No new anchor for ${Math.round(s.lastAnchorAgeSeconds / 60)} minutes. Check the agent log.` };
  }
  if (s.diskFreeBytes !== undefined && s.diskTotalBytes && s.diskFreeBytes / s.diskTotalBytes < 0.15) {
    return { level: "warn", text: "Less than 15% disk space left. Lower QW_RETENTION_DAYS or add storage." };
  }
  return { level: "ok", text: "Recording and anchoring normally." };
}

// ---------------------------------------------------------------- box health for owners (green, orange, red)

/** Seals per day at the default 10-minute window, and the fee per seal (docs/TESTNET_FINDINGS.md). */
export const FEE_PER_SEAL_UQOR = 48_000; // same as FEE_PER_ANCHOR_UQOR in src/setup/steps.ts


/** Extra facts the dashboard asks for. Each is undefined when it could not be checked: then its rule stays silent. */
export interface BoxFacts {
  windowSeconds: number;
  plan?: "self" | "sponsored";
  balanceUqor?: number; // undefined when the network could not be asked
  setupAgeSeconds?: number; // time since setup.done
  qor1?: string;
  /** Only asked while no new video arrives: true if the camera answers on its stream port. */
  cameraReachable?: boolean;
  /** Free beta only: what the fee service says about this camera. */
  sponsor?: SponsorFacts;
  /** True only when the seal contract is gone and the chain is lower than half our newest seal block (sealResetSeen). */
  networkReset?: boolean;
}

export interface SponsorFacts {
  paused: boolean; // the free beta stopped all top-ups for now
  limitReached: boolean; // this camera used its daily top-up limit
}

export interface BoxHealth {
  level: "ok" | "warn" | "bad"; // green, orange, red
  title: string; // what happened and since when
  action?: string; // one thing the owner can do
  feeDaysLeft?: number;
}

/** "1 minute", "4 minutes". */
export const minutesText = (n: number) => `${n} minute${n === 1 ? "" : "s"}`;

/** "less than a minute", "12 minutes", "about 3 hours", "about 2 days". */
export function durationText(seconds: number): string {
  if (seconds < 60) return "less than a minute";
  const min = Math.round(seconds / 60);
  if (min < 90) return minutesText(min);
  const h = Math.round(seconds / 3600);
  if (h < 36) return `about ${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(seconds / 86_400);
  return `about ${d} day${d === 1 ? "" : "s"}`;
}

/** "less than a day", "about 1 day", "about 4 days". */
export function daysText(days: number): string {
  if (days < 1) return "less than a day";
  const n = Math.floor(days);
  return `about ${n} day${n === 1 ? "" : "s"}`;
}

export function feeDaysLeft(balanceUqor: number | undefined, windowSeconds: number): number | undefined {
  if (balanceUqor === undefined) return undefined;
  const perDay = (86_400 / windowSeconds) * FEE_PER_SEAL_UQOR;
  return balanceUqor / perDay;
}

/** No new video for 5 minutes (or none at all 10 minutes after the setup). */
export function cameraStale(s: LocalStatus, setupAgeSeconds = Infinity): boolean {
  return s.newestSegmentAgeSeconds === undefined ? setupAgeSeconds > 600 : s.newestSegmentAgeSeconds > 300;
}

/** Reads the answer of the fee service (GET /v1/status). Unknown fields stay false. */
export function sponsorFacts(a: { status?: string; paused?: boolean; usedTodayUqor?: string; capPerDayUqor?: string }): SponsorFacts {
  const used = Number(a.usedTodayUqor);
  const cap = Number(a.capPerDayUqor);
  return {
    paused: a.paused === true || a.status === "paused",
    limitReached: Number.isFinite(used) && Number.isFinite(cap) && cap > 0 && used >= cap,
  };
}

/**
 * A test network reset removes every contract and starts again at block 1. So the
 * contract must be gone and the chain must be lower than half our newest seal block.
 * A node that is some days behind (no contract yet, head a little lower) gives no alarm.
 */
export function sealResetSeen(check: { hasCode: boolean; head: bigint }, newestSealBlock: string | undefined): boolean {
  if (check.hasCode || !newestSealBlock || !/^\d{1,20}$/.test(newestSealBlock)) return false;
  return check.head * 2n < BigInt(newestSealBlock);
}

/** Video that could not be sealed stays red for a day. After that the files stay on disk, listed under Details. */
const UNSEALED_SHOW_SECONDS = 86_400;

const CHECK_NET = "Check the internet connection of the computer that runs QoreWitness. If this stays, restart it.";

/**
 * One line in plain words: what happened, since when, and one thing to do.
 * The first problem that matches wins: network reset, unsealed video, camera,
 * fees, sealing stopped, first seal, disk.
 */
export function boxHealth(s: LocalStatus, f: BoxFacts): BoxHealth {
  const age = f.setupAgeSeconds ?? Infinity;
  const days = feeDaysLeft(f.balanceUqor, f.windowSeconds);
  const r = (level: BoxHealth["level"], title: string, action?: string): BoxHealth => ({ level, title, action, feeDaysLeft: days });
  // Self-managed only. The address is under Details: no crypto words on the main view.
  const addFees = "Add test tokens to your own account. The address is under Details.";
  const lastSeal = s.lastAnchorAgeSeconds === undefined ? undefined : Math.max(0, s.lastAnchorAgeSeconds);
  const late = lastSeal !== undefined && lastSeal > f.windowSeconds;

  if (f.networkReset) {
    return r("bad", "The test network was reset. Your earlier seals can no longer be checked.",
      "Download the evidence files you need now. Their video is still on this computer.");
  }
  if (s.unanchored.length && (s.unanchoredAgeSeconds ?? 0) < UNSEALED_SHOW_SECONDS) {
    // The agent keeps such a window only when the chain already holds another seal for that time.
    return r("bad", `Some video from ${durationText(s.unanchoredAgeSeconds ?? 0)} ago could not be sealed.`,
      "Make sure QoreWitness runs on one computer only for this camera.");
  }
  if (cameraStale(s, age)) {
    const since = s.newestSegmentAgeSeconds === undefined ? undefined : durationText(s.newestSegmentAgeSeconds);
    if (f.cameraReachable === true) {
      return r("bad", since ? `Recording stopped ${since} ago. The camera is on, but sends no video.` : "Recording has not started. The camera is on, but sends no video.",
        "Restart the computer that runs QoreWitness. If this stays, check the camera account in the camera app.");
    }
    return r("bad", since ? `No video from the camera for ${since}.` : "No video from the camera yet.", "Check the power and Wi-Fi of the camera.");
  }
  if (days !== undefined && f.balanceUqor! < 3 * FEE_PER_SEAL_UQOR) {
    const paused = late ? `Sealing paused ${durationText(lastSeal!)} ago` : "Sealing paused";
    if (f.plan !== "sponsored") return r("bad", `${paused}: the fees ran out.`, addFees);
    if (f.sponsor?.paused) return r("bad", `${paused}: the free beta is paused.`, "Nothing to do. Your camera keeps recording, and we seal the waiting video when the free beta is back.");
    if (f.sponsor?.limitReached) return r("bad", `${paused}: today's free beta limit is reached.`, "Nothing to do. Your camera keeps recording, and we seal the waiting video after midnight (UTC).");
    return r("bad", `${paused}: the fees ran out.`, "We top up the fees for you. Nothing to do.");
  }
  if (days !== undefined && f.plan !== "sponsored" && days < 3) {
    return r("warn", `Fees are running low. Sealing pauses in ${daysText(days)}.`, addFees);
  }
  if (f.plan === "sponsored" && f.sponsor?.paused) {
    return r("warn", `The free beta paused its fee top-ups.${days === undefined ? "" : ` Your fees last ${daysText(days)}.`}`,
      "Nothing to do now. Sealing goes on with the fees you have.");
  }
  if (days !== undefined && f.plan === "sponsored" && days < 0.25) {
    return r("warn", "Sealing pauses soon: fees are running out.", "We top up the fees for you. Nothing to do now.");
  }
  if (lastSeal === undefined) {
    return age > 1800
      ? r("bad", `No seal yet, ${durationText(age)} after the setup.`, CHECK_NET)
      : r("warn", "Waiting for the first seal.", "Your first seal arrives within about 15 minutes of the setup. Nothing to do.");
  }
  if (lastSeal > 3 * f.windowSeconds) {
    return r("bad", `Sealing stopped ${durationText(lastSeal)} ago.`, CHECK_NET);
  }
  if (s.diskFreeBytes !== undefined && s.diskTotalBytes && s.diskFreeBytes / s.diskTotalBytes < 0.15) {
    return r("warn", `The disk is almost full: ${Math.floor(s.diskFreeBytes / 1e9)} GB free.`, "QoreWitness deletes the oldest video first. Connect a bigger disk to keep more.");
  }
  return r("ok", `Sealing OK. Last seal ${durationText(lastSeal)} ago.`);
}
