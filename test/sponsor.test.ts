/**
 * Sponsor service tests. The chain and the hot wallet are mocks: no network,
 * no wallet, no transaction. Device keys are throwaway test keys from fixed seeds.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { mldsa } from "@qorechain/pqc";
import { getAddress, toHex, type Address, type Hex } from "viem";
import { deviceKeyFromSeed, type DeviceKey } from "../src/agent/device-key.js";
import { assertPilotChain, type ChainReader, type DeviceInfo, type Payer } from "../services/sponsor/chain.js";
import { hashCode } from "../services/sponsor/codes.js";
import { loadConfig, loadMnemonic, REGISTRY_V4, type SponsorConfig } from "../services/sponsor/config.js";
import { createSponsorServer, RateLimiter } from "../services/sponsor/http.js";
import { redact, silentLogger, truncateIp } from "../services/sponsor/log.js";
import { sponsorMessage, sponsorMessageText, verifySponsorSignature } from "../services/sponsor/message.js";
import { ApiError, Sponsor, type Clock } from "../services/sponsor/service.js";

const QOR = 1_000_000n;
const OWNER: Address = getAddress("0x1111111111111111111111111111111111111111");
const OTHER: Address = getAddress("0x2222222222222222222222222222222222222222");
const DEV: Hex = `0x${"ab".repeat(32)}`;
const DEV2: Hex = `0x${"cd".repeat(32)}`;
const CODE = "QW-TEST1-CODE2";

const key = (b: number): DeviceKey => deviceKeyFromSeed(new Uint8Array(32).fill(b));
const camKey = key(7);
const strangerKey = key(9);

class MockChain implements ChainReader {
  evm = 9800;
  cosmos = "qorechain-diana";
  devices = new Map<string, DeviceInfo & { pub: Hex; count: bigint; end: number }>();
  balances = new Map<string, bigint>();
  constructor(readonly clock: FakeClock) {}
  add(owner: Address, deviceId: Hex, k: DeviceKey, count = 10n) {
    this.devices.set(`${owner}|${deviceId}`, { keyHash: k.keyHash, status: "active", pub: k.publicKeyHex, count, end: this.clock.t });
  }
  dev(owner: Address, deviceId: Hex) {
    return this.devices.get(`${owner}|${deviceId.toLowerCase()}`) ?? this.devices.get(`${owner}|${deviceId}`);
  }
  anchor(owner: Address, deviceId: Hex, n: number) {
    const d = this.dev(owner, deviceId)!;
    d.count += BigInt(n);
    d.end = this.clock.t;
  }
  async evmChainId() { return this.evm; }
  async cosmosChainId() { return this.cosmos; }
  async getDevice(owner: Address, deviceId: Hex): Promise<DeviceInfo> {
    const d = this.dev(owner, deviceId);
    return d ? { keyHash: d.keyHash, status: d.status } : { keyHash: `0x${"00".repeat(32)}`, status: "none" };
  }
  async devicePubkey(owner: Address, deviceId: Hex, keyHash: Hex) {
    const d = this.dev(owner, deviceId);
    return d && d.keyHash === keyHash ? d.pub : undefined;
  }
  async anchorCount(owner: Address, deviceId: Hex) { return this.dev(owner, deviceId)?.count ?? 0n; }
  async lastWindowEnd(owner: Address, deviceId: Hex) { return this.dev(owner, deviceId)?.end ?? 0; }
  async balanceUqor(owner: Address) { return this.balances.get(owner) ?? 0n; }
}

class MockPayer implements Payer {
  sent: { owner: Address; uqor: bigint }[] = [];
  float = 500n * QOR;
  mode: "ok" | "refuse" | "throw" = "ok";
  address(): Address { return "0x000000000000000000000000000000000000bEEF"; }
  async floatUqor() { return this.float; }
  async pay(owner: Address, uqor: bigint) {
    if (this.mode === "throw") throw new Error("rpc timeout");
    if (this.mode === "refuse") return { ok: false, txHash: "AB", code: 5 };
    this.sent.push({ owner, uqor });
    this.float -= uqor;
    return { ok: true, txHash: `TX${this.sent.length}`, code: 0 };
  }
}

class FakeClock implements Clock {
  t = 1_794_960_060; // 00:01:00 UTC
  now() { return this.t; }
}

function setup(over: Partial<SponsorConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "qw-sponsor-"));
  writeFileSync(join(dir, "codes.txt"), `# pilot codes\n${hashCode(CODE)}\n${hashCode("QW-SECOND")}\n`);
  const cfg: SponsorConfig = {
    ...loadConfig({ SPONSOR_DATA_DIR: dir }),
    codesFile: join(dir, "codes.txt"),
    minPayoutIntervalSeconds: 0,
    ...over,
  };
  const clock = new FakeClock();
  const chain = new MockChain(clock);
  const payer = new MockPayer();
  const sponsor = new Sponsor(cfg, chain, payer, clock);
  return { dir, cfg, clock, chain, payer, sponsor };
}

const sign = (k: DeviceKey, text: string): Hex => toHex(mldsa.sign(k.secretKey, new TextEncoder().encode(text)));

function enrollBody(sponsor: Sponsor, k: DeviceKey, opts: { owner?: Address; deviceId?: Hex; code?: string; text?: (n: Hex) => string } = {}) {
  const deviceId = opts.deviceId ?? DEV;
  const owner = opts.owner ?? OWNER;
  const { nonce } = sponsor.challenge({ deviceId });
  const text = opts.text?.(nonce) ?? sponsorMessageText(REGISTRY_V4.toLowerCase(), deviceId, owner.toLowerCase(), nonce);
  return { pilotCode: opts.code ?? CODE, deviceId, owner, nonce, signature: sign(k, text) };
}

const rejects = async (p: Promise<unknown>, code: string) => {
  await assert.rejects(p, (e: unknown) => e instanceof ApiError && e.code === code);
};

describe("sponsor: camera signature", () => {
  const nonce: Hex = `0x${"5a".repeat(32)}`;
  const base = { registry: REGISTRY_V4, deviceId: DEV, owner: OWNER, nonce, devicePubkey: camKey.publicKeyHex, onChainKeyHash: camKey.keyHash };

  it("accepts a valid signature over the exact text", () => {
    const msg = sponsorMessage(REGISTRY_V4, DEV, OWNER, nonce);
    const text = new TextDecoder().decode(msg);
    assert.equal(text, `qorewitness-sponsor-v1|9800|${REGISTRY_V4.toLowerCase()}|${DEV}|${OWNER.toLowerCase()}|${nonce}`);
    assert.equal(verifySponsorSignature({ ...base, signature: toHex(mldsa.sign(camKey.secretKey, msg)) }), true);
  });

  it("accepts checksummed addresses in the signed text", () => {
    const sig = sign(camKey, sponsorMessageText(REGISTRY_V4, DEV, OWNER, nonce));
    assert.equal(verifySponsorSignature({ ...base, signature: sig }), true);
  });

  it("refuses a signature over another text", () => {
    for (const text of [
      sponsorMessageText(REGISTRY_V4.toLowerCase(), DEV, OTHER.toLowerCase(), nonce), // other owner
      sponsorMessageText(REGISTRY_V4.toLowerCase(), DEV2, OWNER.toLowerCase(), nonce), // other device
      sponsorMessageText(REGISTRY_V4.toLowerCase(), DEV, OWNER.toLowerCase(), `0x${"00".repeat(32)}`), // other nonce
      sponsorMessageText(REGISTRY_V4.toLowerCase(), DEV, OWNER.toLowerCase(), nonce).replace("|9800|", "|9801|"), // other chain
      sponsorMessageText(REGISTRY_V4.toLowerCase(), DEV, OWNER.toLowerCase(), nonce).replace("-v1|", "-v2|"), // other domain
    ]) {
      assert.equal(verifySponsorSignature({ ...base, signature: sign(camKey, text) }), false, text);
    }
  });

  it("refuses a signature by another key, and a key that is not the one on chain", () => {
    const text = new TextDecoder().decode(sponsorMessage(REGISTRY_V4, DEV, OWNER, nonce));
    assert.equal(verifySponsorSignature({ ...base, signature: sign(strangerKey, text) }), false);
    // The stranger signs and offers its own key, but the chain binds the camera key hash.
    assert.equal(verifySponsorSignature({ ...base, devicePubkey: strangerKey.publicKeyHex, signature: sign(strangerKey, text) }), false);
  });

  it("enrol checks the signature against the key on chain", async () => {
    const { sponsor, chain } = setup();
    chain.add(OWNER, DEV, camKey);
    await rejects(sponsor.enroll(enrollBody(sponsor, strangerKey)), "bad_signature");
    await rejects(sponsor.enroll(enrollBody(sponsor, camKey, { text: (n) => sponsorMessageText(REGISTRY_V4.toLowerCase(), DEV, OTHER.toLowerCase(), n) })), "bad_signature");
    const ok = await sponsor.enroll(enrollBody(sponsor, camKey));
    assert.equal(ok.status, "enrolled");
    assert.equal(ok.capPerDayUqor, (9n * QOR).toString());
  });

  it("enrol refuses an owner that does not own the device on chain", async () => {
    const { sponsor, chain } = setup();
    chain.add(OWNER, DEV, camKey);
    const body = enrollBody(sponsor, camKey, { owner: OTHER });
    await rejects(sponsor.enroll(body), "not_owner");
  });

  it("enrol refuses an unknown pilot code and a code bound to another owner", async () => {
    const { sponsor, chain } = setup();
    chain.add(OWNER, DEV, camKey);
    chain.add(OTHER, DEV2, strangerKey);
    await rejects(sponsor.enroll(enrollBody(sponsor, camKey, { code: "QW-NOPE" })), "bad_code");
    await sponsor.enroll(enrollBody(sponsor, camKey));
    await rejects(sponsor.enroll(enrollBody(sponsor, strangerKey, { owner: OTHER, deviceId: DEV2 })), "code_used");
  });
});

describe("sponsor: nonce", () => {
  it("is single use", async () => {
    const { sponsor, chain } = setup();
    chain.add(OWNER, DEV, camKey);
    const body = enrollBody(sponsor, camKey);
    await sponsor.enroll(body);
    await rejects(sponsor.enroll(body), "bad_nonce");
  });

  it("is used up by a failed attempt too", async () => {
    const { sponsor, chain } = setup();
    chain.add(OWNER, DEV, camKey);
    const body = enrollBody(sponsor, camKey);
    await rejects(sponsor.enroll({ ...body, pilotCode: "QW-WRONG" }), "bad_code");
    await rejects(sponsor.enroll(body), "bad_nonce");
  });

  it("expires after 5 minutes and is bound to the device", async () => {
    const { sponsor, chain, clock } = setup();
    chain.add(OWNER, DEV, camKey);
    const body = enrollBody(sponsor, camKey);
    clock.t += 301;
    await rejects(sponsor.enroll(body), "bad_nonce");
    const { nonce } = sponsor.challenge({ deviceId: DEV2 });
    const text = sponsorMessageText(REGISTRY_V4.toLowerCase(), DEV, OWNER.toLowerCase(), nonce);
    await rejects(sponsor.enroll({ pilotCode: CODE, deviceId: DEV, owner: OWNER, nonce, signature: sign(camKey, text) }), "bad_nonce");
  });

  it("is 32 random bytes with a 5-minute expiry", () => {
    const { sponsor, clock } = setup();
    const a = sponsor.challenge({ deviceId: DEV });
    const b = sponsor.challenge({ deviceId: DEV });
    assert.match(a.nonce, /^0x[0-9a-f]{64}$/);
    assert.notEqual(a.nonce, b.nonce);
    assert.equal(a.expires, clock.t + 300);
    assert.throws(() => sponsor.challenge({ deviceId: "front-door" }), ApiError);
  });
});

async function enrolled(over: Partial<SponsorConfig> = {}, balance = 5n * QOR) {
  const f = setup(over);
  f.chain.add(OWNER, DEV, camKey, 100n);
  f.chain.balances.set(OWNER, balance);
  await f.sponsor.enroll(enrollBody(f.sponsor, camKey));
  return f;
}

describe("sponsor: top-ups and caps", () => {
  it("refills what was used: anchors seen on chain since enrolment x credit per anchor", async () => {
    const { sponsor, chain, payer, clock, cfg } = await enrolled();
    clock.t += 7200;
    chain.anchor(OWNER, DEV, 12);
    const r = await sponsor.runOnce();
    assert.equal(r.paid, 1);
    assert.deepEqual(payer.sent, [{ owner: OWNER, uqor: 12n * cfg.perAnchorUqor }]);
    // Nothing new on chain: nothing more to pay.
    clock.t += 3600;
    assert.equal((await sponsor.runOnce()).paid, 0);
    const st = sponsor.status(DEV);
    assert.equal(st.enrolled, true);
    assert.equal(st.lastTopUp?.txHash, "TX1");
    assert.equal(st.usedTodayUqor, (12n * cfg.perAnchorUqor).toString());
    assert.equal(readFileSync(cfg.payoutLog, "utf8").trim().split("\n").length, 2); // pending + sent
  });

  it("pays only to the on-chain owner address", async () => {
    const { sponsor, chain, payer, clock } = await enrolled();
    clock.t += 7200;
    chain.anchor(OWNER, DEV, 12);
    await sponsor.runOnce();
    assert.ok(payer.sent.length > 0);
    assert.ok(payer.sent.every((s) => s.owner === OWNER));
  });

  it("skips owners at or above the threshold, and devices without a recent anchor", async () => {
    const { sponsor, chain, payer, clock } = await enrolled({}, 12n * QOR);
    clock.t += 3600;
    chain.anchor(OWNER, DEV, 6);
    assert.equal((await sponsor.runOnce()).paid, 0);
    chain.balances.set(OWNER, 1n * QOR);
    clock.t += 3 * 3600; // last anchor now 3 h old
    assert.equal((await sponsor.runOnce()).paid, 0);
    assert.equal(payer.sent.length, 0);
  });

  it("never tops up above the target balance", async () => {
    const { sponsor, chain, payer, clock } = await enrolled({}, 9n * QOR);
    clock.t += 86_000;
    chain.anchor(OWNER, DEV, 140);
    await sponsor.runOnce();
    assert.equal(payer.sent[0].uqor, 6n * QOR); // target 15 - balance 9
  });

  it("caps a camera per day, and opens again the next UTC day", async () => {
    const { sponsor, chain, payer, clock } = await enrolled({ targetUqor: 1000n * QOR, thresholdUqor: 1000n * QOR, capOwnerDayUqor: 1000n * QOR, minWindowSeconds: 60 });
    clock.t += 3600 * 20; // 20:01 UTC
    chain.anchor(OWNER, DEV, 120); // 5.76 QOR
    await sponsor.runOnce();
    clock.t += 3600 * 3;
    chain.anchor(OWNER, DEV, 120); // would be 5.76 more
    await sponsor.runOnce();
    const today = payer.sent.reduce((s, p) => s + p.uqor, 0n);
    assert.equal(today, 9n * QOR);
    clock.t += 3600 * 2; // next UTC day
    chain.anchor(OWNER, DEV, 12);
    await sponsor.runOnce();
    assert.equal(payer.sent.length, 3);
  });

  it("caps an owner per day across cameras", async () => {
    const { sponsor, chain, payer, clock } = await enrolled({ capOwnerDayUqor: 2n * QOR, thresholdUqor: 100n * QOR, targetUqor: 100n * QOR });
    chain.add(OWNER, DEV2, strangerKey, 0n);
    await sponsor.enroll(enrollBody(sponsor, strangerKey, { deviceId: DEV2 }));
    clock.t += 86_000 / 2;
    chain.anchor(OWNER, DEV, 50);
    chain.anchor(OWNER, DEV2, 50);
    await sponsor.runOnce();
    assert.equal(payer.sent.reduce((s, p) => s + p.uqor, 0n), 2n * QOR);
  });

  it("caps the global budget per day", async () => {
    const { sponsor, chain, payer, clock, cfg } = await enrolled({ capGlobalDayUqor: 1n * QOR });
    clock.t += 43_000;
    chain.anchor(OWNER, DEV, 100);
    await sponsor.runOnce();
    assert.equal(payer.sent[0].uqor, 1n * QOR);
    assert.ok(cfg.capGlobalDayUqor === 1n * QOR);
  });

  it("limits the number of enrolled cameras, globally and per owner", async () => {
    const { sponsor, chain } = setup({ maxCameras: 1 });
    chain.add(OWNER, DEV, camKey);
    chain.add(OTHER, DEV2, strangerKey);
    await sponsor.enroll(enrollBody(sponsor, camKey));
    await rejects(sponsor.enroll(enrollBody(sponsor, strangerKey, { owner: OTHER, deviceId: DEV2, code: "QW-SECOND" })), "pilot_full");
    const f = setup({ maxCamerasPerOwner: 1 });
    f.chain.add(OWNER, DEV, camKey);
    f.chain.add(OWNER, DEV2, strangerKey);
    await f.sponsor.enroll(enrollBody(f.sponsor, camKey));
    await rejects(f.sponsor.enroll(enrollBody(f.sponsor, strangerKey, { deviceId: DEV2 })), "owner_full");
  });

  it("credits at most one anchor per minimum window length (no farming with 1-second windows)", async () => {
    const { sponsor, chain, payer, clock, cfg } = await enrolled({ minPayoutUqor: 1n });
    clock.t += 1200;
    chain.anchor(OWNER, DEV, 500);
    await sponsor.runOnce();
    assert.equal(payer.sent[0].uqor, 3n * cfg.perAnchorUqor); // 1200 s / 600 s + 1
  });

  it("does not pay twice when the send result is unknown, and undoes a refused send", async () => {
    const { sponsor, chain, payer, clock } = await enrolled();
    clock.t += 7200;
    chain.anchor(OWNER, DEV, 12);
    payer.mode = "refuse";
    await sponsor.runOnce();
    assert.equal(sponsor.status(DEV).usedTodayUqor, "0");
    payer.mode = "throw";
    await sponsor.runOnce();
    const used = sponsor.status(DEV).usedTodayUqor;
    assert.notEqual(used, "0");
    payer.mode = "ok";
    clock.t += 60;
    await sponsor.runOnce();
    assert.equal(payer.sent.length, 0);
  });

  it("keeps state across restarts (atomic JSON file)", async () => {
    const { cfg, chain, payer, clock } = await enrolled();
    const again = new Sponsor(cfg, chain, payer, clock);
    assert.equal(again.status(DEV).enrolled, true);
    assert.equal(existsSync(`${cfg.stateFile}.${process.pid}.tmp`), false);
  });
});

describe("sponsor: kill switch", () => {
  it("a pause file stops enrolment and top-ups", async () => {
    const { sponsor, chain, payer, clock, cfg } = await enrolled();
    writeFileSync(cfg.pauseFile, "manual\n");
    clock.t += 3600;
    chain.anchor(OWNER, DEV, 6);
    const r = await sponsor.runOnce();
    assert.deepEqual(r.skipped, ["paused"]);
    assert.equal(payer.sent.length, 0);
    await rejects(sponsor.enroll(enrollBody(sponsor, camKey)), "paused");
    assert.equal(sponsor.status(DEV).paused, true);
  });

  it("pauses itself when the hourly outflow limit is reached", async () => {
    const { sponsor, chain, payer, clock, cfg } = await enrolled({ maxHourlyUqor: 1n * QOR });
    clock.t += 43_000;
    chain.anchor(OWNER, DEV, 100);
    await sponsor.runOnce();
    assert.equal(payer.sent[0].uqor, 1n * QOR);
    clock.t += 600;
    chain.anchor(OWNER, DEV, 10);
    await sponsor.runOnce();
    assert.equal(existsSync(cfg.pauseFile), true);
    assert.equal(sponsor.paused(), true);
  });
});

describe("sponsor: chain id guard", () => {
  it("refuses any chain but 9800 / qorechain-diana", async () => {
    const { sponsor, chain, payer, clock } = await enrolled();
    await sponsor.start();
    chain.evm = 9801;
    await assert.rejects(sponsor.start(), /chain id 9801/);
    clock.t += 3600;
    chain.anchor(OWNER, DEV, 6);
    await assert.rejects(sponsor.runOnce(), /expected 9800/);
    chain.evm = 9800;
    chain.cosmos = "qorechain-vladi";
    await assert.rejects(assertPilotChain(chain), /qorechain-diana/);
    assert.equal(payer.sent.length, 0);
  });
});

describe("sponsor: secrets, logs and rate limits", () => {
  it("refuses a secret file that others can read", () => {
    const dir = mkdtempSync(join(tmpdir(), "qw-secret-"));
    const f = join(dir, "secret.env");
    const words = Array.from({ length: 24 }, () => "abandon").join(" ");
    writeFileSync(f, `SPONSOR_MNEMONIC=${words}\n`);
    chmodSync(f, 0o644);
    assert.throws(() => loadMnemonic(f), (e: Error) => /chmod 600/.test(e.message) && !e.message.includes("abandon"));
    chmodSync(f, 0o600);
    assert.equal(loadMnemonic(f).split(" ").length, 24);
  });

  it("truncates IPs and redacts secrets", () => {
    assert.equal(truncateIp("203.0.113.77"), "203.0.113.x");
    assert.equal(truncateIp("::ffff:198.51.100.9"), "198.51.100.x");
    assert.equal(truncateIp("2001:db8:abcd:12:1:2:3:4"), "2001:db8:abcd::x");
    assert.ok(!redact(`key 0x${"1f".repeat(32)}`).includes("1f".repeat(32)));
    assert.ok(redact(Array.from({ length: 12 }, () => "zoo").join(" ")).includes("[redacted"));
    assert.equal(redact("rtsp://user:pass@cam/stream1"), "rtsp://***@cam/stream1");
  });

  it("rate limits per IP and route", () => {
    const rl = new RateLimiter({ challenge: 2 });
    assert.equal(rl.allow("a", "challenge", 0), true);
    assert.equal(rl.allow("a", "challenge", 1), true);
    assert.equal(rl.allow("a", "challenge", 2), false);
    assert.equal(rl.allow("b", "challenge", 2), true);
    assert.equal(rl.allow("a", "challenge", 60_001), true);
  });
});

describe("sponsor: HTTP API", () => {
  it("serves challenge, enrol, status and healthz, and refuses bad requests", async () => {
    const { sponsor, chain } = setup();
    chain.add(OWNER, DEV, camKey);
    const server = createSponsorServer(sponsor, silentLogger, ["127.0.0.1"]);
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as { port: number }).port;
    const url = (p: string) => `http://127.0.0.1:${port}${p}`;
    const post = (p: string, body: unknown) =>
      fetch(url(p), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const h = await fetch(url("/healthz"));
      assert.equal(h.status, 200);
      assert.equal(((await h.json()) as { ok: boolean }).ok, true);
      const c = (await (await post("/v1/challenge", { deviceId: DEV })).json()) as { nonce: Hex; expires: number };
      const text = sponsorMessageText(REGISTRY_V4.toLowerCase(), DEV, OWNER.toLowerCase(), c.nonce);
      const e = await post("/sponsor/v1/enroll", { pilotCode: CODE, deviceId: DEV, owner: OWNER, nonce: c.nonce, signature: sign(camKey, text).slice(2) });
      assert.equal(e.status, 200);
      assert.equal(((await e.json()) as { status: string }).status, "enrolled");
      const st = (await (await fetch(url(`/v1/status/${DEV}`))).json()) as { enrolled: boolean; capPerDayUqor: string };
      assert.equal(st.enrolled, true);
      assert.equal((await post("/v1/challenge", { deviceId: "x" })).status, 400);
      assert.equal((await fetch(url("/v1/challenge"), { method: "POST", body: "{}" })).status, 415);
      assert.equal((await post("/v1/enroll", { pilotCode: "x".repeat(20_000) })).status, 413);
      assert.equal((await fetch(url("/admin"))).status, 404);
    } finally {
      server.close();
    }
  });
});
