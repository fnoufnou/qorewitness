/**
 * Client for the fee sponsor of the free beta ("Free beta: we cover the network fees"). The sponsor service
 * sends test QOR to the owner account of a box with a valid pilot code.
 *
 * Contract (implemented by the sponsor service):
 *   POST {SPONSOR_URL}/v1/challenge {deviceId}                 -> {nonce, expires}
 *   POST {SPONSOR_URL}/v1/enroll {deviceId, owner, nonce, signature, devicePubkey[, pilotCode]}
 *                                                              -> {status, capPerDayUqor}
 *   GET  {SPONSOR_URL}/v1/status/<deviceId>?owner=<owner>      -> {status, ...}
 *
 * The pilot is open within its cap: the box sends no pilot code. Every box uses the
 * same camera name, so device ids repeat across owners and status needs the owner.
 *
 * signature: the camera's ML-DSA-87 signature (0x hex) over the UTF-8 text
 *   "qorewitness-sponsor-v1|9800|<registry>|<deviceId>|<owner>|<nonce>"
 * with registry, deviceId and owner as lower-case 0x hex. devicePubkey (0x hex)
 * is extra: it lets the service check the signature before the camera is on chain.
 *
 * Only the pilot code, device id, owner address, nonce, signature and public key
 * leave the box. Never the recovery phrase, a private key or the camera password.
 */
import { signChecked, type DeviceKey } from "../agent/device-key.js";
import { TESTNET_EVM_CHAIN_ID } from "../setup/steps.js";

export const DEFAULT_SPONSOR_URL = "https://qorewitness.fnoufnou.com/sponsor";
export const PILOT_CODE_RE = /^[A-Za-z0-9-]{4,40}$/;

export function sponsorMessage(registry: string, deviceId: string, owner: string, nonce: string): string {
  return `qorewitness-sponsor-v1|${TESTNET_EVM_CHAIN_ID}|${registry.toLowerCase()}|${deviceId.toLowerCase()}|${owner.toLowerCase()}|${nonce}`;
}

export function sponsorBaseUrl(raw = process.env.QW_SPONSOR_URL ?? process.env.SPONSOR_URL ?? DEFAULT_SPONSOR_URL): string {
  const u = new URL(raw);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("the sponsor URL must use https");
  return u.toString().replace(/\/+$/, "");
}

/** Status words the wizard understands. Anything else shows as "unknown". */
export type SponsorStatus = "enrolled" | "pending" | "funded" | "active" | "full" | "invalid_code" | "used_code" | "paused" | "rejected" | "unknown";
const KNOWN = new Set<SponsorStatus>(["enrolled", "pending", "funded", "active", "full", "invalid_code", "used_code", "paused", "rejected"]);

export interface SponsorAnswer {
  status: SponsorStatus;
  capPerDayUqor?: string;
  message?: string;
  /** Status only: the service stopped all top-ups for now. */
  paused?: boolean;
  /** Status only: what this camera got today. */
  usedTodayUqor?: string;
}

/** Plain words for each status. */
export const SPONSOR_TEXT: Record<SponsorStatus, string> = {
  enrolled: "Free beta: we cover the network fees. They are on their way to your account.",
  pending: "Free beta: we cover the network fees. They are on their way to your account.",
  funded: "Free beta: we added the network fees for you.",
  active: "Free beta: we cover the network fees.",
  full: "The free beta is full right now. You can pay the network fees with your own wallet, or try again later.",
  invalid_code: "The free beta did not accept this camera. You can pay the network fees with your own wallet.",
  used_code: "The free beta did not accept this camera. You can pay the network fees with your own wallet.",
  paused: "The free beta is paused right now. Your camera keeps recording. Try again later.",
  rejected: "The free beta service did not accept this computer.",
  unknown: "The free beta service gave an answer we do not know. Try again later.",
};

type FetchFn = typeof fetch;

function parseAnswer(body: unknown): SponsorAnswer {
  const b = (body ?? {}) as Record<string, unknown>;
  const s = typeof b.status === "string" && KNOWN.has(b.status as SponsorStatus) ? (b.status as SponsorStatus) : "unknown";
  const cap = typeof b.capPerDayUqor === "string" || typeof b.capPerDayUqor === "number" ? String(b.capPerDayUqor) : undefined;
  const used = typeof b.usedTodayUqor === "string" && /^\d{1,20}$/.test(b.usedTodayUqor) ? b.usedTodayUqor : undefined;
  return {
    status: s,
    capPerDayUqor: cap && /^\d{1,20}$/.test(cap) ? cap : undefined,
    ...(typeof b.paused === "boolean" ? { paused: b.paused } : {}),
    ...(used ? { usedTodayUqor: used } : {}),
  };
}

export class SponsorClient {
  constructor(private readonly base = sponsorBaseUrl(), private readonly fetchFn: FetchFn = fetch, private readonly timeoutMs = 15_000) {}

  private async call(path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const r = await this.fetchFn(`${this.base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? { accept: "application/json" } : { "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: "error",
    });
    const text = await r.text();
    if (text.length > 16_384) throw new Error("sponsor answer too large");
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`sponsor answered HTTP ${r.status} without JSON`);
    }
    return { status: r.status, json };
  }

  async challenge(deviceId: string): Promise<{ nonce: string; expires?: string }> {
    const r = await this.call("/v1/challenge", { deviceId: deviceId.toLowerCase() });
    const b = r.json as { nonce?: unknown; expires?: unknown };
    if (r.status !== 200 || typeof b.nonce !== "string" || !/^[A-Za-z0-9_:.x-]{8,200}$/.test(b.nonce)) {
      throw new Error(`sponsor challenge failed (HTTP ${r.status})`);
    }
    return { nonce: b.nonce, expires: typeof b.expires === "string" || typeof b.expires === "number" ? String(b.expires) : undefined };
  }

  async enroll(req: { pilotCode?: string; deviceId: string; owner: string; nonce: string; signature: string; devicePubkey: string }): Promise<SponsorAnswer> {
    const r = await this.call("/v1/enroll", req);
    const a = parseAnswer(r.json);
    if (r.status >= 500) throw new Error(`sponsor enroll failed (HTTP ${r.status})`);
    return a;
  }

  async status(deviceId: string, owner?: string): Promise<SponsorAnswer> {
    const q = owner ? `?owner=${encodeURIComponent(owner.toLowerCase())}` : "";
    const r = await this.call(`/v1/status/${encodeURIComponent(deviceId.toLowerCase())}${q}`);
    if (r.status === 404) return { status: "unknown" };
    if (r.status >= 500) throw new Error(`sponsor status failed (HTTP ${r.status})`);
    return parseAnswer(r.json);
  }
}

/** Challenge, sign with the camera key, enroll. */
export async function enrollDevice(
  client: SponsorClient,
  a: { pilotCode?: string; registry: string; deviceId: string; owner: string; key: DeviceKey },
): Promise<SponsorAnswer> {
  if (a.pilotCode !== undefined && !PILOT_CODE_RE.test(a.pilotCode)) return { status: "invalid_code" };
  const { nonce } = await client.challenge(a.deviceId);
  const msg = new TextEncoder().encode(sponsorMessage(a.registry, a.deviceId, a.owner, nonce));
  const signature = signChecked(a.key.publicKey, a.key.secretKey, msg);
  return client.enroll({
    ...(a.pilotCode !== undefined ? { pilotCode: a.pilotCode } : {}),
    deviceId: a.deviceId.toLowerCase(),
    owner: a.owner.toLowerCase(),
    nonce,
    signature,
    devicePubkey: a.key.publicKeyHex,
  });
}
