/**
 * Client for the pilot fee sponsor ("Fees included" plan). The sponsor service
 * sends test QOR to the owner account of a box with a valid pilot code.
 *
 * Contract (implemented by the sponsor service):
 *   POST {SPONSOR_URL}/v1/challenge {deviceId}                 -> {nonce, expires}
 *   POST {SPONSOR_URL}/v1/enroll {pilotCode, deviceId, owner, nonce, signature, devicePubkey}
 *                                                              -> {status, capPerDayUqor}
 *   GET  {SPONSOR_URL}/v1/status/<deviceId>                    -> {status, ...}
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
}

/** Plain words for each status. */
export const SPONSOR_TEXT: Record<SponsorStatus, string> = {
  enrolled: "Your pilot code is accepted. The pilot is adding the network fees to your box.",
  pending: "The pilot is adding the network fees to your box.",
  funded: "The pilot added the network fees.",
  active: "Network fees are covered by the pilot.",
  full: "The pilot is full at the moment. Choose Self-managed, or try again later.",
  invalid_code: "This pilot code is not valid. Check the code from the website.",
  used_code: "This pilot code was used already.",
  paused: "The pilot is paused at the moment. Your box keeps recording. Try again later.",
  rejected: "The pilot service did not accept this box.",
  unknown: "The pilot service gave an answer we do not know. Try again later.",
};

type FetchFn = typeof fetch;

function parseAnswer(body: unknown): SponsorAnswer {
  const b = (body ?? {}) as Record<string, unknown>;
  const s = typeof b.status === "string" && KNOWN.has(b.status as SponsorStatus) ? (b.status as SponsorStatus) : "unknown";
  const cap = typeof b.capPerDayUqor === "string" || typeof b.capPerDayUqor === "number" ? String(b.capPerDayUqor) : undefined;
  return { status: s, capPerDayUqor: cap && /^\d{1,20}$/.test(cap) ? cap : undefined };
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

  async enroll(req: { pilotCode: string; deviceId: string; owner: string; nonce: string; signature: string; devicePubkey: string }): Promise<SponsorAnswer> {
    const r = await this.call("/v1/enroll", req);
    const a = parseAnswer(r.json);
    if (r.status >= 500) throw new Error(`sponsor enroll failed (HTTP ${r.status})`);
    return a;
  }

  async status(deviceId: string): Promise<SponsorAnswer> {
    const r = await this.call(`/v1/status/${encodeURIComponent(deviceId.toLowerCase())}`);
    if (r.status === 404) return { status: "unknown" };
    if (r.status >= 500) throw new Error(`sponsor status failed (HTTP ${r.status})`);
    return parseAnswer(r.json);
  }
}

/** Challenge, sign with the camera key, enroll. */
export async function enrollDevice(
  client: SponsorClient,
  a: { pilotCode: string; registry: string; deviceId: string; owner: string; key: DeviceKey },
): Promise<SponsorAnswer> {
  if (!PILOT_CODE_RE.test(a.pilotCode)) return { status: "invalid_code" };
  const { nonce } = await client.challenge(a.deviceId);
  const msg = new TextEncoder().encode(sponsorMessage(a.registry, a.deviceId, a.owner, nonce));
  const signature = signChecked(a.key.publicKey, a.key.secretKey, msg);
  return client.enroll({
    pilotCode: a.pilotCode,
    deviceId: a.deviceId.toLowerCase(),
    owner: a.owner.toLowerCase(),
    nonce,
    signature,
    devicePubkey: a.key.publicKeyHex,
  });
}
