/**
 * Sponsor service tests. The chain and the hot wallet are mocks: no network,
 * no wallet, no transaction. Device keys are throwaway test keys from fixed seeds.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { mldsa } from "@qorechain/pqc";
import { getAddress, toHex, type Address, type Hex } from "viem";
import { deviceKeyFromSeed, type DeviceKey } from "../src/agent/device-key.js";
import { assertPilotChain, type ChainReader, type DeviceInfo, type Payer } from "../services/sponsor/chain.js";
import { loadConfig, loadMnemonic, REGISTRY_V4, type SponsorConfig } from "../services/sponsor/config.js";
import { createSponsorServer, RateLimiter } from "../services/sponsor/http.js";
import { redact, silentLogger, truncateIp } from "../services/sponsor/log.js";
import { sponsorMessage, sponsorMessageText, verifySponsorSignature } from "../services/sponsor/message.js";
import { ApiError, Sponsor, type Clock } from "../services/sponsor/service.js";
import { enrollDevice, SponsorClient, sponsorBaseUrl } from "../src/web/sponsor.js";

const QOR = 1_000_000n;
const OWNER: Address = getAddress("0x1111111111111111111111111111111111111111");
const OTHER: Address = getAddress("0x2222222222222222222222222222222222222222");
const DEV: Hex = `0x${"ab".repeat(32)}`;
const DEV2: Hex = `0x${"cd".repeat(32)}`;
const CODE = "QW-ANY"; // accepted and ignored: the pilot needs no code

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
  /** Set by setup(): a sent payout raises the owner balance on the mock chain. */
  onPay?: (owner: Address, uqor: bigint) => void;
  address(): Address { return "0x000000000000000000000000000000000000bEEF"; }
  async floatUqor() { return this.float; }
  async pay(owner: Address, uqor: bigint) {
    if (this.mode === "throw") throw new Error("rpc timeout");
    if (this.mode === "refuse") return { ok: false, txHash: "AB", code: 5 };
    this.sent.push({ owner, uqor });
    this.float -= uqor;
    this.onPay?.(owner, uqor);
    return { ok: true, txHash: `TX${this.sent.length}`, code: 0 };
  }
}

class FakeClock implements Clock {
  t = 1_794_960_060; // 00:01:00 UTC
  now() { return this.t; }
}

function setup(over: Partial<SponsorConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "qw-sponsor-"));
  const cfg: SponsorConfig = {
    ...loadConfig({ SPONSOR_DATA_DIR: dir }),
    minPayoutIntervalSeconds: 0,
    maxEnrolPerIpDay: 1000, // the IP limit has its own tests
    ...over,
  };
  const clock = new FakeClock();
  const chain = new MockChain(clock);
  const payer = new MockPayer();
  payer.onPay = (owner, uqor) => chain.balances.set(owner, (chain.balances.get(owner) ?? 0n) + uqor);
  const sponsor = new Sponsor(cfg, chain, payer, clock);
  return { dir, cfg, clock, chain, payer, sponsor };
}

const sign = (k: DeviceKey, text: string): Hex => toHex(mldsa.sign(k.secretKey, new TextEncoder().encode(text)));

/** The box always sends the camera public key (devicePubkey). */
function enrollBody(sponsor: Sponsor, k: DeviceKey, opts: { owner?: Address; deviceId?: Hex; code?: string; text?: (n: Hex) => string; pub?: Hex } = {}) {
  const deviceId = opts.deviceId ?? DEV;
  const owner = opts.owner ?? OWNER;
  const { nonce } = sponsor.challenge({ deviceId });
  const text = opts.text?.(nonce) ?? sponsorMessageText(REGISTRY_V4.toLowerCase(), deviceId, owner.toLowerCase(), nonce);
  return { pilotCode: opts.code ?? CODE, deviceId, owner, nonce, signature: sign(k, text), devicePubkey: opts.pub ?? k.publicKeyHex };
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
    await rejects(sponsor.enroll(enrollBody(sponsor, strangerKey)), "rejected");
    await rejects(sponsor.enroll(enrollBody(sponsor, camKey, { text: (n) => sponsorMessageText(REGISTRY_V4.toLowerCase(), DEV, OTHER.toLowerCase(), n) })), "rejected");
    const ok = await sponsor.enroll(enrollBody(sponsor, camKey));
    assert.equal(ok.status, "enrolled");
    assert.equal(ok.capPerDayUqor, (9n * QOR).toString());
  });

  it("enrol refuses another owner that does not hold the camera key", async () => {
    const { sponsor, chain } = setup();
    chain.add(OWNER, DEV, camKey);
    const body = enrollBody(sponsor, strangerKey, { owner: OTHER, pub: camKey.publicKeyHex });
    await rejects(sponsor.enroll(body), "rejected");
  });

  it("requires devicePubkey (no history scan on chain)", async () => {
    const { sponsor, chain } = setup();
    chain.add(OWNER, DEV, camKey);
    const { devicePubkey: _k, ...noKey } = enrollBody(sponsor, camKey);
    await rejects(sponsor.enroll(noKey), "bad_pubkey");
    await rejects(sponsor.enroll({ ...enrollBody(sponsor, camKey), devicePubkey: "0x1234" }), "bad_pubkey");
  });

  it("enrols without a pilot code, and ignores one when sent", async () => {
    const { sponsor, chain } = setup();
    chain.add(OWNER, DEV, camKey);
    chain.add(OTHER, DEV2, strangerKey);
    const { pilotCode: _ignored, ...noCode } = enrollBody(sponsor, camKey);
    assert.equal((await sponsor.enroll(noCode)).status, "enrolled");
    assert.equal((await sponsor.enroll(enrollBody(sponsor, strangerKey, { owner: OTHER, deviceId: DEV2, code: "anything" }))).status, "enrolled");
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
    await rejects(sponsor.enroll({ ...body, owner: OTHER }), "rejected"); // not on chain, no devicePubkey
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
    await rejects(sponsor.enroll({ pilotCode: CODE, deviceId: DEV, owner: OWNER, nonce, signature: sign(camKey, text), devicePubkey: camKey.publicKeyHex }), "bad_nonce");
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
  it("tops up to the target buffer when the balance is below the threshold", async () => {
    const { sponsor, chain, payer, clock, cfg } = await enrolled({}, 8n * QOR);
    clock.t += 7200;
    chain.anchor(OWNER, DEV, 12);
    const r = await sponsor.runOnce();
    assert.equal(r.paid, 1);
    assert.deepEqual(payer.sent, [{ owner: OWNER, uqor: 7n * QOR }]); // target 15 - balance 8
    // The buffer is full: nothing more to pay.
    clock.t += 3600;
    chain.anchor(OWNER, DEV, 6);
    assert.equal((await sponsor.runOnce()).paid, 0);
    const st = sponsor.status(DEV);
    assert.equal(st.enrolled, true);
    assert.equal(st.lastTopUp?.txHash, "TX1");
    assert.equal(st.usedTodayUqor, (7n * QOR).toString());
    assert.equal(cfg.targetUqor, 15n * QOR);
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
    const { sponsor, chain, payer, clock } = await enrolled({ targetUqor: 1000n * QOR, thresholdUqor: 1000n * QOR, capOwnerDayUqor: 1000n * QOR });
    clock.t += 3600 * 20; // 20:01 UTC
    chain.anchor(OWNER, DEV, 120);
    await sponsor.runOnce();
    clock.t += 3600 * 3;
    chain.anchor(OWNER, DEV, 18);
    await sponsor.runOnce();
    assert.deepEqual(payer.sent.map((p) => p.uqor), [9n * QOR]);
    clock.t += 3600 * 2; // next UTC day
    chain.anchor(OWNER, DEV, 12);
    await sponsor.runOnce();
    assert.deepEqual(payer.sent.map((p) => p.uqor), [9n * QOR, 9n * QOR]);
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
    await rejects(sponsor.enroll(enrollBody(sponsor, strangerKey, { owner: OTHER, deviceId: DEV2, code: "QW-SECOND" })), "full");
    const f = setup({ maxCamerasPerOwner: 1 });
    f.chain.add(OWNER, DEV, camKey);
    f.chain.add(OWNER, DEV2, strangerKey);
    await f.sponsor.enroll(enrollBody(f.sponsor, camKey));
    await rejects(f.sponsor.enroll(enrollBody(f.sponsor, strangerKey, { deviceId: DEV2 })), "full");
  });

  it("pays only for a camera that sealed in the last 2 hours", async () => {
    const { sponsor, chain, payer, clock } = await enrolled({}, 1n * QOR);
    clock.t += 2 * 3600 + 60; // the last seal is older than 2 h
    await sponsor.runOnce();
    assert.equal(payer.sent.length, 0);
    chain.anchor(OWNER, DEV, 1);
    await sponsor.runOnce();
    assert.equal(payer.sent.length, 1);
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

  it("lets a payout wait for the next hour when the hourly limit would be passed, without a pause", async () => {
    const { sponsor, chain, payer, clock, cfg } = await enrolled({ maxHourlyUqor: 12n * QOR });
    chain.add(OTHER, DEV2, strangerKey);
    chain.balances.set(OTHER, 5n * QOR);
    await sponsor.enroll(enrollBody(sponsor, strangerKey, { owner: OTHER, deviceId: DEV2 }));
    clock.t += 600;
    chain.anchor(OWNER, DEV, 1);
    chain.anchor(OTHER, DEV2, 1);
    await sponsor.runOnce();
    assert.equal(payer.sent.length, 1); // 9 paid, the next 9 would pass 12 per hour
    assert.equal(sponsor.paused(), false);
    assert.equal(existsSync(cfg.pauseFile), false);
    clock.t += 3601;
    chain.anchor(OWNER, DEV, 6);
    chain.anchor(OTHER, DEV2, 6);
    await sponsor.runOnce();
    assert.equal(payer.sent.length, 2);
    assert.deepEqual(new Set(payer.sent.map((p) => p.owner)), new Set([OWNER, OTHER]));
  });

  it("pauses itself when the float drops more than the payouts explain", async () => {
    const { sponsor, chain, payer, clock, cfg } = await enrolled();
    clock.t += 600;
    chain.anchor(OWNER, DEV, 1);
    await sponsor.runOnce(); // one normal payout: no pause
    assert.equal(payer.sent.length, 1);
    assert.equal(sponsor.paused(), false);
    payer.float -= 50n * QOR; // money leaves the hot wallet without a payout
    chain.balances.set(OWNER, 1n * QOR);
    clock.t += 3600;
    chain.anchor(OWNER, DEV, 1);
    await sponsor.runOnce();
    assert.equal(existsSync(cfg.pauseFile), true);
    assert.match(readFileSync(cfg.pauseFile, "utf8"), /float dropped/);
    assert.equal(payer.sent.length, 1);
    payer.float += 100n * QOR; // money added by hand is fine
    rmSync(cfg.pauseFile);
    await sponsor.runOnce();
    assert.equal(sponsor.paused(), false);
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
      const e = await post("/sponsor/v1/enroll", { deviceId: DEV, owner: OWNER, nonce: c.nonce, signature: sign(camKey, text).slice(2), devicePubkey: camKey.publicKeyHex });
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

// ---------------------------------------------------------------- bootstrap path

/** Enrol body for a camera that is not on chain yet: the box sends its public key. */
function bootBody(sponsor: Sponsor, k: DeviceKey, opts: { owner?: Address; deviceId?: Hex; code?: string; pub?: Hex } = {}) {
  return { ...enrollBody(sponsor, k, opts), devicePubkey: opts.pub ?? k.publicKeyHex };
}

async function booted(over: Partial<SponsorConfig> = {}) {
  const f = setup(over);
  const a = await f.sponsor.enroll(bootBody(f.sponsor, camKey));
  assert.equal(a.status, "pending");
  await f.sponsor.idle();
  return f;
}

describe("sponsor: bootstrap (camera not on chain yet)", () => {
  it("sends one start grant to the owner, once", async () => {
    const { sponsor, payer, cfg } = await booted();
    assert.deepEqual(payer.sent, [{ owner: OWNER, uqor: 3n * QOR }]);
    assert.equal(sponsor.status(DEV).status, "funded");
    assert.equal(sponsor.status(DEV).startGrant?.txHash, "TX1");
    // The wizard retries: same key. Same answer, no second grant.
    assert.equal((await sponsor.enroll(bootBody(sponsor, camKey))).status, "funded");
    await sponsor.runOnce();
    await sponsor.idle();
    assert.equal(payer.sent.length, 1);
    assert.equal(cfg.grantUqor, 3n * QOR);
    const e = Object.values(sponsor.snapshot().enrollments)[0];
    assert.deepEqual([e.owner, e.deviceId, e.keyHash, e.path], [OWNER.toLowerCase(), DEV, camKey.keyHash.toLowerCase(), "bootstrap"]);
  });

  it("gives one start grant per camera, and a fixed number of grants per day", async () => {
    const { sponsor, payer } = await booted({ maxGrantsPerDay: 2 });
    await rejects(sponsor.enroll(bootBody(sponsor, strangerKey)), "rejected"); // same camera, another key
    assert.equal((await sponsor.enroll(bootBody(sponsor, strangerKey, { owner: OTHER, deviceId: DEV2 }))).status, "pending");
    const third = key(11);
    await rejects(sponsor.enroll(bootBody(sponsor, third, { owner: getAddress("0x3333333333333333333333333333333333333333"), deviceId: `0x${"ef".repeat(32)}` })), "full");
    await sponsor.idle();
    assert.equal(payer.sent.length, 2);
  });

  it("allows one new camera per IP per day", async () => {
    const { sponsor, chain, clock } = setup({ maxEnrolPerIpDay: 1 });
    assert.equal((await sponsor.enroll(bootBody(sponsor, camKey), "203.0.113.7")).status, "pending");
    await rejects(sponsor.enroll(bootBody(sponsor, strangerKey, { owner: OTHER, deviceId: DEV2 }), "203.0.113.7"), "full");
    // A retry of the same camera from that IP still gets its answer.
    assert.equal((await sponsor.enroll(bootBody(sponsor, camKey), "203.0.113.7")).status, "funded");
    // The on-chain path counts too.
    chain.add(OTHER, DEV2, strangerKey);
    await rejects(sponsor.enroll(enrollBody(sponsor, strangerKey, { owner: OTHER, deviceId: DEV2 }), "203.0.113.7"), "full");
    assert.equal((await sponsor.enroll(enrollBody(sponsor, strangerKey, { owner: OTHER, deviceId: DEV2 }), "198.51.100.1")).status, "enrolled");
    clock.t += 86_400; // next UTC day
    const third = key(11);
    assert.equal((await sponsor.enroll(bootBody(sponsor, third, { owner: getAddress("0x3333333333333333333333333333333333333333"), deviceId: `0x${"ef".repeat(32)}` }), "203.0.113.7")).status, "pending");
  });

  it("allows two cameras per owner, then answers full with a plain message", async () => {
    const { sponsor } = setup();
    await sponsor.enroll(bootBody(sponsor, camKey));
    await sponsor.enroll(bootBody(sponsor, strangerKey, { deviceId: DEV2 }));
    await assert.rejects(
      sponsor.enroll(bootBody(sponsor, key(11), { deviceId: `0x${"ef".repeat(32)}` })),
      (e: unknown) => e instanceof ApiError && e.word === "full" && /at most 2 cameras/.test(e.message),
    );
  });

  it("answers full when the pilot has its maximum number of cameras", async () => {
    const { sponsor } = setup({ maxCameras: 1 });
    await sponsor.enroll(bootBody(sponsor, camKey));
    await assert.rejects(
      sponsor.enroll(bootBody(sponsor, strangerKey, { owner: OTHER, deviceId: DEV2 })),
      (e: unknown) => e instanceof ApiError && e.word === "full" && /pilot is full/.test(e.message),
    );
  });

  it("checks the signature against devicePubkey", async () => {
    const { sponsor, payer } = setup();
    await rejects(sponsor.enroll(bootBody(sponsor, strangerKey, { pub: camKey.publicKeyHex })), "rejected");
    const { devicePubkey: _k, ...noKey } = enrollBody(sponsor, camKey);
    await rejects(sponsor.enroll(noKey), "bad_pubkey");
    await sponsor.idle();
    assert.equal(payer.sent.length, 0);
  });

  it("becomes active when the camera is registered with the enrolled key, then refills apply", async () => {
    const { sponsor, chain, payer, clock } = await booted();
    chain.balances.set(OWNER, 2n * QOR + 600_000n); // 3 QOR grant minus about 0.4 QOR setup
    chain.add(OWNER, DEV, camKey, 0n);
    await sponsor.runOnce();
    assert.equal(sponsor.status(DEV).status, "active");
    clock.t += 600;
    chain.anchor(OWNER, DEV, 1);
    await sponsor.runOnce();
    // The buffer builds at once: the start grant counts toward the camera day cap (9).
    assert.deepEqual(payer.sent.at(-1), { owner: OWNER, uqor: 6n * QOR });
    clock.t += 86_400; // next day: up to the 15 QOR target
    chain.balances.set(OWNER, 8n * QOR);
    chain.anchor(OWNER, DEV, 1);
    await sponsor.runOnce();
    assert.deepEqual(payer.sent.at(-1), { owner: OWNER, uqor: 7n * QOR });
  });

  it("rejects the camera when the key on chain differs from the enrolled key", async () => {
    const { sponsor, chain, payer, clock } = await booted();
    chain.add(OWNER, DEV, strangerKey, 0n);
    await sponsor.runOnce();
    assert.equal(sponsor.status(DEV).status, "rejected");
    clock.t += 7200;
    chain.anchor(OWNER, DEV, 12);
    await sponsor.runOnce();
    assert.equal(payer.sent.length, 1); // the start grant only
  });

  it("expires after 48 h without registration, with no second grant", async () => {
    const { sponsor, clock, payer } = await booted();
    clock.t += 47 * 3600;
    await sponsor.runOnce();
    assert.equal(sponsor.status(DEV).status, "funded");
    clock.t += 3600 + 1;
    await sponsor.runOnce();
    assert.equal(sponsor.status(DEV).status, "rejected");
    assert.equal(sponsor.status(DEV).state, "expired");
    assert.equal(sponsor.health().enrolled, 0);
    assert.equal((await sponsor.enroll(bootBody(sponsor, camKey))).status, "rejected");
    await sponsor.runOnce();
    assert.equal(payer.sent.length, 1);
  });

  it("holds the grant while paused (or the float is empty) and sends it after resume", async () => {
    const { sponsor, payer, cfg } = setup();
    writeFileSync(cfg.pauseFile, "manual\n");
    await rejects(sponsor.enroll(bootBody(sponsor, camKey)), "paused");
    rmSync(cfg.pauseFile);
    payer.float = 0n;
    assert.equal((await sponsor.enroll(bootBody(sponsor, camKey))).status, "pending");
    await sponsor.idle();
    assert.equal(payer.sent.length, 0);
    assert.equal(sponsor.status(DEV).status, "pending");
    writeFileSync(cfg.pauseFile, "manual\n");
    payer.float = 500n * QOR;
    assert.equal(sponsor.status(DEV).status, "paused");
    await sponsor.runOnce();
    assert.equal(payer.sent.length, 0);
    rmSync(cfg.pauseFile);
    await sponsor.runOnce();
    assert.equal(payer.sent.length, 1);
    assert.equal(sponsor.status(DEV).status, "funded");
  });

  it("retries an unknown grant once, only when the owner still holds nothing", async () => {
    const f = setup();
    f.payer.mode = "throw";
    await f.sponsor.enroll(bootBody(f.sponsor, camKey));
    await f.sponsor.idle();
    assert.equal(f.sponsor.status(DEV).startGrant?.status, "unknown");
    f.payer.mode = "ok";
    await f.sponsor.runOnce();
    assert.equal(f.payer.sent.length, 0); // too early
    f.clock.t += 601;
    f.chain.balances.set(OWNER, 3n * QOR); // the first send did land
    await f.sponsor.runOnce();
    assert.equal(f.payer.sent.length, 0);
    assert.equal(f.sponsor.status(DEV).status, "funded");

    const g = setup();
    g.payer.mode = "throw";
    await g.sponsor.enroll(bootBody(g.sponsor, camKey));
    await g.sponsor.idle();
    g.clock.t += 601;
    await g.sponsor.runOnce(); // balance 0: retry, unknown again
    g.payer.mode = "ok";
    g.clock.t += 601;
    await g.sponsor.runOnce(); // no third try
    assert.equal(g.payer.sent.length, 0);
  });

  it("on-chain path: refuses a devicePubkey that is not the key on chain", async () => {
    const { sponsor, chain } = setup();
    chain.add(OWNER, DEV, camKey);
    await rejects(sponsor.enroll(bootBody(sponsor, strangerKey, { pub: strangerKey.publicKeyHex })), "rejected");
    assert.equal((await sponsor.enroll(bootBody(sponsor, camKey))).status, "enrolled");
    assert.equal(sponsor.status(DEV).status, "active");
  });
});

// ---------------------------------------------------------------- end to end with the box client

describe("sponsor: end to end with the box client (src/web/sponsor.ts)", () => {
  it("bootstrap, funded, active, and the refusal words", async () => {
    const { sponsor, chain, payer, cfg } = setup();
    const server = createSponsorServer(sponsor, silentLogger, ["127.0.0.1"], new RateLimiter({ challenge: 100, enroll: 100, status: 100 }));
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const base = sponsorBaseUrl(`http://127.0.0.1:${(server.address() as { port: number }).port}/sponsor`);
    // nginx strips /sponsor; the service accepts both forms.
    const client = new SponsorClient(base);
    const req = { registry: REGISTRY_V4, deviceId: DEV.toUpperCase().replace("0X", "0x"), owner: OWNER, key: camKey };
    try {
      const a = await enrollDevice(client, { ...req, pilotCode: CODE });
      assert.equal(a.status, "pending");
      assert.equal(a.capPerDayUqor, (9n * QOR).toString());
      await sponsor.idle();
      assert.equal((await client.status(DEV)).status, "funded");
      assert.deepEqual(payer.sent, [{ owner: OWNER, uqor: 3n * QOR }]);
      assert.equal((await enrollDevice(client, { ...req, pilotCode: CODE })).status, "funded"); // retry

      chain.add(OWNER, DEV, camKey, 0n); // the box registers the camera
      await sponsor.runOnce();
      assert.equal((await client.status(DEV)).status, "active");
      assert.equal((await client.status(DEV2)).status, "unknown"); // 404

      writeFileSync(cfg.pauseFile, "manual\n");
      assert.equal((await enrollDevice(client, { ...req, deviceId: DEV2, key: strangerKey, pilotCode: CODE })).status, "paused");
      rmSync(cfg.pauseFile);
      const full = setup({ maxCameras: 0 });
      const s2 = createSponsorServer(full.sponsor, silentLogger, ["127.0.0.1"]);
      await new Promise<void>((ok) => s2.listen(0, "127.0.0.1", ok));
      try {
        const c2 = new SponsorClient(sponsorBaseUrl(`http://127.0.0.1:${(s2.address() as { port: number }).port}`));
        assert.equal((await enrollDevice(c2, { ...req, pilotCode: CODE })).status, "full");
      } finally {
        s2.close();
      }
      // One new camera per IP per day, seen through the HTTP layer.
      const ipl = setup({ maxEnrolPerIpDay: 1 });
      const s3 = createSponsorServer(ipl.sponsor, silentLogger, ["127.0.0.1"]);
      await new Promise<void>((ok) => s3.listen(0, "127.0.0.1", ok));
      try {
        const c3 = new SponsorClient(sponsorBaseUrl(`http://127.0.0.1:${(s3.address() as { port: number }).port}`));
        assert.equal((await enrollDevice(c3, { ...req, pilotCode: CODE })).status, "pending");
        assert.equal((await enrollDevice(c3, { ...req, deviceId: DEV2, key: strangerKey, pilotCode: CODE })).status, "full");
        await ipl.sponsor.idle();
      } finally {
        s3.close();
      }
      // A camera signed by another key than the one it sends is rejected.
      const bad = await client.enroll({
        pilotCode: CODE, deviceId: DEV2, owner: OWNER.toLowerCase(), nonce: (await client.challenge(DEV2)).nonce,
        signature: sign(strangerKey, "something else"), devicePubkey: strangerKey.publicKeyHex,
      });
      assert.equal(bad.status, "rejected");
    } finally {
      server.close();
    }
  });
});

describe("sponsor: security review 2", () => {
  it("frees the place of an active camera that stopped sealing, and refills it again when it seals", async () => {
    // Abandoned test boxes or idle fake cameras must not fill the pilot for ever.
    const { sponsor, chain, clock, payer, cfg } = await enrolled({ maxCameras: 1 });
    chain.add(OTHER, DEV2, strangerKey);
    await rejects(sponsor.enroll(enrollBody(sponsor, strangerKey, { owner: OTHER, deviceId: DEV2 })), "full");
    clock.t += cfg.pendingTtlSeconds + 3600; // no seal for more than 48 h
    await sponsor.runOnce();
    assert.equal(sponsor.health().enrolled, 0);
    assert.equal((await sponsor.enroll(enrollBody(sponsor, strangerKey, { owner: OTHER, deviceId: DEV2 }))).status, "enrolled");
    // The idle camera stays enrolled: when it seals again, refills apply.
    assert.equal(sponsor.status(DEV, OWNER).status, "active");
    clock.t += 3 * 3600;
    chain.anchor(OWNER, DEV, 18);
    await sponsor.runOnce();
    assert.ok(payer.sent.some((p) => p.owner === OWNER));
  });

  it("keeps the place of a camera that seals", async () => {
    const { sponsor, chain, clock, cfg } = await enrolled({ maxCameras: 1 });
    for (let t = 0; t < cfg.pendingTtlSeconds + 7200; t += 3600) {
      clock.t += 3600;
      chain.anchor(OWNER, DEV, 1);
      await sponsor.runOnce();
    }
    chain.add(OTHER, DEV2, strangerKey);
    await rejects(sponsor.enroll(enrollBody(sponsor, strangerKey, { owner: OTHER, deviceId: DEV2 })), "full");
  });

  it("admits at most maxCameras when enrolments arrive in parallel", async () => {
    const { sponsor, chain } = setup({ maxCameras: 1 });
    chain.add(OWNER, DEV, camKey);
    chain.add(OTHER, DEV2, strangerKey);
    const r = await Promise.allSettled([
      sponsor.enroll(enrollBody(sponsor, camKey)),
      sponsor.enroll(enrollBody(sponsor, strangerKey, { owner: OTHER, deviceId: DEV2 })),
    ]);
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(sponsor.health().enrolled, 1);
  });
});
