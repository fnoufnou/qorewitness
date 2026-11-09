import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** Streams a file through SHA-256. Works for multi-GB recordings with flat memory use. */
export function sha256File(path: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("error", reject)
      .on("data", (chunk) => h.update(chunk))
      .on("end", () => resolve(new Uint8Array(h.digest())));
  });
}
