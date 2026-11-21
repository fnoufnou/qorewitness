/**
 * Sponsor state in one JSON file, written atomically (temp file, fsync, rename).
 * Payouts also go to an append-only JSON-lines log (time, devices, owner, amount, tx).
 * No IP addresses and no pilot codes in clear text are stored.
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export interface Enrollment {
  owner: string; // 0x, checksummed
  deviceId: string; // 0x, lowercase
  codeHash: string;
  enrolledAt: number; // unix seconds
  /** anchorCount already paid for (or present at enrolment). */
  paidAnchorCount: string; // bigint as decimal string
  paidAt: number; // unix seconds of the baseline
  lastTopUp?: { at: number; amountUqor: string; txHash: string };
}

export interface Payout {
  at: number;
  owner: string;
  devices: { deviceId: string; amountUqor: string }[];
  amountUqor: string;
  status: "pending" | "sent" | "refused" | "unknown";
  txHash?: string;
}

export interface DayUsage {
  globalUqor: string;
  owners: Record<string, string>;
  devices: Record<string, string>; // key: owner|deviceId
}

export interface SponsorState {
  version: 1;
  enrollments: Record<string, Enrollment>; // key: owner|deviceId
  /** codeHash -> owner the code is bound to. */
  codes: Record<string, string>;
  /** Usage per UTC day (YYYY-MM-DD). Older days are pruned. */
  days: Record<string, DayUsage>;
  /** Recent payouts (last 2 days) for the hourly outflow check. The full history is in the payout log. */
  recent: Payout[];
}

export const emptyState = (): SponsorState => ({ version: 1, enrollments: {}, codes: {}, days: {}, recent: [] });

export function loadState(path: string): SponsorState {
  if (!existsSync(path)) return emptyState();
  const s = JSON.parse(readFileSync(path, "utf8")) as SponsorState;
  if (s.version !== 1) throw new Error(`unknown state version in ${path}`);
  return { ...emptyState(), ...s };
}

export function saveState(path: string, s: SponsorState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(s, null, 1) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  try {
    const dfd = openSync(dirname(path), "r");
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
  } catch {
    // Directory fsync is not supported everywhere. The rename is still atomic.
  }
}

export function appendPayoutLog(path: string, p: Payout): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, JSON.stringify({ ...p, time: new Date(p.at * 1000).toISOString() }) + "\n", { mode: 0o600 });
}

export const enrollmentKey = (owner: string, deviceId: string) => `${owner.toLowerCase()}|${deviceId.toLowerCase()}`;

export const utcDay = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
