/**
 * Minimal ZIP reader for the browser verifier. No library.
 * Reads the central directory. Supports stored (0) and deflate (8) entries.
 * Refuses encryption, ZIP64, odd names (path traversal) and entries that
 * inflate to more than their declared size. Runs in browsers and in Node 22.
 */
export interface ZipFile {
  name: string;
  size: number;
  /** Stored entries come back as a view into the input: no copy. */
  bytes(): Promise<Uint8Array>;
}

export const MAX_ENTRIES = 5000;
export const MAX_TOTAL_BYTES = 4 * 1024 ** 3;

const u16 = (d: DataView, o: number) => d.getUint16(o, true);
const u32 = (d: DataView, o: number) => d.getUint32(o, true);

/** A name is safe if it stays inside the archive: relative, no "..", no backslash, no drive, no control characters. */
export function safeName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name.startsWith("/") || name.includes("\\") || /^[a-zA-Z]:/.test(name)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) return false;
  return !name.split("/").some((p) => p === ".." || p === ".");
}

async function inflate(raw: Uint8Array, expected: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new Error("This browser cannot unpack compressed ZIP files. Use a current Chrome, Edge, Firefox or Safari.");
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const out = new Uint8Array(expected);
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > expected) {
      await reader.cancel();
      throw new Error("A file in the ZIP is larger than it says. The ZIP is damaged.");
    }
    out.set(value, n);
    n += value.length;
  }
  if (n !== expected) throw new Error("A file in the ZIP is shorter than it says. The ZIP is damaged.");
  return out;
}

export function readZip(buf: Uint8Array): ZipFile[] {
  const d = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // End of central directory: scan back over a possible comment (max 65535 bytes).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (u32(d, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("This is not a ZIP file, or it is damaged.");
  const count = u16(d, eocd + 10);
  const cdSize = u32(d, eocd + 12);
  const cdOffset = u32(d, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("ZIP64 files are not supported.");
  if (count > MAX_ENTRIES) throw new Error("The ZIP holds too many files.");
  if (cdOffset + cdSize > eocd) throw new Error("The ZIP is damaged.");

  const files: ZipFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  let p = cdOffset;
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || u32(d, p) !== 0x02014b50) throw new Error("The ZIP is damaged.");
    const flags = u16(d, p + 8);
    const method = u16(d, p + 10);
    const csize = u32(d, p + 20);
    const usize = u32(d, p + 24);
    const nlen = u16(d, p + 28);
    const elen = u16(d, p + 30);
    const clen = u16(d, p + 32);
    const local = u32(d, p + 42);
    const name = new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (name.endsWith("/")) continue; // folder entry
    if (!safeName(name)) throw new Error(`The ZIP holds a file with an unsafe name. It was not opened.`);
    if (seen.has(name)) throw new Error("The ZIP holds two files with the same name.");
    seen.add(name);
    if (flags & 1) throw new Error("Encrypted ZIP files are not supported.");
    if (method !== 0 && method !== 8) throw new Error("This ZIP uses a compression method that is not supported.");
    if (csize === 0xffffffff || usize === 0xffffffff) throw new Error("ZIP64 files are not supported.");
    total += usize;
    if (total > MAX_TOTAL_BYTES) throw new Error("The ZIP is too large to check in a browser.");
    if (local + 30 > buf.length || u32(d, local) !== 0x04034b50) throw new Error("The ZIP is damaged.");
    const start = local + 30 + u16(d, local + 26) + u16(d, local + 28);
    if (start + csize > buf.length) throw new Error("The ZIP is damaged (cut off). Download it again.");
    if (method === 0 && csize !== usize) throw new Error("The ZIP is damaged.");
    const raw = buf.subarray(start, start + csize);
    files.push({
      name, size: usize,
      bytes: () => (method === 0 ? Promise.resolve(raw) : inflate(raw, usize)),
    });
  }
  return files;
}
