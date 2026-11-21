/**
 * Pilot codes. The service keeps only SHA-256 hashes (one hex hash per line in
 * the codes file, '#' starts a comment). A code is normalised before hashing:
 * trimmed, upper case, spaces and dashes removed.
 *
 * Make new codes (prints each code once, and the line for the codes file):
 *   pnpm -s tsx services/sponsor/codes.ts new 5
 * Hash one code:
 *   pnpm -s tsx services/sponsor/codes.ts hash QW-ABCD-...
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I

export const normalizeCode = (code: string) => code.trim().toUpperCase().replace(/[\s-]/g, "");

export const hashCode = (code: string) => createHash("sha256").update(`qorewitness-pilot-v1|${normalizeCode(code)}`).digest("hex");

export function loadCodeHashes(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim().toLowerCase())
    .filter((l) => /^[0-9a-f]{64}$/.test(l));
}

/** Constant-time membership check. */
export function codeAllowed(code: string, hashes: readonly string[]): string | undefined {
  const h = Buffer.from(hashCode(code), "hex");
  let found: string | undefined;
  for (const x of hashes) {
    if (timingSafeEqual(h, Buffer.from(x, "hex"))) found = x;
  }
  return found;
}

/** 25 characters from a 32-letter alphabet: 125 bits. */
export function newCode(): string {
  const b = randomBytes(25);
  const s = Array.from(b, (x) => ALPHABET[x & 31]).join("");
  return `QW-${s.match(/.{1,5}/g)!.join("-")}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "new") {
    const n = Number(arg ?? 1);
    for (let i = 0; i < n; i++) {
      const c = newCode();
      console.log(`${c}\t${hashCode(c)}`);
    }
    console.error("Give each code to one pilot user. Put only the hash column into the codes file.");
  } else if (cmd === "hash" && arg) {
    console.log(hashCode(arg));
  } else {
    console.error("usage: codes.ts new <count> | hash <code>");
    process.exitCode = 1;
  }
}
