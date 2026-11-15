import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { hashFile } from "../src/agent/hash-file.js";

describe("hashFile", () => {
  it("gives SHA-256 and SHA3-256 in one pass (FIPS 180-4 and FIPS 202 vectors for \"abc\")", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "qw-")), "abc.bin");
    writeFileSync(f, "abc");
    const h = await hashFile(f);
    assert.equal(Buffer.from(h.sha256).toString("hex"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(Buffer.from(h.sha3).toString("hex"), "3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532");
  });
});
