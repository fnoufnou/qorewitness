import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  dataPaths, ensureDeviceKey, ensureOwnerAccount, finishSetup, keyFingerprint, readEnvFile,
  registerOnChain, saveCamera, writeEnvFile,
} from "../src/setup/steps.js";
import { mockChain } from "./helpers/mock-chain.js";

const mode = (p: string) => statSync(p).mode & 0o777;

const tmpData = () => dataPaths(mkdtempSync(join(tmpdir(), "qw-data-")));

describe("setup steps: files and modes", () => {
  it("writes camera.env, qorewitness.env and the key with mode 600, folders 700", async () => {
    const p = tmpData();
    saveCamera(p, { label: "cam-1", streamUrl: "rtsp://u:secret@10.0.0.2:554/stream1", retentionDays: 7 });
    await ensureOwnerAccount(p);
    ensureDeviceKey(p, "cam-1");
    assert.equal(mode(p.cameraEnv), 0o600);
    assert.equal(mode(p.accountEnv), 0o600);
    assert.equal(mode(join(p.keysDir, "cam-1.key")), 0o600);
    assert.equal(mode(p.keysDir), 0o700);
    assert.equal(mode(p.uiDir), 0o700);
    assert.equal(readEnvFile(p.cameraEnv).QW_RETENTION_DAYS, "7");
  });

  it("fixes a camera.env that an older version left at 644", () => {
    const p = tmpData();
    writeFileSync(p.cameraEnv, "QW_DEVICE=cam\nQW_SEGMENT_SECONDS=30\n", { mode: 0o644 });
    saveCamera(p, { label: "cam", streamUrl: "rtsp://u:p@10.0.0.2/stream1" });
    assert.equal(mode(p.cameraEnv), 0o600);
    assert.equal(readEnvFile(p.cameraEnv).QW_SEGMENT_SECONDS, "30");
  });

  it("refuses env values with a line break (no injected settings)", () => {
    const p = tmpData();
    assert.throws(() => writeEnvFile(p.cameraEnv, { QW_STREAM_URL: "rtsp://x\nQORE_REGISTRY=0xevil" }));
    assert.throws(() => saveCamera(p, { label: "Bad Name", streamUrl: "rtsp://x" }));
    assert.throws(() => saveCamera(p, { label: "cam", streamUrl: "file:///etc/passwd" }));
  });

  it("keeps the same account and key on a second run", async () => {
    const p = tmpData();
    const a = await ensureOwnerAccount(p);
    const b = await ensureOwnerAccount(p);
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(a.evm, b.evm);
    const k1 = ensureDeviceKey(p, "cam");
    const k2 = ensureDeviceKey(p, "cam");
    assert.equal(k2.created, false);
    assert.equal(k1.key.keyHash, k2.key.keyHash);
    assert.match(keyFingerprint(k1.key.keyHash), /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
  });

  it("account.json is public (644) and holds no secret", async () => {
    const p = tmpData();
    saveCamera(p, { label: "cam", streamUrl: "rtsp://u:topsecret@10.0.0.2/stream1" });
    const o = await ensureOwnerAccount(p);
    const { key } = ensureDeviceKey(p, "cam");
    finishSetup(p, {
      device: "cam", deviceId: `0x${"01".repeat(32)}`, owner: o.evm, qor1: o.cosmos, registry: o.registry,
      plan: "self", keyFingerprint: keyFingerprint(key.keyHash), setupAt: "2026-11-21T00:00:00Z",
    });
    assert.equal(mode(p.accountJson), 0o644);
    const text = readFileSync(p.accountJson, "utf8");
    const mnemonic = readEnvFile(p.accountEnv).QORE_MNEMONIC;
    assert.ok(!text.includes("topsecret"));
    assert.ok(!text.includes(mnemonic.split(" ").slice(0, 3).join(" ")));
    assert.throws(() => saveCamera(p, { label: "other", streamUrl: "rtsp://10.0.0.2/stream1" }), /cannot change/);
  });
});

describe("setup steps: registration (mocked chain)", () => {
  it("registers once and changes nothing on a second run", async () => {
    const p = tmpData();
    await ensureOwnerAccount(p);
    const m = mockChain();
    const seen: string[] = [];
    const r1 = await registerOnChain(p, "cam", m.chain, (n, t, text) => seen.push(`${n}/${t} ${text}`));
    assert.ok(r1.txHash);
    assert.deepEqual(m.calls.filter((c) => c !== "assert"), ["registerPqcKey", "ensureWindow", "registerDevice"]);
    assert.equal(seen.length, 4);
    const r2 = await registerOnChain(p, "cam", m.chain);
    assert.equal(r2.txHash, undefined);
    assert.equal(m.calls.filter((c) => c === "registerDevice").length, 1);
  });

  it("stops without funds, on another chain, or with a foreign account key", async () => {
    const p = tmpData();
    await ensureOwnerAccount(p);
    await assert.rejects(registerOnChain(p, "cam", mockChain({ balance: 0n }).chain), /not enough/);
    await assert.rejects(registerOnChain(p, "cam", mockChain({ wrongNetwork: true }).chain), /refusing to write/);
    const other = mockChain({ pqc: "other" });
    await assert.rejects(registerOnChain(p, "cam", other.chain), /another post-quantum key/);
    assert.ok(!other.calls.includes("registerDevice"));
  });

  it("refuses a camera name that is registered with another key", async () => {
    const p = tmpData();
    await ensureOwnerAccount(p);
    const m = mockChain();
    const { deviceIdOf } = await import("../src/core/message.js");
    m.devices.set(deviceIdOf("cam"), { status: 1, keyHash: `0x${"11".repeat(32)}`, keyVersion: 1 });
    await assert.rejects(registerOnChain(p, "cam", m.chain), /another key/);
  });
});
