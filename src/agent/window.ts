/**
 * Groups finished recording segments into fixed time windows.
 * A window holds every segment whose file was completed inside
 * [windowStart, windowStart + windowSeconds). Windows never overlap, which
 * AnchorRegistry also enforces per device.
 */
export interface Segment {
  path: string;
  sha256: Uint8Array; // 32 bytes
  size: number;
  completedAt: number; // unix seconds (local clock)
}

export interface Window {
  windowStart: bigint;
  windowSeconds: number;
  segments: Segment[]; // sorted by completedAt, then path
}

export class WindowBatcher {
  private open = new Map<bigint, Segment[]>();

  constructor(private readonly windowSeconds: number) {
    if (!Number.isInteger(windowSeconds) || windowSeconds < 10) throw new Error("windowSeconds must be an integer >= 10");
  }

  windowStartOf(t: number): bigint {
    return BigInt(Math.floor(t / this.windowSeconds) * this.windowSeconds);
  }

  add(seg: Segment): void {
    const start = this.windowStartOf(seg.completedAt);
    const list = this.open.get(start) ?? [];
    list.push(seg);
    this.open.set(start, list);
  }

  /** Segments in windows that are still open. The agent saves them, so a restart loses nothing. */
  openSegments(): Segment[] {
    return [...this.open.values()].flat();
  }

  /** Returns windows that ended before `now - graceSeconds`, oldest first, and forgets them. */
  closeReady(now: number, graceSeconds = 5): Window[] {
    const ready: Window[] = [];
    for (const [start, segs] of [...this.open.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (Number(start) + this.windowSeconds + graceSeconds <= now) {
        segs.sort((a, b) => a.completedAt - b.completedAt || a.path.localeCompare(b.path));
        ready.push({ windowStart: start, windowSeconds: this.windowSeconds, segments: segs });
        this.open.delete(start);
      }
    }
    return ready;
  }
}
