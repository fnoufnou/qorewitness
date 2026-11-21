/**
 * Sponsor state in one JSON file, written atomically (temp file, fsync, rename).
 * Payouts also go to an append-only JSON-lines log (time, devices, owner, amount, tx).
 * No IP addresses are stored.
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * pending:  enrolled before the camera is on chain, start grant not sent yet (or retrying)
 * funded:   start grant sent, waiting for the camera registration on chain
 * active:   on chain with the enrolled key and owner, refills apply
 * rejected: on-chain key or owner differs, or the device was revoked. Final
 * expired:  not registered within 48 h of enrolment. Final, the code stays used
 */
export type EnrollmentState = "pending" | "funded" | "active" | "rejected" | "expired";

export interface Grant {
  status: "pending" | "sent" | "refused" | "unknown";
  amountUqor: string;
  at: number;
  attempts: number;
  txHash?: string;
}

export interface Enrollment {
  owner: string; // 0x, lower case
  deviceId: string; // 0x, lower case
  /** keccak256 of the device public key: from the chain, or of the enrolled devicePubkey. */
  keyHash: string;
  path: "onchain" | "bootstrap";
  state: EnrollmentState;
  reason?: string;
  enrolledAt: number; // unix seconds
  activatedAt?: number;
  grant?: Grant;
  /** anchorCount already paid for (or present at activation). */
  paidAnchorCount: string; // bigint as decimal string
  paidAt: number; // unix seconds of the baseline
  lastTopUp?: { at: number; amountUqor: string; txHash: string };
}

export interface Payout {
  at: number;
  kind: "grant" | "refill";
  owner: string;
  devices: { deviceId: string; amountUqor: string }[];
  amountUqor: string;
  status: "pending" | "sent" | "refused" | "unknown";
  txHash?: string;
}

export interface DayUsage {
  globalUqor: string;
  /** Start grants admitted this day. */
  grants?: number;
  owners: Record<string, string>;
  devices: Record<string, string>; // key: owner|deviceId
}

export interface SponsorState {
  version: 1;
  enrollments: Record<string, Enrollment>; // key: owner|deviceId
  /** Usage per UTC day (YYYY-MM-DD). Older days are pruned. */
  days: Record<string, DayUsage>;
  /** Recent payouts (last 2 days) for the hourly outflow check. The full history is in the payout log. */
  recent: Payout[];
}

export const emptyState = (): SponsorState => ({ version: 1, enrollments: {}, days: {}, recent: [] });

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
