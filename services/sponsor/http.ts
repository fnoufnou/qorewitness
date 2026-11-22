/**
 * HTTP API (Node's built-in server). Behind nginx at /sponsor/, which strips the
 * prefix. JSON only, small bodies, per-IP rate limits kept in memory only.
 *
 *   POST /v1/challenge {deviceId}                                   -> {nonce, expires, expiresAt}
 *   POST /v1/enroll {deviceId, owner, nonce, signature, devicePubkey[, pilotCode]}
 *                                                                   -> {status, capPerDayUqor, note}
 *   GET  /v1/status/<deviceId>[?owner=0x..]                         -> {status, state, startGrant, lastTopUp, usedTodayUqor, capPerDayUqor}
 *
 * status is one of the words the setup wizard reads (src/web/sponsor.ts): enrolled,
 * pending, funded, active, full, invalid_code, used_code, paused, rejected. Refusals
 * carry their word with HTTP 403 (invalid_code, used_code, rejected), 409 (full) or
 * 423 (paused), so the client never sees them as a server error.
 *   GET  /healthz
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ApiError, type Sponsor } from "./service.js";
import { AlertThrottle, truncateIp, type Logger } from "./log.js";

const MAX_BODY = 16 * 1024;

/** Requests per minute per IP and route. */
export const RATE_LIMITS: Record<string, number> = { challenge: 10, enroll: 5, status: 30, healthz: 60 };

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly limits = RATE_LIMITS, private readonly windowMs = 60_000) {}

  allow(ip: string, route: string, nowMs = Date.now()): boolean {
    const key = `${route}|${ip}`;
    const list = (this.hits.get(key) ?? []).filter((t) => t > nowMs - this.windowMs);
    const ok = list.length < (this.limits[route] ?? 30);
    if (ok) list.push(nowMs);
    this.hits.set(key, list);
    if (this.hits.size > 50_000) this.sweep(nowMs);
    return ok;
  }

  private sweep(nowMs: number): void {
    for (const [k, v] of this.hits) if (!v.some((t) => t > nowMs - this.windowMs)) this.hits.delete(k);
  }
}

export function clientIp(req: IncomingMessage, trusted: readonly string[]): string {
  const peer = req.socket.remoteAddress ?? "";
  if (trusted.includes(peer)) {
    const real = req.headers["x-real-ip"];
    if (typeof real === "string" && real) return real.trim();
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd) return fwd.split(",").at(-1)!.trim();
  }
  return peer;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers["content-type"] ?? "";
  if (!type.startsWith("application/json")) throw new ApiError(415, "bad_type", "send application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new ApiError(413, "too_large", "request body too large");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "bad_json", "body is not valid JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  });
  res.end(text);
}

export function createSponsorServer(
  sponsor: Sponsor, log: Logger, trusted: readonly string[], limiter = new RateLimiter(), alerts = new AlertThrottle(log),
): Server {
  return createServer(async (req, res) => {
    const ip = clientIp(req, trusted);
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/^\/sponsor(?=\/)/, "");
    let route = "unknown";
    try {
      if (req.method === "GET" && path === "/healthz") {
        route = "healthz";
        if (!limiter.allow(ip, route)) throw new ApiError(429, "rate_limited", "too many requests");
        return send(res, 200, sponsor.health());
      }
      if (req.method === "POST" && path === "/v1/challenge") {
        route = "challenge";
        if (!limiter.allow(ip, route)) throw new ApiError(429, "rate_limited", "too many requests");
        return send(res, 200, sponsor.challenge(await readJson(req)));
      }
      if (req.method === "POST" && path === "/v1/enroll") {
        route = "enroll";
        if (!limiter.allow(ip, route)) throw new ApiError(429, "rate_limited", "too many requests");
        const out = await sponsor.enroll(await readJson(req), ip);
        log.info("http_enroll", { ip: truncateIp(ip), result: out.status });
        return send(res, 200, out);
      }
      const m = /^\/v1\/status\/(0x[0-9a-fA-F]{64})$/.exec(path);
      if (req.method === "GET" && m) {
        route = "status";
        if (!limiter.allow(ip, route)) throw new ApiError(429, "rate_limited", "too many requests");
        return send(res, 200, sponsor.status(m[1], url.searchParams.get("owner") ?? undefined));
      }
      throw new ApiError(404, "not_found", "unknown route");
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status !== 404 && e.status !== 429) log.warn("http_refused", { ip: truncateIp(ip), route, code: e.code });
        return send(res, e.status, { ...(e.word ? { status: e.word, capPerDayUqor: sponsor.cfg.capCameraDayUqor.toString() } : {}), error: e.code, message: e.message });
      }
      alerts.fire("http_error", { ip: truncateIp(ip), route, error: e instanceof Error ? e.message.split("\n")[0] : "error" });
      return send(res, 502, { error: "upstream", message: "chain or server error, try again later" });
    }
  });
}
