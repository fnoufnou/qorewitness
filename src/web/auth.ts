/**
 * Access control for the local dashboard and the browser setup. Node built-ins only.
 *
 * - First run: a pairing token (24 random bytes) and a 6-digit pairing code in
 *   /data/ui/setup-token (mode 600). install.sh prints the link with the token
 *   and the code. The token (or the code) proves that the person sits at the box.
 *   It is deleted when the owner sets the dashboard password.
 * - After that: a password (scrypt), a signed session cookie (30 days), a CSRF
 *   token per session, 5 failed logins per minute.
 * - Every request: Host allowlist (blocks DNS rebinding), no X-Forwarded-For
 *   unless QW_UI_TRUST_PROXY=1, private client address. Every POST: Origin must
 *   match Host.
 */
import { createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { writeSecretFile } from "../setup/steps.js";

export const SESSION_SECONDS = 30 * 24 * 3600;
export const MIN_PASSWORD = 10;

export function safeEqual(given: string | undefined, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- pairing (first run)

export interface Pairing {
  token: string;
  code: string; // 6 digits
  createdAt: string;
}

const tokenPath = (uiDir: string) => join(uiDir, "setup-token");
const authPath = (uiDir: string) => join(uiDir, "auth.json");

export function readPairing(uiDir: string): Pairing | undefined {
  try {
    const p = JSON.parse(readFileSync(tokenPath(uiDir), "utf8")) as Pairing;
    return typeof p.token === "string" && /^\d{6}$/.test(p.code) ? p : undefined;
  } catch {
    return undefined;
  }
}

/** Creates the pairing token once. Does nothing when a password exists already. */
export function ensurePairing(uiDir: string): { pairing?: Pairing; created: boolean } {
  if (hasPassword(uiDir)) return { created: false };
  const old = readPairing(uiDir);
  if (old) return { pairing: old, created: false };
  const pairing: Pairing = {
    token: randomBytes(24).toString("base64url"),
    code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
    createdAt: new Date().toISOString(),
  };
  writeSecretFile(tokenPath(uiDir), JSON.stringify(pairing) + "\n");
  return { pairing, created: true };
}

export function clearPairing(uiDir: string): void {
  rmSync(tokenPath(uiDir), { force: true });
}

// ---------------------------------------------------------------- password and sessions

interface AuthFile {
  v: 1;
  salt: string;
  hash: string;
  secret: string; // HMAC key for sessions and CSRF tokens
  setAt: string;
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password: string, salt: string): string {
  return scryptSync(password.normalize("NFKC"), Buffer.from(salt, "base64url"), 32, SCRYPT).toString("base64url");
}

export function passwordProblem(pw: string, again?: string): string | undefined {
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (pw.length > 200) return "Use at most 200 characters.";
  if (again !== undefined && pw !== again) return "The two passwords are not the same.";
  return undefined;
}

function readAuth(uiDir: string): AuthFile | undefined {
  try {
    const a = JSON.parse(readFileSync(authPath(uiDir), "utf8")) as AuthFile;
    return a.v === 1 && a.hash && a.secret ? a : undefined;
  } catch {
    return undefined;
  }
}

export const hasPassword = (uiDir: string) => existsSync(authPath(uiDir)) && readAuth(uiDir) !== undefined;

/** Sets (or replaces) the password. A new secret ends every older session. */
export function setPassword(uiDir: string, password: string): void {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const salt = randomBytes(16).toString("base64url");
  const file: AuthFile = { v: 1, salt, hash: hashPassword(password, salt), secret: randomBytes(32).toString("base64url"), setAt: new Date().toISOString() };
  writeSecretFile(authPath(uiDir), JSON.stringify(file) + "\n");
}

export function checkPassword(uiDir: string, password: string): boolean {
  const a = readAuth(uiDir);
  if (!a || password.length > 200) return false;
  return safeEqual(hashPassword(password, a.salt), a.hash);
}

export function sessionSecret(uiDir: string): string | undefined {
  return readAuth(uiDir)?.secret;
}

const mac = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("base64url");

/** Session cookie value: "<expiry>.<random>.<hmac>". */
export function issueSession(secret: string, now = Date.now()): string {
  const body = `${Math.floor(now / 1000) + SESSION_SECONDS}.${randomBytes(9).toString("base64url")}`;
  return `${body}.${mac(secret, `session|${body}`)}`;
}

export function sessionValid(secret: string | undefined, value: string | undefined, now = Date.now()): boolean {
  if (!secret || !value) return false;
  const m = /^(\d{9,11})\.([A-Za-z0-9_-]{12})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m) return false;
  if (Number(m[1]) * 1000 < now) return false;
  return safeEqual(m[3], mac(secret, `session|${m[1]}.${m[2]}`));
}

/** CSRF token bound to one session (or to the pairing token before a password exists). */
export const csrfToken = (secret: string, session: string) => mac(secret, `csrf|${session}`);
export const csrfOk = (secret: string | undefined, session: string | undefined, given: string | undefined) =>
  !!secret && !!session && safeEqual(given, csrfToken(secret, session));

// ---------------------------------------------------------------- network checks

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function ipv6Private(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return ipv4Private(mapped[1]);
  return /^f[cd][0-9a-f]{2}:/.test(v) || /^fe[89ab][0-9a-f]:/.test(v);
}

export function privateAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  if (isIP(ip) === 4) return ipv4Private(ip);
  if (isIP(ip) === 6) return ipv6Private(ip);
  return false;
}

/** Splits a Host header into name and port. IPv6 literals come in brackets. */
export function parseHost(host: string | undefined): { name: string; port?: string } | undefined {
  if (!host || host.length > 255) return undefined;
  const m = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(host);
  if (!m) return undefined;
  return { name: m[1].toLowerCase(), port: m[2] };
}

/**
 * Host allowlist: private IP literals, localhost, *.local and the names in
 * QW_UI_HOSTNAME (comma separated). Any other name can be a DNS rebinding attack.
 */
export function hostAllowed(host: string | undefined, extraNames: string[] = []): boolean {
  const h = parseHost(host);
  if (!h) return false;
  const name = h.name.startsWith("[") ? h.name.slice(1, -1) : h.name;
  if (isIP(name)) return privateAddress(name);
  if (name === "localhost" || name.endsWith(".local")) return true;
  return extraNames.map((n) => n.trim().toLowerCase()).filter(Boolean).includes(name);
}

/** A POST must come from a page on this same host. "null" and a missing Origin are refused. */
export function originOk(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host || origin === "null") return false;
  try {
    const o = new URL(origin);
    return (o.protocol === "http:" || o.protocol === "https:") && o.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- rate limits

/** Counts failures per key in a sliding window. */
export class FailureLimiter {
  private readonly fails = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowMs: number) {}

  blocked(key: string, now = Date.now()): boolean {
    const list = (this.fails.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.fails.set(key, list);
    return list.length >= this.max;
  }

  fail(key: string, now = Date.now()): void {
    const list = (this.fails.get(key) ?? []).filter((t) => now - t < this.windowMs);
    list.push(now);
    this.fails.set(key, list);
  }

  reset(key: string): void {
    this.fails.delete(key);
  }
}
