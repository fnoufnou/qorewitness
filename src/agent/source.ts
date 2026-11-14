/**
 * Describes a recorded segment for the segment chain: start time, length and a
 * fingerprint of the stream (codec, size, frame rate, pixel format and the
 * encoder's own parameter sets). A clip from another camera, or a re-encoded
 * clip, gets another fingerprint. Uses ffprobe. Without ffprobe, or for a file
 * that is not a video, the fingerprint is 32 zero bytes.
 */
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { sourceDescription, sourceFingerprint } from "../core/link.js";

const run = promisify(execFile);

export interface SegmentSource {
  startMs: number; // unix ms of the first frame
  durationMs: number;
  source: string; // canonical description, empty if unknown
  sourceFp: Uint8Array;
}

/** seg_20261109T215258Z.mp4 -> unix ms. The recorder names segments by their start time (UTC). */
export function startFromName(path: string): number | undefined {
  const m = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(basename(path));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : undefined;
}

export async function probeSegment(path: string, completedAt: number): Promise<SegmentSource> {
  let durationMs = 0;
  let source = "";
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_data_hash", "SHA256",
      "-show_entries", "stream=codec_name,profile,width,height,r_frame_rate,pix_fmt,extradata_hash:format=duration",
      "-of", "json", path,
    ], { timeout: 30_000 });
    const j = JSON.parse(stdout) as { streams?: Record<string, string | number>[]; format?: { duration?: string } };
    durationMs = Math.round(Number(j.format?.duration ?? 0) * 1000) || 0;
    const s = j.streams?.[0];
    if (s) {
      source = sourceDescription({
        codec: s.codec_name, profile: s.profile, width: s.width, height: s.height,
        fps: s.r_frame_rate, pix: s.pix_fmt, extradata: s.extradata_hash,
      });
    }
  } catch {
    // no ffprobe, or not a media file: keep the defaults
  }
  const startMs = startFromName(path) ?? Math.max(0, completedAt * 1000 - durationMs);
  return { startMs, durationMs, source, sourceFp: sourceFingerprint(source) };
}
