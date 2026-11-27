/**
 * QoreWitness browser verifier. Runs fully in the browser: the video never leaves
 * the device. It needs only the clips, their receipts and the public QoreChain RPC.
 *
 * One way in: choose or drop any mix of files on the page. An evidence file (ZIP)
 * from the dashboard unpacks here, a clip (.mp4, .ts) pairs with its receipt (.json).
 * "Try it: change one byte and check again" flips one
 * byte in an in-memory copy of the first clip (the files are not touched) and
 * runs the same checks. The result turns red at once.
 *
 * "Try the sample" (or opening the page with ?sample) fetches the public sample
 * clip and receipt from this site and runs the normal check on them.
 */
import { createPublicClient, defineChain, http, type PublicClient } from "viem";
import { verifyReceipt, type Step } from "../../src/core/verify.js";
import { checkClips, verdictOf, type ClipInput, type ReceiptInput, type Verdict, type VerifyFn } from "./package.js";
import { readZip } from "./zip.js";

const chain = defineChain({
  id: 9800,
  name: "QoreChain Testnet (diana)",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: ["https://evm-testnet.qore.host"] } },
});
const pub = createPublicClient({ chain, transport: http() }) as PublicClient;
const verify: VerifyFn = (r, h, s) => verifyReceipt(pub, r, h, s);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tamper = $<HTMLButtonElement>("tamper");
const note = $("note");
let loaded: { clips: ClipInput[]; receipts: ReceiptInput[] } | undefined;

function renderSteps(v: Verdict): void {
  $("utc").textContent = v.utc ? `In UTC: ${v.utc}.` : "";
  const box = $("steps");
  box.replaceChildren(
    ...v.clips.map((c) => {
      const wrap = document.createElement("div");
      const h = document.createElement("h3");
      h.textContent = c.file;
      const ol = document.createElement("ol");
      for (const s of c.steps as Step[]) {
        const li = document.createElement("li");
        li.className = s.state;
        li.textContent = s.text;
        ol.append(li);
      }
      wrap.append(h, ol);
      return wrap;
    }),
  );
}

const IDLE = "Choose an evidence file, or a clip with its receipt.";

function render(v: Verdict | undefined, busy = ""): void {
  const level = v ? v.level : "";
  $("result").className = `card result ${level}`;
  $("verdict").textContent = v ? v.headline : busy || IDLE;
  $("detail").textContent = v ? v.detail : "";
  $("explain").hidden = !v || v.level === "bad";
  $("actions2").hidden = !v;
  $("tech").hidden = !v || !v.clips.length;
  const notes = $("notes");
  notes.replaceChildren(...(v?.notes ?? []).map((t) => Object.assign(document.createElement("li"), { textContent: t })));
  notes.hidden = !v?.notes.length;
  if (v) renderSteps(v);
  else $("steps").replaceChildren();
}

async function run(clips: ClipInput[], receipts: ReceiptInput[]): Promise<Verdict> {
  render(undefined, "Checking…");
  const out = await checkClips(clips, receipts, verify, (d, t) => {
    $("verdict").textContent = `Checking… ${d} of ${t}`;
  });
  const v = verdictOf(out);
  render(v);
  return v;
}

type Kind = "evidence file" | "clip" | "receipt" | "not used";
const kindOf = (f: File): Kind =>
  /\.zip$/i.test(f.name) || f.type === "application/zip" ? "evidence file"
  : /\.json$/i.test(f.name) || f.type === "application/json" ? "receipt"
  : /\.(mp4|ts|m4v)$/i.test(f.name) || f.type.startsWith("video/") ? "clip"
  : "not used";

function showChosen(files: File[]): void {
  const list = $("chosen");
  list.replaceChildren(...files.map((f) => {
    const li = document.createElement("li");
    li.append(Object.assign(document.createElement("span"), { textContent: f.name }), Object.assign(document.createElement("span"), { textContent: kindOf(f) }));
    return li;
  }));
  list.hidden = !files.length;
}

/** Sorts any mix of files: evidence files (ZIP) unpack here, clips and receipts pair up by name or fingerprint. */
async function load(files: File[]): Promise<{ clips: ClipInput[]; receipts: ReceiptInput[] } | undefined> {
  const bad: string[] = [];
  const clips: ClipInput[] = [];
  const receipts: ReceiptInput[] = [];
  const addReceipt = (name: string, text: string) => {
    try {
      receipts.push({ name, receipt: JSON.parse(text) });
    } catch {
      bad.push(`${name} is not a readable receipt.`);
    }
  };
  for (const f of files) {
    const kind = kindOf(f);
    if (kind === "evidence file") {
      for (const z of readZip(new Uint8Array(await f.arrayBuffer()))) {
        if (/\.json$/i.test(z.name) && z.name.startsWith("receipts/")) addReceipt(z.name, new TextDecoder().decode(await z.bytes()));
        else if (z.name.startsWith("clips/") && /\.(mp4|ts)$/i.test(z.name)) clips.push({ name: z.name, bytes: await z.bytes() });
      }
    } else if (kind === "receipt") addReceipt(f.name, await f.text());
    else if (kind === "clip") clips.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  }
  if (!clips.length) {
    render({ level: "bad", headline: receipts.length ? "Add the video too" : "Nothing to check yet", detail: receipts.length ? "A receipt alone proves nothing. Choose the clip together with its receipt, or the evidence file (ZIP)." : "Choose an evidence file (ZIP), or a video clip together with its receipt (.json).", notes: [], clips: [] });
    return undefined;
  }
  if (bad.length && !receipts.length) {
    render({ level: "bad", headline: "Not confirmed", detail: bad[0], notes: [], clips: [] });
    return undefined;
  }
  return { clips, receipts };
}

async function start(files: File[] | undefined): Promise<void> {
  note.textContent = "";
  try {
    if (files) {
      showChosen(files);
      loaded = await load(files);
    }
    if (!loaded) return;
    let clips = loaded.clips;
    const flip = !files;
    if (flip && clips.length) {
      const copy = new Uint8Array(clips[0].bytes); // copy in memory, the file stays as it is
      const pos = Math.floor(copy.length / 2);
      const before = copy[pos];
      copy[pos] ^= 0x01;
      note.textContent = `We changed one byte in the middle of the first clip, in this browser only (byte ${pos.toLocaleString()} of ${copy.length.toLocaleString()}, from 0x${before.toString(16).padStart(2, "0")} to 0x${copy[pos].toString(16).padStart(2, "0")}). That is one bit in the whole video. Your file stays as it is.`;
      clips = [{ name: clips[0].name, bytes: copy }, ...clips.slice(1)];
    }
    const v = await run(clips, loaded.receipts);
    tamper.disabled = !(!flip && v.level !== "bad");
    if (!flip && !tamper.disabled && files?.some((f) => f.name === SAMPLE_FILES[0][0])) {
      note.textContent = "This is our sample record. Now press \"Try it: change one byte and check again\" and watch the result turn red.";
    }
  } catch (e) {
    render({ level: "bad", headline: "Could not open the files", detail: (e as Error).message, notes: [], clips: [] });
  }
}

const input = $<HTMLInputElement>("files");
const drop = $("drop");
$("pick").addEventListener("click", () => input.click());
input.addEventListener("change", () => {
  const files = Array.from(input.files ?? []);
  input.value = "";
  if (files.length) void start(files);
});
// The whole page is a drop zone.
let depth = 0;
const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
document.addEventListener("dragenter", (e) => { if (hasFiles(e)) { depth++; drop.classList.add("over"); } });
document.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; drop.classList.remove("over"); } });
document.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  depth = 0;
  drop.classList.remove("over");
  const files = Array.from(e.dataTransfer!.files);
  if (files.length) void start(files);
});
tamper.addEventListener("click", () => void start(undefined));
$("print").addEventListener("click", () => window.print());

/** The public sample record, served next to this page. */
const SAMPLE_FILES: readonly (readonly [string, string])[] = [
  ["sample-clip.mp4", "video/mp4"],
  ["sample-receipt.json", "application/json"],
];
const sampleBtn = $<HTMLButtonElement>("sample");
async function trySample(): Promise<void> {
  sampleBtn.disabled = true;
  note.textContent = "";
  render(undefined, "Loading the sample…");
  try {
    const files = await Promise.all(SAMPLE_FILES.map(async ([name, type]) => {
      const res = await fetch(new URL(name, location.href), { credentials: "omit" });
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
      return new File([await res.blob()], name, { type });
    }));
    await start(files);
  } catch {
    render({ level: "bad", headline: "Could not load the sample", detail: "Download the clip and the receipt with the links above, then choose both files here.", notes: [], clips: [] });
  } finally {
    sampleBtn.disabled = false;
  }
}
sampleBtn.addEventListener("click", () => void trySample());

render(undefined);
if (new URLSearchParams(location.search).has("sample")) void trySample();
