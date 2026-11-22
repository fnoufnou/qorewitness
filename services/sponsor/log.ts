/**
 * Log lines: one JSON object per line to stdout (journald keeps them, see
 * deploy/sponsor). Never pass secrets, request bodies or full IPs.
 * IPs are truncated: IPv4 to /24 (1.2.3.x), IPv6 to /48 (2001:db8:1::x).
 */
export function truncateIp(ip: string | undefined): string {
  if (!ip) return "unknown";
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.x`;
  if (ip.includes(":")) {
    const parts = ip.split("::")[0].split(":").filter(Boolean).slice(0, 3);
    return `${parts.join(":")}::x`;
  }
  return "unknown";
}

/** Redacts anything that looks like a mnemonic, private key or URL credentials in free text. */
export function redact(text: string): string {
  return text
    .replace(/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, (m) => `${m.slice(0, 10)}...`)
    .replace(/:\/\/[^/@\s]+@/g, "://***@")
    .replace(/\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/g, "[redacted words]");
}

export type LogFields = Record<string, string | number | boolean | undefined>;

export interface Logger {
  info(event: string, f?: LogFields): void;
  warn(event: string, f?: LogFields): void;
  alert(event: string, f?: LogFields): void;
}

export const consoleLogger: Logger = {
  info: (event, f) => emit("info", event, f),
  warn: (event, f) => emit("warn", event, f),
  alert: (event, f) => emit("alert", event, f),
};

function emit(level: string, event: string, f: LogFields = {}): void {
  const clean: LogFields = {};
  for (const [k, v] of Object.entries(f)) clean[k] = typeof v === "string" ? redact(v).slice(0, 300) : v;
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level, event, ...clean }) + "\n");
}

export const silentLogger: Logger = { info() {}, warn() {}, alert() {} };

export const ALERT_REPEAT_SECONDS = 6 * 3600;

/**
 * Alerts for a condition that lasts (float low, pass failing, RPC errors): the
 * first one goes out at once, then at most one per 6 hours while the condition
 * lasts. When it ends, one "<kind>_recovered" info line. Memory only: a restart
 * may send one alert again.
 */
export class AlertThrottle {
  private readonly active = new Map<string, number>(); // kind -> last sent (unix seconds)

  constructor(
    private readonly log: Logger,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly repeatSeconds = ALERT_REPEAT_SECONDS,
  ) {}

  /** The condition holds. Returns true when a line was written. */
  fire(kind: string, f: LogFields = {}, level: "alert" | "warn" = "alert"): boolean {
    const t = this.now();
    const last = this.active.get(kind);
    if (last !== undefined && t - last < this.repeatSeconds) return false;
    this.active.set(kind, t);
    this.log[level](kind, f);
    return true;
  }

  /** The condition is over. Writes one recovered line if an alert was out. */
  clear(kind: string, f: LogFields = {}): void {
    if (!this.active.delete(kind)) return;
    this.log.info(`${kind}_recovered`, f);
  }
}
