/**
 * "Find my camera": a quick search of the home network, in a few seconds.
 *
 * 1. TCP check of the RTSP ports (554, 8554) and the Tapo ONVIF port (2020) on
 *    every address of the box's own /24.
 * 2. ONVIF WS-Discovery: one multicast Probe to 239.255.255.250:3702, then a
 *    directed (unicast) Probe to port 3702 of every address that answered in step 1.
 *
 * Docker: the ui container runs on the default bridge network. Multicast does not
 * leave the bridge, so the multicast Probe only helps when the ui runs on the host
 * network. TCP checks and the directed Probes are unicast: Docker NAT carries them
 * and their answers, so the search works without host networking or extra rights.
 *
 * The /24 comes from QW_LAN_CIDR, the address that install.sh wrote
 * (QW_UI_PUBLIC_URL), or the address the browser used. Docker bridge
 * addresses (172.17 to 172.31) are skipped: they are not the home network.
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

/** "192.168.1" from the first private, non-Docker IPv4 address among the hints. */
export function lanPrefix(hints: (string | undefined)[]): string | undefined {
  for (const h of hints) {
    if (!h) continue;
    const m = /(?:^|\/\/|^)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?=$|[:/])/.exec(h.trim());
    if (!m) continue;
    const [a, b, c, d] = m.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) continue;
    const priv = a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
    const docker = a === 172 && b >= 17 && b <= 31;
    if (priv && !docker) return `${a}.${b}.${c}`;
  }
  return undefined;
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
  prefix: string; // "192.168.1"
  ports?: readonly number[];
  connectTimeoutMs?: number;
  concurrency?: number;
  wsdWaitMs?: number;
  connect?: Connect;
  wsd?: WsDiscovery;
}

/** TCP check of the /24, then ONVIF Probes. Sorted by address. Takes about 3 to 4 seconds. */
export async function discoverCameras(o: DiscoverOptions): Promise<FoundCamera[]> {
  const ports = o.ports ?? SCAN_PORTS;
  const connect = o.connect ?? tcpOpen;
  const timeout = o.connectTimeoutMs ?? 700;
  const jobs: { ip: string; port: number }[] = [];
  for (let i = 1; i <= 254; i++) for (const port of ports) jobs.push({ ip: `${o.prefix}.${i}`, port });
  const found = new Map<string, FoundCamera>();
  let next = 0;
  const worker = async () => {
    for (;;) {
      const j = jobs[next++];
      if (!j) return;
      if (await connect(j.ip, j.port, timeout)) {
        const f = found.get(j.ip) ?? { ip: j.ip, ports: [], onvif: false };
        f.ports.push(j.port);
        found.set(j.ip, f);
      }
    }
  };
  await Promise.all(Array.from({ length: o.concurrency ?? 192 }, worker));

  const answers = await (o.wsd ?? wsDiscovery)([...found.keys()], o.wsdWaitMs ?? 1500);
  for (const { from, match } of answers) {
    const ip = xaddrHost(match) ?? from;
    if (!ip.startsWith(`${o.prefix}.`)) continue;
    const f = found.get(ip) ?? { ip, ports: [], onvif: false };
    f.onvif = true;
    f.name = match.name;
    f.hardware = match.hardware;
    f.brand = brandFromOnvif([match.name, match.hardware, match.mfr]);
    found.set(ip, f);
  }
  for (const f of found.values()) {
    f.ports.sort((a, b) => a - b);
    // Port 2020 is the ONVIF port of Tapo cameras.
    if (!f.brand && f.ports.includes(2020)) f.brand = "tapo";
  }
  return [...found.values()].sort((a, b) => Number(a.ip.split(".")[3]) - Number(b.ip.split(".")[3]));
}

/** "Camera at 192.168.1.20 · TP-IPC C210" */
export function cameraLabel(f: FoundCamera): string {
  const what = [f.name, f.hardware].filter(Boolean).join(" ");
  return `Camera at ${f.ip}${what ? ` · ${what}` : ""}`;
}
