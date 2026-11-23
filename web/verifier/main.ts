/**
 * QoreWitness browser verifier. Runs fully in the browser: the video never leaves
 * the device. It needs only the clips, their receipts and the public QoreChain RPC.
 *
 * Two ways in: drop the evidence ZIP from the QoreWitness dashboard (it unpacks here), or choose one
 * clip and its receipt. "Try it: change one byte and check again" flips one
 * byte in an in-memory copy of the first clip (the files are not touched) and
 * runs the same checks. The result turns red at once.
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

function render(v: Verdict | undefined, busy = ""): void {
  const level = v ? v.level : "";
  $("result").className = `card result ${level}`;
  $("verdict").textContent = v ? v.headline : busy || "Choose a ZIP, or a clip and its receipt.";
  $("detail").textContent = v ? v.detail : "";
  $("explain").hidden = !v;
  $("actions2").hidden = !v;
  $("tech").hidden = !v;
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

async function load(): Promise<{ clips: ClipInput[]; receipts: ReceiptInput[] } | undefined> {
  const zip = $<HTMLInputElement>("zip").files?.[0];
  const video = $<HTMLInputElement>("video").files?.[0];
  const rec = $<HTMLInputElement>("receipt").files?.[0];
  const bad: string[] = [];
  const clips: ClipInput[] = [];
  const receipts: ReceiptInput[] = [];
  const addReceipt = async (name: string, text: string) => {
    try {
      receipts.push({ name, receipt: JSON.parse(text) });
    } catch {
      bad.push(`${name} is not a readable receipt.`);
    }
  };
  if (zip) {
    for (const f of readZip(new Uint8Array(await zip.arrayBuffer()))) {
      if (/\.json$/i.test(f.name) && f.name.startsWith("receipts/")) await addReceipt(f.name, new TextDecoder().decode(await f.bytes()));
      else if (f.name.startsWith("clips/") && /\.(mp4|ts)$/i.test(f.name)) clips.push({ name: f.name, bytes: await f.bytes() });
    }
  } else if (video && rec) {
    clips.push({ name: video.name, bytes: new Uint8Array(await video.arrayBuffer()) });
    await addReceipt(rec.name, await rec.text());
  } else {
    render({ level: "bad", headline: "Nothing chosen yet", detail: "Choose the evidence ZIP, or one clip and its receipt.", notes: [], clips: [] });
    return undefined;
  }
  if (bad.length && !receipts.length) {
    render({ level: "bad", headline: "Not confirmed", detail: bad[0], notes: [], clips: [] });
    return undefined;
  }
  return { clips, receipts };
}

async function start(flip: boolean): Promise<void> {
  note.textContent = "";
  try {
    if (!flip) loaded = await load();
    if (!loaded) return;
    let clips = loaded.clips;
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
  } catch (e) {
    render({ level: "bad", headline: "Could not open the files", detail: (e as Error).message, notes: [], clips: [] });
  }
}

$("go").addEventListener("click", () => void start(false));
tamper.addEventListener("click", () => void start(true));
$("print").addEventListener("click", () => window.print());
render(undefined);
