/**
 * Seeded mutation generator for the live pqcVerify fuzz (scripts/probe-pqc-fuzz.ts).
 * Pure: the same seed and the same fixtures give the same cases. No network, no clock.
 *
 * Every case is built so that it must NOT verify: a valid (pubkey, signature, message)
 * triple with one thing broken. The generator never returns an unmodified valid triple.
 */

export const PK_LEN = 2592;
export const SIG_LEN = 4627;

/**
 * Byte layout of an ML-DSA-87 signature (FIPS 204, k=8, l=7, lambda=256, gamma1=2^19, omega=75):
 * c-tilde 64 bytes, z 7 x 640 = 4,480 bytes, hint 75 + 8 = 83 bytes.
 */
export const SIG_REGIONS = {
  ctilde: [0, 64],
  z: [64, 4544],
  hintPositions: [4544, 4619],
  hintCounts: [4619, 4627],
} as const;
export type SigRegion = keyof typeof SIG_REGIONS;
export const SIG_REGION_NAMES = Object.keys(SIG_REGIONS) as SigRegion[];

export type CaseClass =
  | "sig-bitflip"
  | "pk-bitflip"
  | "msg-bitflip"
  | "sig-other-key"
  | "sig-other-message"
  | "sig-truncated"
  | "sig-extended"
  | "pk-truncated"
  | "pk-extended"
  | "sig-all-zero"
  | "sig-all-ff"
  | "swapped-args"
  | "wrong-length"
  | "empty-input";

export const CASE_CLASSES: readonly CaseClass[] = [
  "sig-bitflip", "pk-bitflip", "msg-bitflip", "sig-other-key", "sig-other-message", "sig-truncated", "sig-extended",
  "pk-truncated", "pk-extended", "sig-all-zero", "sig-all-ff", "swapped-args", "wrong-length", "empty-input",
];

export interface FuzzFixtures {
  pk: Uint8Array; // key A, 2,592 bytes
  sig: Uint8Array; // valid signature by A over msg, 4,627 bytes
  msg: Uint8Array;
  sigOtherKey: Uint8Array; // valid signature by key B over msg
  sigOtherMsg: Uint8Array; // valid signature by A over another message
}

export interface FuzzCase {
  id: number;
  cls: CaseClass;
  label: string;
  region?: SigRegion; // for sig-bitflip
  pk: Uint8Array;
  sig: Uint8Array;
  msg: Uint8Array;
}

export const MIN_CASES = 60;

/** mulberry32: small seeded PRNG. Good enough for test positions, not for keys. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function flipBit(bytes: Uint8Array, bitIndex: number): Uint8Array {
  const out = bytes.slice();
  out[bitIndex >> 3] ^= 1 << (bitIndex & 7);
  return out;
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export function generateCases(seed: number, total: number, fx: FuzzFixtures): FuzzCase[] {
  if (!Number.isInteger(total) || total < MIN_CASES) throw new Error(`cases must be an integer of at least ${MIN_CASES}`);
  if (fx.pk.length !== PK_LEN || fx.sig.length !== SIG_LEN) throw new Error("fixtures are not ML-DSA-87 sized");
  const rnd = makeRng(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const rand = (n: number) => Uint8Array.from({ length: n }, () => int(256));
  const cases: FuzzCase[] = [];
  const add = (cls: CaseClass, label: string, c: { pk?: Uint8Array; sig?: Uint8Array; msg?: Uint8Array }, region?: SigRegion) =>
    cases.push({ id: cases.length, cls, label, region, pk: c.pk ?? fx.pk, sig: c.sig ?? fx.sig, msg: c.msg ?? fx.msg });
  const empty = new Uint8Array(0);

  // Fixed structural cases.
  add("sig-other-key", "valid signature of another key", { sig: fx.sigOtherKey });
  add("sig-other-message", "valid signature of another message", { sig: fx.sigOtherMsg });
  for (const cut of [1, 2, 8, 64, 83, 2313, SIG_LEN - 1]) add("sig-truncated", `signature minus ${cut} byte(s)`, { sig: fx.sig.slice(0, SIG_LEN - cut) });
  add("sig-extended", "signature plus 1 zero byte", { sig: concat(fx.sig, new Uint8Array(1)) });
  add("sig-extended", "signature plus 1 0xff byte", { sig: concat(fx.sig, new Uint8Array([0xff])) });
  add("sig-extended", "signature plus 32 random bytes", { sig: concat(fx.sig, rand(32)) });
  add("sig-extended", "signature twice", { sig: concat(fx.sig, fx.sig) });
  for (const cut of [1, 32, 1296]) add("pk-truncated", `public key minus ${cut} byte(s)`, { pk: fx.pk.slice(0, PK_LEN - cut) });
  add("pk-extended", "public key plus 1 zero byte", { pk: concat(fx.pk, new Uint8Array(1)) });
  add("pk-extended", "public key plus 32 random bytes", { pk: concat(fx.pk, rand(32)) });
  add("sig-all-zero", "4,627 zero bytes", { sig: new Uint8Array(SIG_LEN) });
  add("sig-all-ff", "4,627 bytes of 0xff", { sig: new Uint8Array(SIG_LEN).fill(0xff) });
  // Argument order. The ML-DSA reference order is (pk, msg, sig), the precompile wants (pk, sig, msg).
  add("swapped-args", "(pk, msg, sig)", { sig: fx.msg, msg: fx.sig });
  add("swapped-args", "(sig, pk, msg)", { pk: fx.sig, sig: fx.pk });
  add("swapped-args", "(msg, sig, pk)", { pk: fx.msg, msg: fx.pk });
  add("swapped-args", "(sig, msg, pk)", { pk: fx.sig, sig: fx.msg, msg: fx.pk });
  add("swapped-args", "(msg, pk, sig)", { pk: fx.msg, sig: fx.pk, msg: fx.sig });
  // Lengths and content that are not an ML-DSA-87 key or signature at all.
  add("wrong-length", "random 2,592-byte key, valid signature", { pk: rand(PK_LEN) });
  add("wrong-length", "valid key, random 4,627-byte signature", { sig: rand(SIG_LEN) });
  add("wrong-length", "random key and random signature, right sizes", { pk: rand(PK_LEN), sig: rand(SIG_LEN) });
  add("wrong-length", "key of 2,591 random bytes", { pk: rand(PK_LEN - 1) });
  add("wrong-length", "key of 2,593 random bytes", { pk: rand(PK_LEN + 1) });
  add("wrong-length", "signature of 4,626 random bytes", { sig: rand(SIG_LEN - 1) });
  add("wrong-length", "signature of 4,628 random bytes", { sig: rand(SIG_LEN + 1) });
  add("wrong-length", "ML-DSA-44 sized key (1,312) and signature (2,420)", { pk: rand(1312), sig: rand(2420) });
  add("wrong-length", "ML-DSA-65 sized key (1,952) and signature (3,309)", { pk: rand(1952), sig: rand(3309) });
  add("wrong-length", "1-byte key and 1-byte signature", { pk: rand(1), sig: rand(1) });
  add("empty-input", "empty key", { pk: empty });
  add("empty-input", "empty signature", { sig: empty });
  add("empty-input", "empty message, signature is over another message", { msg: empty });
  add("empty-input", "empty key and empty signature", { pk: empty, sig: empty });
  add("empty-input", "all three empty", { pk: empty, sig: empty, msg: empty });

  // Bit flips fill the rest. Fixed quotas per region, so every region always gets cases.
  const rest = total - cases.length;
  const sigFlips = Math.ceil(rest * 0.5);
  const pkFlips = Math.floor(rest * 0.25);
  const msgFlips = rest - sigFlips - pkFlips;
  const weights: Record<SigRegion, number> = { ctilde: 0.2, z: 0.4, hintPositions: 0.2, hintCounts: 0.2 };
  const quota = {} as Record<SigRegion, number>;
  let used = 0;
  for (const r of SIG_REGION_NAMES) {
    quota[r] = Math.max(1, Math.floor(sigFlips * weights[r]));
    used += quota[r];
  }
  quota.z += Math.max(0, sigFlips - used);
  for (const r of SIG_REGION_NAMES) {
    const [lo, hi] = SIG_REGIONS[r];
    for (let i = 0; i < quota[r]; i++) {
      const byte = lo + int(hi - lo);
      const bit = int(8);
      add("sig-bitflip", `signature bit ${byte * 8 + bit} (byte ${byte}, ${r})`, { sig: flipBit(fx.sig, byte * 8 + bit) }, r);
    }
  }
  for (let i = 0; i < pkFlips; i++) {
    // One in four lands in rho, the 32-byte seed of the matrix. The rest is t1.
    const byte = i % 4 === 0 ? int(32) : 32 + int(PK_LEN - 32);
    const bit = int(8);
    add("pk-bitflip", `public key bit ${byte * 8 + bit} (byte ${byte})`, { pk: flipBit(fx.pk, byte * 8 + bit) });
  }
  for (let i = 0; i < msgFlips; i++) {
    const bits = fx.msg.length * 8;
    const bit = bits === 0 ? 0 : int(bits);
    add("msg-bitflip", `message bit ${bit}`, { msg: flipBit(fx.msg, bit) });
  }
  return cases;
}
