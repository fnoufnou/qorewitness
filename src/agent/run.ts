/**
 * QoreWitness agent: watches the segment list that ffmpeg writes, groups finished
 * segments into windows, anchors each window on QoreChain and writes a receipt.
 *
 * Env:
 *   QORE_MNEMONIC     owner account (testnet only)
 *   QORE_REGISTRY     AnchorRegistry address (v2, with DeviceRegistry)
 *   QW_DEVICE_KEY     device key file (default /etc/qorewitness/<device>.key)
 *   QW_DEVICE         device label, e.g. lsc-indoor
 *   QW_SEGMENT_DIR    folder with segments and segments.csv (ffmpeg -segment_list)
 *   QW_RECEIPT_DIR    folder for receipts (default <segment dir>/../receipts)
 *   QW_WINDOW_SECONDS window length (default 600)
 */
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";
import { AnchorClient, DEVICE_STATUS } from "./anchor-client.js";
import { loadDeviceKey } from "./device-key.js";
import { ensureScopedWindow } from "./evm-window.js";
import { sha256File } from "./hash-file.js";
import { buildReceipt } from "./receipt.js";
import { WindowBatcher, type Segment, type Window } from "./window.js";
import { deviceIdOf } from "../core/message.js";

const env = (k: string, d?: string) => {
  const v = process.env[k]?.trim() || d;
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
const mnemonic = env("QORE_MNEMONIC");
const registry = env("QORE_REGISTRY") as Address;
const device = env("QW_DEVICE");
const segDir = env("QW_SEGMENT_DIR");
const receiptDir = env("QW_RECEIPT_DIR", join(segDir, "..", "receipts"));
const windowSeconds = Number(env("QW_WINDOW_SECONDS", "600"));
const deviceKey = loadDeviceKey(env("QW_DEVICE_KEY", `/etc/qorewitness/${device}.key`));
const statePath = join(receiptDir, `.state-${device}.json`);
mkdirSync(receiptDir, { recursive: true });

interface StoredSegment { path: string; sha256: string; size: number; completedAt: number }
interface State {
  seen: string[]; // segment file names already hashed
  open?: StoredSegment[]; // hashed segments in windows that are not closed yet
  pending: { windowStart: string; windowSeconds: number; segments: StoredSegment[] }[];
}
const state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { seen: [], pending: [] };
const seen = new Set(state.seen);
const toStored = (s: Segment): StoredSegment => ({ ...s, sha256: Buffer.from(s.sha256).toString("hex") });
const fromStored = (s: StoredSegment): Segment => ({ ...s, sha256: Uint8Array.from(Buffer.from(s.sha256, "hex")) });
const saveState = () => {
  state.seen = [...seen].slice(-5000);
  state.open = batcher.openSegments().map(toStored);
  writeFileSync(statePath + ".tmp", JSON.stringify(state));
  renameSync(statePath + ".tmp", statePath); // atomic replace
};

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const client = await AnchorClient.create(mnemonic, registry);
const deviceId = deviceIdOf(device);
const batcher = new WindowBatcher(windowSeconds);
// Until 9 Nov the open window lived only in memory: a restart lost its segments.
for (const s of state.open ?? []) batcher.add(fromStored(s));
log(`agent ${client.address} device ${device} (${deviceId}) window ${windowSeconds}s registry ${registry}`);

/** The device must be registered and active with this key, or every anchor fails. */
async function deviceReady(): Promise<boolean> {
  const d = await client.getDevice(deviceId);
  if (d.status === 1 && d.keyHash === deviceKey.keyHash) return true;
  log(
    `device not ready: status ${DEVICE_STATUS[d.status] ?? d.status}` +
      (d.status === 1 ? `, key on chain ${d.keyHash.slice(0, 12)}... differs from ${deviceKey.keyHash.slice(0, 12)}...` : "") +
      `. Run: pnpm device register ${device}`,
  );
  return false;
}

/** Reads the segment list. ffmpeg appends a line only after a segment file is closed. */
function finishedSegments(): string[] {
  const list = join(segDir, "segments.csv");
  if (!existsSync(list)) return [];
  return readFileSync(list, "utf8").split("\n").map((l) => l.split(",")[0]?.trim()).filter(Boolean);
}

async function collect(): Promise<void> {
  for (const name of finishedSegments()) {
    if (seen.has(name)) continue;
    const path = join(segDir, name);
    if (!existsSync(path)) { seen.add(name); continue; }
    const st = statSync(path);
    const seg: Segment = { path, sha256: await sha256File(path), size: st.size, completedAt: Math.floor(st.mtimeMs / 1000) };
    batcher.add(seg);
    seen.add(name);
  }
  for (const w of batcher.closeReady(Math.floor(Date.now() / 1000))) {
    state.pending.push({
      windowStart: w.windowStart.toString(),
      windowSeconds: w.windowSeconds,
      segments: w.segments.map(toStored),
    });
  }
  saveState();
}

async function anchorPending(): Promise<void> {
  if (state.pending.length > 0 && !(await deviceReady())) return; // keep windows, retry later
  while (state.pending.length > 0) {
    const p = state.pending[0];
    const w: Window = {
      windowStart: BigInt(p.windowStart),
      windowSeconds: p.windowSeconds,
      segments: p.segments.map(fromStored),
    };
    if (await ensureScopedWindow(client.account, registry)) log("opened a new scoped EVM window");
    try {
      const res = await client.anchorWindow(deviceId, deviceKey, w);
      const receipt = buildReceipt(
        {
          chain: { evmChainId: 9800, registry, txHash: res.txHash, anchorId: res.anchorId, blockNumber: res.blockNumber.toString() },
          owner: client.address, deviceId, deviceLabel: device, devicePubkey: deviceKey.publicKeyHex,
          root: res.root, signature: res.signature,
        },
        w,
      );
      writeFileSync(join(receiptDir, `${device}-${p.windowStart}.json`), JSON.stringify(receipt, null, 2));
      log(`anchored ${w.segments.length} segments, window ${p.windowStart}, block ${res.blockNumber}, gas ${res.gasUsed}, tx ${res.txHash}`);
      state.pending.shift();
      saveState();
    } catch (err) {
      const msg = (err as Error).message;
      if (/WindowOverlap/.test(msg)) {
        log(`window ${p.windowStart} overlaps an existing anchor, dropping it`);
        state.pending.shift();
        saveState();
        continue;
      }
      log(`anchor failed, retry later: ${msg.split("\n")[0]}`);
      return;
    }
  }
}

let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
while (!stopping) {
  try {
    await collect();
    await anchorPending();
  } catch (err) {
    log(`loop error: ${(err as Error).message.split("\n")[0]}`);
  }
  for (let i = 0; i < 15 && !stopping; i++) await new Promise((ok) => setTimeout(ok, 1000));
}
saveState();
log("stopped");
