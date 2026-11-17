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
  diskFreeBytes?: number;
  diskTotalBytes?: number;
}

/** Receipt files the agent writes: `<device>-<windowStart>.json`. */
export const RECEIPT_NAME = /^[a-z0-9-]{1,40}-\d{9,11}\.json$/;

export function summarize(file: string, json: string): AnchorSummary | undefined {
  try {
    const r = JSON.parse(json) as {
      windowStart?: string; windowSeconds?: number; segments?: { gapBeforeMs?: number; overlapMs?: number; sourceChanged?: boolean }[];
      chain?: { blockNumber?: string; txHash?: string }; generator?: { spec?: string };
    };
    if (!r.windowStart || !Array.isArray(r.segments)) return undefined;
    return {
      file,
      windowStart: Number(r.windowStart),
      windowSeconds: r.windowSeconds ?? 0,
      segments: r.segments.length,
      blockNumber: r.chain?.blockNumber,
      txHash: r.chain?.txHash,
      spec: r.generator?.spec,
      warnings: r.segments.filter((s) => s.gapBeforeMs || s.overlapMs || s.sourceChanged).length,
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
  if (existsSync(opts.segmentDir)) {
    for (const f of readdirSync(opts.segmentDir)) {
      if (!f.startsWith("seg_")) continue;
      segmentFiles++;
      segmentBytes += statSync(join(opts.segmentDir, f)).size;
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
