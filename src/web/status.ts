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
      chain?: { blockNumber?: string; txHash?: string }; generator?: { spec?: string };
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
  return {
    device: opts.device,
    receipts: receipts.length,
    unanchored: files.filter((f) => f.startsWith(`unanchored-${opts.device}-`)),
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

export interface BoxFacts {
  windowSeconds: number;
  plan?: "self" | "sponsored";
  balanceUqor?: number; // undefined when the network could not be asked
  setupAgeSeconds?: number; // time since setup.done
  qor1?: string;
}

export interface BoxHealth {
  level: "ok" | "warn" | "bad"; // green, orange, red
  title: string;
  action?: string; // one thing the owner can do
  feeDaysLeft?: number;
}

/** "1 minute", "4 minutes". */
export const minutesText = (n: number) => `${n} minute${n === 1 ? "" : "s"}`;

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

/**
 * One plain sentence and one action. The first problem that matches wins:
 * unsealed windows, camera offline, fees, sealing stopped, first seal, disk.
 */
export function boxHealth(s: LocalStatus, f: BoxFacts): BoxHealth {
  const age = f.setupAgeSeconds ?? Infinity;
  const days = feeDaysLeft(f.balanceUqor, f.windowSeconds);
  // Self-managed only. The address is under Details: no crypto words on the main view.
  const addFees = "Add test tokens to your own account. The address is under Details.";
  const lastSealMin = s.lastAnchorAgeSeconds === undefined ? undefined : Math.max(0, Math.round(s.lastAnchorAgeSeconds / 60));
  if (s.unanchored.length) {
    return { level: "bad", title: "Some video could not be sealed.", action: "Check the internet connection of the computer that runs QoreWitness. If this stays, restart it.", feeDaysLeft: days };
  }
  const camOffline = s.newestSegmentAgeSeconds === undefined ? age > 600 : s.newestSegmentAgeSeconds > 300;
  if (camOffline) {
    return { level: "bad", title: "No video from the camera.", action: "Check the power and Wi-Fi of the camera.", feeDaysLeft: days };
  }
  if (days !== undefined && f.balanceUqor! < 3 * FEE_PER_SEAL_UQOR) {
    return f.plan === "sponsored"
      ? { level: "bad", title: "Sealing paused: the fees ran out.", action: "Free beta: we cover the network fees and top them up for you. If this stays for a day, the beta service may be paused or full.", feeDaysLeft: days }
      : { level: "bad", title: "Sealing paused: the fees ran out.", action: addFees, feeDaysLeft: days };
  }
  if (days !== undefined && f.plan !== "sponsored" && days < 3) {
    return { level: "warn", title: "Sealing pauses soon: fees are running out.", action: addFees, feeDaysLeft: days };
  }
  if (days !== undefined && f.plan === "sponsored" && days < 0.25) {
    return { level: "warn", title: "Sealing pauses soon: fees are running out.", action: "Free beta: we cover the network fees and top them up for you. Nothing to do now.", feeDaysLeft: days };
  }
  if (s.lastAnchorAgeSeconds === undefined) {
    return age > 1800
      ? { level: "bad", title: "No seal yet.", action: "Check the internet connection of the computer that runs QoreWitness. If this stays, restart it.", feeDaysLeft: days }
      : { level: "warn", title: "Waiting for the first seal.", action: "Your first seal arrives within about 15 minutes of the setup. Nothing to do.", feeDaysLeft: days };
  }
  if (s.lastAnchorAgeSeconds > 3 * f.windowSeconds) {
    return { level: "bad", title: `Sealing stopped ${minutesText(lastSealMin!)} ago.`, action: "Check the internet connection of the computer that runs QoreWitness. If this stays, restart it.", feeDaysLeft: days };
  }
  if (s.diskFreeBytes !== undefined && s.diskTotalBytes && s.diskFreeBytes / s.diskTotalBytes < 0.15) {
    return { level: "warn", title: "The disk is almost full.", action: "QoreWitness deletes the oldest video first. Connect a bigger disk to keep more.", feeDaysLeft: days };
  }
  return { level: "ok", title: `Sealing OK. Last seal ${lastSealMin! < 1 ? "less than a minute" : minutesText(lastSealMin!)} ago.`, feeDaysLeft: days };
}
