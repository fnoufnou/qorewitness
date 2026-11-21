/**
 * Camera helpers for the browser setup: Tapo C210 stream URL, a test that grabs
 * one picture with ffmpeg, plain-language errors and a retention proposal.
 *
 * Tapo C210 (TP-Link FAQ 2680 and 4465): camera account from the Tapo app
 * (camera > gear > Advanced Settings > Camera Account), 6 to 32 characters.
 * rtsp://USER:PASS@IP:554/stream1 (high quality) or /stream2 (standard).
 *
 * The test opens the stream once (the C210 allows only two streams at a time),
 * reads codec, size and frame rate from ffmpeg's own stream line and decodes one
 * frame to JPEG. ffmpeg output is redacted before it goes anywhere.
 */
import { spawn } from "node:child_process";
import { redactSecrets } from "../core/redact.js";

export type StreamPath = "stream1" | "stream2";

export interface TapoInput {
  host: string;
  user: string;
  password: string;
  path: StreamPath;
  port?: number;
}

/** IPv4 address or a plain host name. No user info, path or spaces. */
export function cameraHostProblem(host: string): string | undefined {
  const h = host.trim();
  if (!h) return "Type the IP address of the camera. The Tapo app shows it under Device Info.";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    return h.split(".").every((n) => Number(n) <= 255) ? undefined : "This IP address is not valid.";
  }
  return /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(h) ? undefined : "Type only the IP address, for example 192.168.1.20.";
}

export function cameraAccountProblem(user: string, password: string): string | undefined {
  if (user.length < 1 || user.length > 32) return "The camera account user name has 1 to 32 characters.";
  if (password.length < 6 || password.length > 32) return "The camera account password has 6 to 32 characters.";
  if (/[\r\n\0]/.test(user + password)) return "The user name or password holds a character that is not allowed.";
  return undefined;
}

/** rtsp://USER:PASS@IP:554/stream1 with user and password URL-encoded. */
export function tapoUrl(c: TapoInput): string {
  const problem = cameraHostProblem(c.host) ?? cameraAccountProblem(c.user, c.password);
  if (problem) throw new Error(problem);
  return `rtsp://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${c.host.trim()}:${c.port ?? 554}/${c.path}`;
}

/** Reads host, user, password and path back from a saved stream URL (for "use standard quality"). */
export function parseStreamUrl(url: string): (TapoInput & { scheme: string }) | undefined {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/^\//, "");
    return {
      scheme: u.protocol.replace(":", ""),
      host: u.hostname,
      port: u.port ? Number(u.port) : undefined,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      path: path === "stream2" ? "stream2" : "stream1",
    };
  } catch {
    return undefined;
  }
}

export type CameraErrorKind = "auth" | "unreachable" | "busy" | "not_found" | "no_video" | "timeout" | "no_ffmpeg" | "unknown";

/** Plain words for the owner. No error codes and no URLs. */
export const CAMERA_ERRORS: Record<CameraErrorKind, string> = {
  auth: "The camera refused the password. Check Camera Account in the Tapo app (camera > gear > Advanced Settings > Camera Account).",
  unreachable: "No camera answers at this address. Check the IP address in the Tapo app (Device Info) and that the camera has power and Wi-Fi.",
  busy: "The camera is busy. It sends at most two video streams at a time. Close the live view in the Tapo app and try again.",
  not_found: "The camera answers but has no video stream at this address. Check that it is a Tapo C210, or try standard quality.",
  no_video: "The camera sends no picture. If Tapo Care, a microSD card and another recorder are all on, turn one off: only two of the three work at a time.",
  timeout: "The camera did not send a picture within 15 seconds. Check Wi-Fi strength near the camera and try again.",
  no_ffmpeg: "The test tool is missing on this box. Install QoreWitness with the official image.",
  unknown: "The camera test did not work. Check the IP address, user name and password, then try again.",
};

export function classifyFfmpegError(stderr: string, timedOut: boolean): CameraErrorKind {
  const s = stderr.toLowerCase();
  if (/401|unauthorized|authorization failed/.test(s)) return "auth";
  if (/453|not enough bandwidth|503|service unavailable/.test(s)) return "busy";
  if (/404|not found|461|unsupported transport/.test(s)) return "not_found";
  if (/connection refused|no route to host|network is unreachable|host is unreachable|name or service not known|could not resolve/.test(s)) return "unreachable";
  if (/connection timed out|timed out/.test(s)) return "unreachable";
  if (/could not find codec parameters|does not contain any stream|output file is empty|nothing was encoded/.test(s)) return "no_video";
  if (timedOut) return "timeout";
  return "unknown";
}

export interface StreamInfo {
  codec?: string;
  width?: number;
  height?: number;
  fps?: number;
}

/** Parses ffmpeg's input line, e.g. "Stream #0:0: Video: h264 (Main), yuv420p(progressive), 2304x1296, 15 fps". */
export function parseStreamInfo(stderr: string): StreamInfo {
  const line = /Stream #\d+:\d+[^:]*: Video: ([^\n]+)/.exec(stderr)?.[1];
  if (!line) return {};
  const size = /\b(\d{2,5})x(\d{2,5})\b/.exec(line);
  const fps = /([\d.]+) fps/.exec(line);
  return {
    codec: /^([a-z0-9_]+)/i.exec(line)?.[1],
    width: size ? Number(size[1]) : undefined,
    height: size ? Number(size[2]) : undefined,
    fps: fps ? Number(fps[1]) : undefined,
  };
}

export type SnapshotResult =
  | { ok: true; jpeg: Buffer; info: StreamInfo }
  | { ok: false; kind: CameraErrorKind; message: string; detail: string };

export interface SnapshotOptions {
  timeoutMs?: number;
  ffmpeg?: string; // binary, for tests
}

const MAX_JPEG = 8 * 1024 * 1024;

/** Opens the stream once and returns one JPEG frame, or a plain error. `detail` is redacted. */
export function snapshot(url: string, opts: SnapshotOptions = {}): Promise<SnapshotResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const input = url.startsWith("rtsp") ? ["-rtsp_transport", "tcp", "-timeout", "10000000"] : ["-rw_timeout", "10000000"];
  const args = ["-hide_banner", "-nostdin", "-loglevel", "info", ...input, "-i", url, "-frames:v", "1", "-q:v", "4", "-f", "image2", "-c:v", "mjpeg", "pipe:1"];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(opts.ffmpeg ?? "ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return resolve({ ok: false, kind: "no_ffmpeg", message: CAMERA_ERRORS.no_ffmpeg, detail: "" });
    }
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      outBytes += d.length;
      if (outBytes > MAX_JPEG) child.kill("SIGKILL");
      else out.push(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      if (err.length < 64_000) err += d.toString("utf8");
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const kind = e.code === "ENOENT" ? "no_ffmpeg" : "unknown";
      resolve({ ok: false, kind, message: CAMERA_ERRORS[kind], detail: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const detail = redactSecrets(err).split("\n").filter((l) => l.trim()).slice(-6).join("\n");
      const jpeg = Buffer.concat(out);
      const isJpeg = jpeg.length > 100 && jpeg[0] === 0xff && jpeg[1] === 0xd8;
      if (code === 0 && isJpeg && !timedOut) return resolve({ ok: true, jpeg, info: parseStreamInfo(err) });
      const kind = classifyFfmpegError(err, timedOut);
      resolve({ ok: false, kind, message: CAMERA_ERRORS[kind], detail });
    });
  });
}

/**
 * Days of video that fit in about 70 percent of the free disk. Estimates, to be
 * measured with the real C210: about 20 GB a day for high quality, 5 GB for standard.
 */
export function proposeRetentionDays(freeBytes: number | undefined, path: StreamPath): number {
  if (!freeBytes || freeBytes <= 0) return 14;
  const perDay = (path === "stream1" ? 20 : 5) * 1e9;
  return Math.max(2, Math.min(30, Math.floor((freeBytes * 0.7) / perDay)));
}
