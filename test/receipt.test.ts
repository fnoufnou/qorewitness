import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReceipt } from "../src/agent/receipt.js";
import { gitCommit, SPEC_VERSION } from "../src/agent/version.js";

describe("receipt generator info", () => {
  it("records tool, version, commit, spec and settings", () => {
    const r = buildReceipt(
      {
        chain: { evmChainId: 9800, registry: "0x0000000000000000000000000000000000000001" },
        owner: "0x0000000000000000000000000000000000000002", deviceId: `0x${"11".repeat(32)}`, deviceLabel: "t",
        devicePubkey: "0x00", root: `0x${"22".repeat(32)}`, signature: "0x00",
      },
      { windowStart: 600n, windowSeconds: 600, segments: [{ path: "/x/a.mp4", sha256: new Uint8Array(32), size: 1, completedAt: 601 }] },
    );
    assert.equal(r.generator?.name, "qorewitness");
    assert.equal(r.generator?.spec, SPEC_VERSION);
    assert.match(r.generator?.version ?? "", /^\d+\.\d+\.\d+/);
    assert.match(r.generator?.commit ?? "", /^([0-9a-f]{40}|unknown)$/);
    assert.equal(r.settings?.merkle, "rfc6962-sha256-promote-odd");
  });

  it("reads the commit of this checkout", () => {
    assert.match(gitCommit(), /^[0-9a-f]{40}$/);
  });

  it("QW_COMMIT overrides the commit", () => {
    process.env.QW_COMMIT = "a".repeat(40);
    try {
      assert.equal(gitCommit(), "a".repeat(40));
    } finally {
      delete process.env.QW_COMMIT;
    }
  });
});
