/**
 * Sponsor service core: challenge, enrol, status, start grants and the top-up loop.
 * No network or file access of its own except the state, payout log and pause
 * files. The chain and the hot wallet come in as ChainReader and Payer.
 *
 * Two enrol paths:
 * - on chain: the camera is registered already. Its key comes from the registry.
 *   The enrolment is active at once and refills apply.
 * - bootstrap: the camera is not on chain yet (a new owner has no test QOR). The
 *   signature is checked against the devicePubkey that the box sends. The service
 *   binds owner, device id and key hash, and sends one start grant. When the
 *   camera shows up on chain with that key hash under that owner, it becomes active.
 *
 * No pilot code is needed. Admission: the camera signature, max cameras in the
 * pilot, max cameras per owner, one new enrolment per IP per day, and a daily
 * number of start grants. A pilotCode field is accepted and ignored.
 */
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { getAddress, isAddress, keccak256, type Address, type Hex } from "viem";
import { assertPilotChain, type ChainReader, type Payer } from "./chain.js";
import type { SponsorConfig } from "./config.js";
import { silentLogger, type Logger } from "./log.js";
import { ML_DSA_87_PUBKEY_BYTES, ML_DSA_87_SIG_BYTES, verifySponsorSignature } from "./message.js";
import {
  appendPayoutLog, enrollmentKey, loadState, saveState, utcDay, type DayUsage, type Enrollment, type Payout, type SponsorState,
} from "./state.js";

export const NONCE_TTL_SECONDS = 300;
const MAX_NONCES = 2000;
const MAX_GRANT_ATTEMPTS = 3;
export const PILOT_NOTE = "Free pilot. Test tokens without value. No payment is collected.";

/** The words the setup wizard reads (src/web/sponsor.ts). */
export type StatusWord = "enrolled" | "pending" | "funded" | "active" | "full" | "invalid_code" | "used_code" | "paused" | "rejected";

const HTTP_FOR: Partial<Record<StatusWord, number>> = { invalid_code: 403, used_code: 403, rejected: 403, full: 409, paused: 423 };

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly word?: StatusWord) {
    super(message);
  }
}

const refuse = (word: StatusWord, message: string) => new ApiError(HTTP_FOR[word] ?? 400, word, message, word);

export interface Clock {
  now(): number; // unix seconds
}
export const systemClock: Clock = { now: () => Math.floor(Date.now() / 1000) };

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const LIVE = new Set(["pending", "funded", "active"]);
const lowerHex = (h: string) => h.toLowerCase() as Hex;

export interface EnrollAnswer {
  status: StatusWord;
  capPerDayUqor: string;
  note: string;
  message?: string;
}

export class Sponsor {
  private state: SponsorState;
  private readonly nonces = new Map<string, { deviceId: string; expires: number }>();
  /** New enrolments per IP for the current UTC day. Memory only, never written to disk. */
  private ipDay = "";
  private readonly ipCount = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly cfg: SponsorConfig,
    private readonly chain: ChainReader,
    private readonly payer: Payer,
    private readonly clock: Clock = systemClock,
    private readonly log: Logger = silentLogger,
  ) {
    this.state = loadState(cfg.stateFile);
  }

  /** Refuses to start unless the chain is the qorechain-diana testnet (9800). */
  async start(): Promise<void> {
    await assertPilotChain(this.chain);
  }

  paused(): boolean {
    return existsSync(this.cfg.pauseFile);
  }

  private save(): void {
    saveState(this.cfg.stateFile, this.state);
  }

  /** Runs chain-paying work one at a time (one hot wallet, one account sequence). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Waits until queued work (for example a start grant after enrol) is done. */
  async idle(): Promise<void> {
    let q;
    do {
      q = this.queue;
      await q;
    } while (q !== this.queue);
  }

  // ------------------------------------------------------------ challenge

  challenge(body: unknown): { nonce: Hex; expires: number; expiresAt: string } {
    const deviceId = (body as { deviceId?: unknown } | null)?.deviceId;
    if (typeof deviceId !== "string" || !HEX32.test(deviceId)) throw new ApiError(400, "bad_device", "deviceId must be 0x + 64 hex");
    const now = this.clock.now();
    this.pruneNonces(now);
    if (this.nonces.size >= MAX_NONCES) throw new ApiError(503, "busy", "too many open challenges, try again later");
    const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
    const expires = now + NONCE_TTL_SECONDS;
    this.nonces.set(nonce, { deviceId: deviceId.toLowerCase(), expires });
    return { nonce, expires, expiresAt: new Date(expires * 1000).toISOString() };
  }

  private pruneNonces(now: number): void {
    for (const [n, v] of this.nonces) if (v.expires <= now) this.nonces.delete(n);
  }

  /** Single use: the nonce is deleted on the first attempt, valid or not. */
  private consumeNonce(nonce: string, deviceId: string): void {
    const n = this.nonces.get(nonce.toLowerCase());
    this.nonces.delete(nonce.toLowerCase());
    if (!n || n.expires <= this.clock.now() || n.deviceId !== deviceId.toLowerCase()) {
      throw new ApiError(400, "bad_nonce", "unknown, used or expired nonce: ask for a new challenge");
    }
  }

  // ------------------------------------------------------------ enrol

  private answer(status: StatusWord, message?: string): EnrollAnswer {
    return { status, capPerDayUqor: this.cfg.capCameraDayUqor.toString(), note: PILOT_NOTE, ...(message ? { message } : {}) };
  }

  private liveCount(owner?: string): number {
    return Object.values(this.state.enrollments).filter((e) => LIVE.has(e.state) && (!owner || e.owner === owner)).length;
  }

  private ipUsed(ip: string): number {
    const day = utcDay(this.clock.now());
    if (day !== this.ipDay) {
      this.ipDay = day;
      this.ipCount.clear();
    }
    return this.ipCount.get(ip) ?? 0;
  }

  /** Admission for a new camera. Throws "full" with a plain message. */
  private admit(owner: string, ip: string): void {
    if (this.liveCount() >= this.cfg.maxCameras) throw refuse("full", "The pilot is full at the moment. Try again later, or choose Self-managed.");
    if (this.liveCount(owner) >= this.cfg.maxCamerasPerOwner) {
      throw refuse("full", `The pilot covers at most ${this.cfg.maxCamerasPerOwner} cameras per account.`);
    }
    if (this.ipUsed(ip) >= this.cfg.maxEnrolPerIpDay) throw refuse("full", "One new camera per internet connection per day. Try again tomorrow.");
  }

  async enroll(body: unknown, ip = "unknown"): Promise<EnrollAnswer> {
    if (this.paused()) throw refuse("paused", "The pilot is paused at the moment. Try again later.");
    const b = (body ?? {}) as Record<string, unknown>;
    const { deviceId, owner, nonce, signature, devicePubkey } = b;
    if (typeof deviceId !== "string" || !HEX32.test(deviceId)) throw new ApiError(400, "bad_device", "deviceId must be 0x + 64 hex");
    if (typeof owner !== "string" || !isAddress(owner, { strict: false })) throw new ApiError(400, "bad_owner", "owner must be a 0x address");
    if (typeof nonce !== "string" || !HEX32.test(nonce)) throw new ApiError(400, "bad_nonce", "nonce must be 0x + 64 hex");
    const sigHex = typeof signature === "string" ? (signature.startsWith("0x") ? signature : `0x${signature}`) : "";
    if (!/^0x[0-9a-fA-F]+$/.test(sigHex) || sigHex.length !== 2 + 2 * ML_DSA_87_SIG_BYTES) {
      throw new ApiError(400, "bad_signature", "signature must be a 4,627-byte ML-DSA-87 signature in 0x hex");
    }
    let pubHex: Hex | undefined;
    if (devicePubkey !== undefined) {
      const p = typeof devicePubkey === "string" ? (devicePubkey.startsWith("0x") ? devicePubkey : `0x${devicePubkey}`) : "";
      if (!/^0x[0-9a-fA-F]+$/.test(p) || p.length !== 2 + 2 * ML_DSA_87_PUBKEY_BYTES) {
        throw new ApiError(400, "bad_pubkey", "devicePubkey must be a 2,592-byte ML-DSA-87 public key in 0x hex");
      }
      pubHex = lowerHex(p);
    }
    this.consumeNonce(nonce, deviceId);

    const own = owner.toLowerCase();
    const dev = lowerHex(deviceId);
    const key = enrollmentKey(own, dev);
    const existing = this.state.enrollments[key];
    const verify = (pub: Hex, keyHash: Hex) => verifySponsorSignature({
      registry: this.cfg.registry, deviceId: dev, owner: getAddress(own), nonce: nonce as Hex, signature: sigHex as Hex,
      devicePubkey: pub, onChainKeyHash: keyHash,
    });

    const d = await this.chain.getDevice(getAddress(own), dev);
    if (d.status === "revoked") throw refuse("rejected", "this camera is revoked on the registry");

    if (d.status === "active") {
      // On-chain path. Devices are stored per owner, so an active entry under `owner`
      // proves that `owner` is the on-chain owner.
      const keyHash = lowerHex(d.keyHash);
      let pub: Hex | undefined;
      if (pubHex) {
        if (keccak256(pubHex) !== keyHash) throw refuse("rejected", "devicePubkey is not the camera key on chain");
        pub = pubHex;
      } else {
        pub = await this.chain.devicePubkey(getAddress(own), dev, keyHash);
        if (!pub) throw new ApiError(409, "key_not_found", "device key not found on chain: send devicePubkey");
      }
      if (!verify(pub, keyHash)) throw refuse("rejected", "the camera signature does not verify");
      if (existing) return this.answer(this.wordOf(existing));
      this.admit(own, ip);
      const now = this.clock.now();
      const count = await this.chain.anchorCount(getAddress(own), dev);
      this.ipCount.set(ip, this.ipUsed(ip) + 1);
      this.state.enrollments[key] = {
        owner: own, deviceId: dev, keyHash, path: "onchain", state: "active", enrolledAt: now, activatedAt: now,
        paidAnchorCount: count.toString(), paidAt: now,
      };
      this.save();
      this.log.info("enrolled", { owner: own, device: dev, path: "onchain", live: this.liveCount() });
      return this.answer("enrolled");
    }

    // Bootstrap path: the camera is not on chain yet.
    if (!pubHex) throw refuse("rejected", "the camera is not on chain yet: send devicePubkey");
    const keyHash = keccak256(pubHex);
    if (!verify(pubHex, keyHash)) throw refuse("rejected", "the camera signature does not verify");
    if (existing) {
      // A retry of the same enrolment (same key) gets its current state, never a second grant.
      // An expired or rejected camera stays so: one start grant per camera.
      if (existing.keyHash === keyHash) return this.answer(this.wordOf(existing));
      throw refuse("rejected", "this camera is enrolled with another key");
    }
    this.admit(own, ip);
    const now = this.clock.now();
    const day = this.dayUsage(utcDay(now));
    if ((day.grants ?? 0) >= this.cfg.maxGrantsPerDay || this.cfg.capGlobalDayUqor - BigInt(day.globalUqor) < this.cfg.grantUqor) {
      throw refuse("full", "The pilot has started enough new cameras today. Try again tomorrow.");
    }
    day.grants = (day.grants ?? 0) + 1;
    this.ipCount.set(ip, this.ipUsed(ip) + 1);
    this.state.enrollments[key] = {
      owner: own, deviceId: dev, keyHash, path: "bootstrap", state: "pending", enrolledAt: now,
      grant: { status: "pending", amountUqor: this.cfg.grantUqor.toString(), at: now, attempts: 0 },
      paidAnchorCount: "0", paidAt: now,
    };
    this.save();
    this.log.info("enrolled", { owner: own, device: dev, path: "bootstrap", live: this.liveCount() });
    // The grant goes out in the background: a send can take longer than the client waits.
    void this.exclusive(() => this.sendGrants()).catch((e: unknown) => {
      this.log.alert("grant_failed", { error: e instanceof Error ? e.message.split("\n")[0] : "error" });
    });
    return this.answer("pending");
  }

  private wordOf(e: Enrollment): StatusWord {
    if (e.state === "rejected" || e.state === "expired") return "rejected";
    if (e.state === "pending" && this.paused()) return "paused";
    return e.state;
  }

  // ------------------------------------------------------------ status

  status(deviceId: string, owner?: string) {
    if (!HEX32.test(deviceId)) throw new ApiError(400, "bad_device", "deviceId must be 0x + 64 hex");
    let list = Object.values(this.state.enrollments).filter((e) => e.deviceId === deviceId.toLowerCase());
    if (owner) {
      if (!isAddress(owner, { strict: false })) throw new ApiError(400, "bad_owner", "owner must be a 0x address");
      list = list.filter((e) => e.owner === owner.toLowerCase());
    }
    if (list.length > 1) list = list.filter((e) => LIVE.has(e.state));
    if (list.length > 1) throw new ApiError(409, "ambiguous", "several owners use this device id: add ?owner=0x...");
    const e = list[0];
    if (!e) throw new ApiError(404, "not_enrolled", "this camera is not enrolled");
    const day = this.state.days[utcDay(this.clock.now())];
    return {
      status: this.wordOf(e),
      deviceId: e.deviceId,
      owner: e.owner,
      state: e.state,
      enrolled: true,
      enrolledAt: new Date(e.enrolledAt * 1000).toISOString(),
      startGrant: e.grant ? { status: e.grant.status, amountUqor: e.grant.amountUqor, txHash: e.grant.txHash ?? null } : null,
      lastTopUp: e.lastTopUp ?? null,
      usedTodayUqor: day?.devices[enrollmentKey(e.owner, e.deviceId)] ?? "0",
      capPerDayUqor: this.cfg.capCameraDayUqor.toString(),
      paused: this.paused(),
      note: PILOT_NOTE,
    };
  }

  health() {
    return { ok: true, paused: this.paused(), enrolled: this.liveCount(), maxCameras: this.cfg.maxCameras, chainId: 9800, note: PILOT_NOTE };
  }

  // ------------------------------------------------------------ shared accounting

  private dayUsage(day: string): DayUsage {
    this.state.days[day] ??= { globalUqor: "0", owners: {}, devices: {} };
    return this.state.days[day];
  }

  private prune(now: number): void {
    const keep = new Set([utcDay(now), utcDay(now - 86_400)]);
    for (const d of Object.keys(this.state.days)) if (!keep.has(d)) delete this.state.days[d];
    this.state.recent = this.state.recent.filter((p) => p.at > now - 2 * 86_400);
  }

  private hourlyOutflow(now: number): bigint {
    return this.state.recent
      .filter((p) => p.at > now - 3600 && p.status !== "refused")
      .reduce((s, p) => s + BigInt(p.amountUqor), 0n);
  }

  private addUsage(day: DayUsage, owner: string, parts: { key: string; amount: bigint }[], sign: 1n | -1n): void {
    const total = parts.reduce((s, p) => s + p.amount, 0n);
    day.globalUqor = (BigInt(day.globalUqor) + sign * total).toString();
    day.owners[owner] = (BigInt(day.owners[owner] ?? "0") + sign * total).toString();
    for (const p of parts) day.devices[p.key] = (BigInt(day.devices[p.key] ?? "0") + sign * p.amount).toString();
  }

  private autoPause(reason: string): void {
    try {
      writeFileSync(this.cfg.pauseFile, `${new Date().toISOString()} automatic pause: ${reason}\n`, { mode: 0o600, flag: "wx" });
    } catch {
      // Already paused.
    }
    this.log.alert("auto_pause", { reason });
  }

  // ------------------------------------------------------------ start grants

  /**
   * Sends the start grant of each pending bootstrap enrolment, once.
   * The grant is recorded as "unknown" before the send. A refused send is retried
   * (at most 3 attempts). An unknown result is retried once, and only when the
   * owner still holds 0 test QOR after SPONSOR_GRANT_RETRY_SECONDS.
   */
  private async sendGrants(): Promise<number> {
    if (this.paused()) return 0;
    let sent = 0;
    const now = this.clock.now();
    for (const e of Object.values(this.state.enrollments)) {
      const g = e.grant;
      if (e.path !== "bootstrap" || e.state !== "pending" || !g) continue;
      if (this.paused()) break;
      if (g.status === "unknown") {
        if (now - g.at < this.cfg.grantRetrySeconds || g.attempts >= 2) continue;
        if ((await this.chain.balanceUqor(getAddress(e.owner))) > 0n) {
          g.status = "sent";
          e.state = "funded";
          this.save();
          continue;
        }
        g.status = "pending";
      }
      if (g.status !== "pending") continue;
      const amount = BigInt(g.amountUqor);
      const day = this.dayUsage(utcDay(now));
      if (this.cfg.capGlobalDayUqor - BigInt(day.globalUqor) < amount) { this.log.warn("grant_waits_budget", { owner: e.owner }); continue; }
      const float = await this.payer.floatUqor();
      if (float - this.cfg.reserveUqor < amount) { this.log.alert("float_empty", { floatUqor: float.toString() }); break; }
      if (this.hourlyOutflow(now) + amount > this.cfg.maxHourlyUqor) { this.autoPause("hourly outflow limit reached"); break; }

      const key = enrollmentKey(e.owner, e.deviceId);
      const parts = [{ key, amount }];
      const payout: Payout = {
        at: now, kind: "grant", owner: e.owner, amountUqor: amount.toString(), status: "pending",
        devices: [{ deviceId: e.deviceId, amountUqor: amount.toString() }],
      };
      g.status = "unknown";
      g.at = now;
      g.attempts += 1;
      this.addUsage(day, e.owner, parts, 1n);
      this.state.recent.push(payout);
      this.save();
      appendPayoutLog(this.cfg.payoutLog, payout);
      try {
        const r = await this.payer.pay(getAddress(e.owner), amount);
        payout.txHash = r.txHash;
        if (r.ok) {
          payout.status = "sent";
          g.status = "sent";
          g.txHash = r.txHash;
          e.state = "funded";
          e.lastTopUp = { at: now, amountUqor: amount.toString(), txHash: r.txHash };
          sent += 1;
          this.log.info("start_grant", { owner: e.owner, amountUqor: amount.toString(), tx: r.txHash });
        } else {
          payout.status = "refused";
          g.status = g.attempts >= MAX_GRANT_ATTEMPTS ? "refused" : "pending";
          this.addUsage(day, e.owner, parts, -1n);
          this.log.warn("start_grant_refused", { owner: e.owner, code: r.code, attempts: g.attempts });
        }
      } catch (err) {
        payout.status = "unknown";
        this.log.alert("start_grant_unknown", { owner: e.owner, error: err instanceof Error ? err.message.split("\n")[0] : String(err) });
      }
      this.save();
      appendPayoutLog(this.cfg.payoutLog, payout);
    }
    return sent;
  }

  // ------------------------------------------------------------ registration check

  /**
   * Pending and funded cameras: when the registry shows the device under the
   * enrolled owner, its key hash must equal the enrolled key hash. Then the camera
   * is active and refills start from its anchor count at that time. Otherwise it is
   * rejected. Not registered after SPONSOR_PENDING_TTL_SECONDS: expired.
   */
  private async checkRegistrations(): Promise<void> {
    const now = this.clock.now();
    let changed = false;
    for (const e of Object.values(this.state.enrollments)) {
      if (e.state !== "pending" && e.state !== "funded") continue;
      const d = await this.chain.getDevice(getAddress(e.owner), e.deviceId as Hex);
      if (d.status === "active") {
        if (d.keyHash.toLowerCase() === e.keyHash) {
          e.state = "active";
          e.activatedAt = now;
          e.paidAnchorCount = (await this.chain.anchorCount(getAddress(e.owner), e.deviceId as Hex)).toString();
          e.paidAt = now;
          this.log.info("activated", { owner: e.owner, device: e.deviceId });
        } else {
          e.state = "rejected";
          e.reason = "the key on chain differs from the enrolled key";
          this.log.alert("rejected", { owner: e.owner, device: e.deviceId, reason: "key_mismatch" });
        }
        changed = true;
      } else if (d.status === "revoked") {
        e.state = "rejected";
        e.reason = "revoked on chain";
        changed = true;
      } else if (now - e.enrolledAt > this.cfg.pendingTtlSeconds) {
        e.state = "expired";
        e.reason = "not registered on chain in time";
        this.log.warn("expired", { owner: e.owner, device: e.deviceId });
        changed = true;
      }
    }
    if (changed) this.save();
  }

  // ------------------------------------------------------------ top-up loop

  /**
   * One pass: registration check, start grants, then refills of active cameras.
   * Refills per owner: skip while paused, while the balance is at or above the
   * threshold, or within the minimum payout interval. Credit = anchors seen on
   * chain since the last payout x perAnchorUqor, for devices that anchored recently.
   * The payout is the smallest of: the credit, the camera, owner and global day
   * caps left, target minus balance, and the float minus the reserve.
   */
  runOnce(): Promise<{ paid: number; grants: number; totalUqor: bigint; skipped: string[] }> {
    return this.exclusive(() => this.pass());
  }

  private async pass(): Promise<{ paid: number; grants: number; totalUqor: bigint; skipped: string[] }> {
    const result = { paid: 0, grants: 0, totalUqor: 0n, skipped: [] as string[] };
    if (this.paused()) {
      this.log.warn("paused", {});
      return { ...result, skipped: ["paused"] };
    }
    await assertPilotChain(this.chain);
    const now = this.clock.now();
    this.prune(now);
    await this.checkRegistrations();
    result.grants = await this.sendGrants();
    const day = this.dayUsage(utcDay(now));

    const owners = new Map<string, Enrollment[]>();
    for (const e of Object.values(this.state.enrollments)) {
      if (e.state === "active") owners.set(e.owner, [...(owners.get(e.owner) ?? []), e]);
    }

    let float = await this.payer.floatUqor();
    if (float > this.cfg.maxFloatUqor) this.log.warn("float_high", { floatUqor: float.toString(), maxUqor: this.cfg.maxFloatUqor.toString() });
    if (float < this.cfg.capGlobalDayUqor) this.log.alert("float_low", { floatUqor: float.toString() });

    for (const [owner, devices] of owners) {
      if (this.paused()) { result.skipped.push("paused"); break; }
      const skip = (why: string) => { result.skipped.push(`${owner}:${why}`); };
      const lastPaid = Math.max(0, ...devices.map((e) => e.lastTopUp?.at ?? 0));
      if (now - lastPaid < this.cfg.minPayoutIntervalSeconds) { skip("interval"); continue; }

      const balance = await this.chain.balanceUqor(getAddress(owner));
      if (balance >= this.cfg.thresholdUqor) { skip("balance_ok"); continue; }

      const parts: { e: Enrollment; key: string; count: bigint; allow: bigint }[] = [];
      for (const e of devices) {
        const key = enrollmentKey(e.owner, e.deviceId);
        const d = await this.chain.getDevice(getAddress(owner), e.deviceId as Hex);
        if (d.status === "revoked") {
          e.state = "rejected";
          e.reason = "revoked on chain";
          this.save();
          skip(`${e.deviceId}:revoked`);
          continue;
        }
        if (d.status !== "active") { skip(`${e.deviceId}:inactive`); continue; }
        const end = await this.chain.lastWindowEnd(getAddress(owner), e.deviceId as Hex);
        if (end < now - this.cfg.activeWithinSeconds) { skip(`${e.deviceId}:no_recent_anchor`); continue; }
        const count = await this.chain.anchorCount(getAddress(owner), e.deviceId as Hex);
        let anchors = count - BigInt(e.paidAnchorCount);
        // At most one anchor per minWindowSeconds since the baseline (plus one): blocks 1-second windows.
        const maxAnchors = BigInt(Math.floor(Math.max(0, now - e.paidAt) / this.cfg.minWindowSeconds) + 1);
        if (anchors > maxAnchors) anchors = maxAnchors;
        if (anchors <= 0n) continue;
        const used = BigInt(day.devices[key] ?? "0");
        const capLeft = this.cfg.capCameraDayUqor - used;
        const credit = anchors * this.cfg.perAnchorUqor;
        const allow = credit < capLeft ? credit : capLeft;
        if (allow > 0n) parts.push({ e, key, count, allow });
        else skip(`${e.deviceId}:camera_cap`);
      }
      if (!parts.length) { skip("no_credit"); continue; }

      let amount = parts.reduce((s, p) => s + p.allow, 0n);
      const limits: [string, bigint][] = [
        ["target", this.cfg.targetUqor - balance],
        ["owner_cap", this.cfg.capOwnerDayUqor - BigInt(day.owners[owner] ?? "0")],
        ["global_cap", this.cfg.capGlobalDayUqor - BigInt(day.globalUqor)],
        ["float", float - this.cfg.reserveUqor],
        ["hourly", this.cfg.maxHourlyUqor - this.hourlyOutflow(now)],
      ];
      let limitedBy = "credit";
      for (const [name, v] of limits) if (v < amount) { amount = v; limitedBy = name; }
      if (amount <= 0n || amount < this.cfg.minPayoutUqor) {
        skip(`below_min:${limitedBy}`);
        if (limitedBy === "hourly") this.autoPause("hourly outflow limit reached");
        if (limitedBy === "float") this.log.alert("float_empty", { floatUqor: float.toString() });
        continue;
      }

      // Split the amount over the devices (in order) for the per-camera accounting.
      let rest = amount;
      const split = parts.map((p) => {
        const a = rest < p.allow ? rest : p.allow;
        rest -= a;
        return { ...p, amount: a };
      });

      // Record first (pending), so a crash after the send can never pay twice.
      const payout: Payout = {
        at: now, kind: "refill", owner, amountUqor: amount.toString(), status: "pending",
        devices: split.map((s) => ({ deviceId: s.e.deviceId, amountUqor: s.amount.toString() })),
      };
      const before = split.map((s) => ({ key: s.key, paidAnchorCount: s.e.paidAnchorCount, paidAt: s.e.paidAt }));
      this.addUsage(day, owner, split, 1n);
      for (const s of split) {
        s.e.paidAnchorCount = s.count.toString();
        s.e.paidAt = now;
      }
      this.state.recent.push(payout);
      this.save();
      appendPayoutLog(this.cfg.payoutLog, payout);

      try {
        const r = await this.payer.pay(getAddress(owner), amount);
        payout.txHash = r.txHash;
        if (r.ok) {
          payout.status = "sent";
          for (const s of split) s.e.lastTopUp = { at: now, amountUqor: s.amount.toString(), txHash: r.txHash };
          float -= amount;
          result.paid += 1;
          result.totalUqor += amount;
          this.log.info("top_up", { owner, amountUqor: amount.toString(), tx: r.txHash, limitedBy });
        } else {
          // Refused by the chain: nothing moved. Undo the accounting.
          payout.status = "refused";
          this.addUsage(day, owner, split, -1n);
          for (const b of before) {
            const e = this.state.enrollments[b.key];
            e.paidAnchorCount = b.paidAnchorCount;
            e.paidAt = b.paidAt;
          }
          this.log.warn("top_up_refused", { owner, code: r.code, tx: r.txHash });
        }
      } catch (err) {
        // Unknown result: keep it counted, so it is never paid twice.
        payout.status = "unknown";
        this.log.alert("top_up_unknown", { owner, error: err instanceof Error ? err.message.split("\n")[0] : String(err) });
      }
      this.save();
      appendPayoutLog(this.cfg.payoutLog, payout);
      if (this.hourlyOutflow(now) > this.cfg.maxHourlyUqor) this.autoPause("hourly outflow above the limit");
    }
    return result;
  }

  /** Read-only view for tests and the daily summary. */
  snapshot(): SponsorState {
    return structuredClone(this.state);
  }
}
