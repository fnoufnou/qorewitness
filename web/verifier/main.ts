/**
 * QoreWitness browser verifier. Runs fully in the browser: the video never leaves
 * the device. It needs only the file, its receipt and the public QoreChain RPC.
 *
 * Tamper demo: "Change one byte and verify again" flips one byte in an
 * in-memory copy of the video (the original file is not touched) and runs
 * the same checks. The first check fails at once.
 */
import { createPublicClient, defineChain, http, type PublicClient } from "viem";
import { verifyReceipt, type ReceiptV2, type Step } from "../../src/core/verify.js";

const chain = defineChain({
  id: 9800,
  name: "QoreChain Testnet (diana)",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: ["https://evm-testnet.qore.host"] } },
});
const pub = createPublicClient({ chain, transport: http() }) as PublicClient;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const steps = $("steps");
const verdict = $("verdict");
const tamper = $<HTMLButtonElement>("tamper");
const note = $("note");

async function sha256(bytes: ArrayBuffer): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function show(list: Step[]): void {
  steps.replaceChildren(
    ...list.map((s) => {
      const li = document.createElement("li");
      li.className = s.state;
      li.textContent = s.text;
      return li;
    }),
  );
}

function setVerdict(state: "ok" | "bad" | "", text: string): void {
  verdict.className = `verdict ${state}`;
  verdict.textContent = text;
}

async function run(bytes: ArrayBuffer, receiptFile: File, label: string): Promise<boolean> {
  steps.replaceChildren();
  setVerdict("", "Checking…");
  try {
    const r = JSON.parse(await receiptFile.text()) as ReceiptV2;
    const res = await verifyReceipt(pub, r, await sha256(bytes));
    show(res.steps);
    if (res.ok && res.anchoredAt) {
      setVerdict("ok", `Verified (${label}): this exact file existed before ${res.anchoredAt.toLocaleString()} (${res.anchoredAt.toISOString()}).`);
    } else setVerdict("bad", `Not verified (${label}). See the failed checks.`);
    return res.ok;
  } catch (e) {
    show([{ state: "fail", text: (e as Error).message.split("\n")[0] }]);
    setVerdict("bad", `Not verified (${label}).`);
    return false;
  }
}

function inputs(): { v: File; r: File } | undefined {
  const v = $<HTMLInputElement>("video").files?.[0];
  const r = $<HTMLInputElement>("receipt").files?.[0];
  if (!v || !r) {
    setVerdict("bad", "Choose a video file and its receipt first.");
    return undefined;
  }
  return { v, r };
}

$("go").addEventListener("click", async () => {
  const i = inputs();
  if (!i) return;
  note.textContent = "";
  tamper.disabled = !(await run(await i.v.arrayBuffer(), i.r, "original file"));
});

tamper.addEventListener("click", async () => {
  const i = inputs();
  if (!i) return;
  const copy = new Uint8Array(await i.v.arrayBuffer()); // copy in memory, the file stays as it is
  const pos = Math.floor(copy.length / 2);
  const before = copy[pos];
  copy[pos] ^= 0x01;
  note.textContent = `Tamper demo: byte ${pos.toLocaleString()} of ${copy.length.toLocaleString()} changed from 0x${before.toString(16).padStart(2, "0")} to 0x${copy[pos].toString(16).padStart(2, "0")}. One bit in the whole video.`;
  await run(copy.buffer, i.r, "copy with one changed byte");
});
