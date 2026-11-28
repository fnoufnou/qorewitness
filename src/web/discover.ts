/**
 * "Find my camera": a quick search of the home network, in a few seconds.
 *
 * 1. TCP check of the RTSP ports (554, 8554) and the Tapo ONVIF port (2020) on
 *    every address of the home network: the box's own /24 first, then the rest
 *    of the network up to a /22 (1,022 addresses). All ports of one address are
 *    checked together, so the address is looked up (ARP) only once.
 * 2. ONVIF WS-Discovery: one multicast Probe to 239.255.255.250:3702, then a
 *    directed (unicast) Probe to port 3702 of every address that answered in step 1.
 *
 * Docker: the ui container runs on the default bridge network. Multicast does not
 * leave the bridge, so the multicast Probe only helps when the ui runs on the host
 * network. TCP checks and the directed Probes are unicast: Docker NAT carries them
 * and their answers, so the search works without host networking or extra rights.
 *
 * The network comes from QW_LAN_CIDR (install.sh writes the host's address with
 * its prefix, for example 192.168.1.229/21), else the /24 of the address that
 * install.sh wrote (QW_UI_PUBLIC_URL) or the address the browser used. Docker
 * bridge addresses (172.17 to 172.31) are skipped: they are not the home network.
 *
 * Timing (measured on CT 262 and CT 263, 28 Nov). A Wi-Fi camera answers a single
 * connect in under 100 ms. The trouble is the address lookups (ARP): each address
 * that does not exist costs up to three broadcasts, and after a few hundred
 * broadcasts in a row the cameras (or the network) stop answering. With 1,000
 * addresses at once a camera late in the list was missed 1 run in 2. So the search
 * goes one /24 at a time, starts one address every 4 ms and waits 2.5 s per address:
 * 3.6 s per /24, about 15 s for a /22, both cameras found in 4 of 4 cold runs.
 * The setup page shows what is found after each /24.
 */
import { createSocket } from "node:dgram";
import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import { brandFromOnvif, type BrandId } from "./cameras.js";

export const SCAN_PORTS = [554, 8554, 2020] as const;
const WSD_ADDR = "239.255.255.250";
const WSD_PORT = 3702;

export interface FoundCamera {
  ip: string;
  ports: number[];
  /** From ONVIF, when the camera answered the Probe. */
  name?: string;
  hardware?: string;
  brand?: BrandId;
  onvif: boolean;
}

const parseIp = (s: string): number[] | undefined => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return undefined;
  const n = m.slice(1).map(Number);
  return n.some((x) => x > 255) ? undefined : n;
};
const isHomeIp = ([a, b]: number[]) => {
  const priv = a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  const docker = a === 172 && b >= 17 && b <= 31;
  return priv && !docker;
};
const toInt = (n: number[]) => ((n[0] << 24) >>> 0) + (n[1] << 16) + (n[2] << 8) + n[3];
const toIp = (x: number) => [x >>> 24, (x >>> 16) & 255, (x >>> 8) & 255, x & 255].join(".");

/** Largest network the search covers: a /22 (4 x 254 addresses, about 8 seconds). */
export const MAX_SCAN_PREFIX = 22;

export interface LanRanges {
  /** /24 prefixes to search, own /24 first: ["192.168.1", "192.168.0", "192.168.2", "192.168.3"]. */
  prefixes: string[];
  /** The home network as install.sh saw it ("192.168.0.0/21"), when known. */
  network?: string;
}

/**
 * The /24s to search, from the hints (QW_LAN_CIDR, QW_UI_PUBLIC_URL, browser address).
 * A CIDR hint ("192.168.1.229/21") gives the network, capped at a /22 around the
 * box's address. Without one: the /24 of the first private, non-Docker address.
 */
export function lanRanges(hints: (string | undefined)[]): LanRanges | undefined {
  let cidr: { ip: number[]; len: number } | undefined;
  let host: number[] | undefined;
  for (const h of hints) {
    if (!h) continue;
    const t = h.trim();
    const c = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(t);
    if (c) {
      const ip = parseIp(c[1]);
      const len = Number(c[2]);
      if (!cidr && ip && isHomeIp(ip) && len >= 8 && len <= 32) cidr = { ip, len };
      continue;
    }
    const m = /^(?:[a-z]+:\/\/)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?=$|[:/])/i.exec(t);
    const ip = m ? parseIp(m[1]) : undefined;
    if (!host && ip && isHomeIp(ip)) host = ip;
  }
  if (cidr) {
    const mask = cidr.len === 0 ? 0 : (0xffffffff << (32 - cidr.len)) >>> 0;
    const net = (toInt(cidr.ip) & mask) >>> 0;
    // The box's own address: from the CIDR when it holds one, else the first address hint inside it.
    const own = (toInt(cidr.ip) & ~mask) >>> 0 ? cidr.ip : host && ((toInt(host) & mask) >>> 0) === net ? host : undefined;
    const network = `${toIp(net)}/${cidr.len}`;
    if (!own) return { prefixes: [`${cidr.ip[0]}.${cidr.ip[1]}.${cidr.ip[2]}`], network };
    const ownPrefix = `${own[0]}.${own[1]}.${own[2]}`;
    if (cidr.len >= 24) return { prefixes: [ownPrefix], network };
    const len = Math.max(cidr.len, MAX_SCAN_PREFIX);
    const blockMask = (0xffffffff << (32 - len)) >>> 0;
    const start = (toInt(own) & blockMask) >>> 0;
    const prefixes = [ownPrefix];
    for (let x = start; x < start + 2 ** (32 - len); x += 256) {
      const p = toIp(x).split(".").slice(0, 3).join(".");
      if (p !== ownPrefix) prefixes.push(p);
    }
    return { prefixes, network };
  }
  return host ? { prefixes: [`${host[0]}.${host[1]}.${host[2]}`] } : undefined;
}

/** "192.168.1" from the hints: the box's own /24 (see lanRanges). */
export function lanPrefix(hints: (string | undefined)[]): string | undefined {
  return lanRanges(hints)?.prefixes[0];
}

/** "192.168.1.1 to 192.168.1.254" or "192.168.0.1 to 192.168.3.254" for the searched /24s. */
export function describeRanges(prefixes: string[]): string {
  if (!prefixes.length) return "";
  const sorted = [...prefixes].sort((a, b) => toInt(parseIp(`${a}.0`)!) - toInt(parseIp(`${b}.0`)!));
  const contiguous = sorted.every((p, i) => i === 0 || toInt(parseIp(`${p}.0`)!) - toInt(parseIp(`${sorted[i - 1]}.0`)!) === 256);
  if (!contiguous) return sorted.map((p) => `${p}.1 to ${p}.254`).join(", ");
  return `${sorted[0]}.1 to ${sorted[sorted.length - 1]}.254`;
}

export function probeXml(messageId = `uuid:${randomUUID()}`): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
<e:Header><w:MessageID>${messageId}</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>
<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>`;
}

export interface ProbeMatch {
  xaddrs: string[];
  scopes: string[];
  name?: string;
  hardware?: string;
  mfr?: string;
}

const tagText = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<(?:[A-Za-z0-9_-]+:)?${tag}\\b[^>]*>([^<]*)</(?:[A-Za-z0-9_-]+:)?${tag}>`, "g"))].map((m) => m[1].trim());

/** Reads a WS-Discovery ProbeMatches answer. Undefined for anything else. No XML library: tags only. */
export function parseProbeMatch(xml: string): ProbeMatch | undefined {
  if (xml.length > 65_536 || !/ProbeMatch\b/.test(xml)) return undefined;
  const xaddrs = tagText(xml, "XAddrs").flatMap((t) => t.split(/\s+/)).filter((u) => /^https?:\/\//.test(u));
  const scopes = tagText(xml, "Scopes").flatMap((t) => t.split(/\s+/)).filter(Boolean);
  const scope = (kind: string) => {
    const s = scopes.find((x) => x.toLowerCase().startsWith(`onvif://www.onvif.org/${kind}/`));
    if (!s) return undefined;
    try {
      return decodeURIComponent(s.slice(`onvif://www.onvif.org/${kind}/`.length)).replace(/[_+]/g, " ").slice(0, 60);
    } catch {
      return undefined;
    }
  };
  return { xaddrs, scopes, name: scope("name"), hardware: scope("hardware"), mfr: scope("mfr") ?? scope("manufacturer") };
}

/** Host of the first XAddr, when it is an IPv4 address. */
export const xaddrHost = (m: ProbeMatch) => m.xaddrs.map((u) => /^https?:\/\/(\d+\.\d+\.\d+\.\d+)/.exec(u)?.[1]).find(Boolean);

export type Connect = (ip: string, port: number, timeoutMs: number) => Promise<boolean>;

export const tcpOpen: Connect = (ip, port, timeoutMs) =>
  new Promise((done) => {
    const s = new Socket();
    const end = (ok: boolean) => {
      s.destroy();
      done(ok);
    };
    s.setTimeout(timeoutMs, () => end(false));
    s.once("connect", () => end(true));
    s.once("error", () => end(false));
    s.connect(port, ip);
  });

/** Sends Probes and collects ProbeMatches until `waitMs` after the last send. */
export type WsDiscovery = (unicastTargets: string[], waitMs: number) => Promise<{ from: string; match: ProbeMatch }[]>;

export const wsDiscovery: WsDiscovery = (targets, waitMs) =>
  new Promise((done) => {
    const out: { from: string; match: ProbeMatch }[] = [];
    let sock;
    try {
      sock = createSocket({ type: "udp4", reuseAddr: true });
    } catch {
      return done(out);
    }
    const finish = () => {
      try {
        sock.close();
      } catch {
        // closed already
      }
      done(out);
    };
    sock.on("error", finish);
    sock.on("message", (buf, rinfo) => {
      const match = parseProbeMatch(buf.toString("utf8"));
      if (match) out.push({ from: rinfo.address, match });
    });
    sock.bind(0, () => {
      const send = (host: string) => {
        const b = Buffer.from(probeXml());
        sock.send(b, WSD_PORT, host, () => {});
      };
      try {
        send(WSD_ADDR);
      } catch {
        // No multicast route (Docker bridge): the directed Probes still work.
      }
      for (const t of targets) send(t);
      setTimeout(finish, waitMs);
    });
  });

export interface DiscoverOptions {
  /** One /24 ("192.168.1") or several, own /24 first. */
  prefix?: string;
  prefixes?: string[];
  /** The home network as install.sh saw it, for the "no camera" message. */
  network?: string;
  ports?: readonly number[];
  connectTimeoutMs?: number;
  /** Time between the start of two addresses (spreads the ARP broadcasts). */
  startGapMs?: number;
  /** No new /24 after this many ms (the ONVIF wait comes after). */
  deadlineMs?: number;
  wsdWaitMs?: number;
  connect?: Connect;
  wsd?: WsDiscovery;
  /** Called after each /24 with what is found so far. */
  onProgress?: (found: DiscoverResult) => void;
}

/** The found cameras, plus what was searched (for the "No camera answered" message). */
export type DiscoverResult = FoundCamera[] & { searched?: string[]; network?: string; partial?: boolean };

const ipKey = (ip: string) => toInt(parseIp(ip) ?? [0, 0, 0, 0]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sorted = (m: Map<string, FoundCamera>, extra: Partial<DiscoverResult>): DiscoverResult =>
  Object.assign([...m.values()].map((f) => ({ ...f, ports: [...f.ports].sort((a, b) => a - b) })).sort((a, b) => ipKey(a.ip) - ipKey(b.ip)), extra);

/** TCP check of the network, one /24 at a time (own /24 first), then ONVIF Probes. Sorted by address. */
export async function discoverCameras(o: DiscoverOptions): Promise<DiscoverResult> {
  const prefixes = o.prefixes?.length ? o.prefixes : o.prefix ? [o.prefix] : [];
  const ports = o.ports ?? SCAN_PORTS;
  const connect = o.connect ?? tcpOpen;
  const timeout = o.connectTimeoutMs ?? 2500;
  const gap = o.startGapMs ?? 4;
  const deadline = Date.now() + (o.deadlineMs ?? 16_000);
  const found = new Map<string, FoundCamera>();
  const searched: string[] = [];
  let partial = false;
  for (const p of prefixes) {
    if (searched.length && Date.now() > deadline) {
      partial = true;
      break;
    }
    const jobs: Promise<void>[] = [];
    for (let i = 1; i <= 254; i++) {
      const ip = `${p}.${i}`;
      // All ports of one address at once: one ARP lookup, one wait.
      jobs.push(Promise.all(ports.map((port) => connect(ip, port, timeout).then((ok) => (ok ? port : 0)))).then((open) => {
        const hit = open.filter(Boolean);
        if (hit.length) found.set(ip, { ip, ports: hit, onvif: false });
      }));
      if (gap) await sleep(gap);
    }
    await Promise.all(jobs);
    searched.push(p);
    o.onProgress?.(sorted(found, { searched: [...searched], network: o.network }));
  }

  const inRange = (ip: string) => prefixes.some((p) => ip.startsWith(`${p}.`));
  const answers = await (o.wsd ?? wsDiscovery)([...found.keys()], o.wsdWaitMs ?? 1200);
  for (const { from, match } of answers) {
    const ip = xaddrHost(match) ?? from;
    if (!inRange(ip)) continue;
    const f = found.get(ip) ?? { ip, ports: [], onvif: false };
    f.onvif = true;
    f.name = match.name;
    f.hardware = match.hardware;
    f.brand = brandFromOnvif([match.name, match.hardware, match.mfr]);
    found.set(ip, f);
  }
  for (const f of found.values()) {
    // Port 2020 is the ONVIF port of Tapo cameras.
    if (!f.brand && f.ports.includes(2020)) f.brand = "tapo";
  }
  return sorted(found, { searched, network: o.network, partial });
}

/** "Camera at 192.168.1.20 · TP-IPC C210" */
export function cameraLabel(f: FoundCamera): string {
  // The C210 sends name and hardware both as "C210": show it once.
  const what = [...new Set([f.name, f.hardware].filter(Boolean))].join(" ");
  return `Camera at ${f.ip}${what ? ` · ${what}` : ""}`;
}
