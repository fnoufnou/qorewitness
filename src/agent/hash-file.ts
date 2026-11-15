import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** Streams a file through SHA-256. Works for multi-GB recordings with flat memory use. */
export async function sha256File(path: string): Promise<Uint8Array> {
  return (await hashFile(path)).sha256;
}

/** Streams a file once through SHA-256 and SHA3-256 (spec/3). Flat memory use. */
export function hashFile(path: string): Promise<{ sha256: Uint8Array; sha3: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const a = createHash("sha256");
    const b = createHash("sha3-256");
    createReadStream(path)
      .on("error", reject)
      .on("data", (chunk) => {
        a.update(chunk);
        b.update(chunk);
      })
      .on("end", () => resolve({ sha256: new Uint8Array(a.digest()), sha3: new Uint8Array(b.digest()) }));
  });
}
