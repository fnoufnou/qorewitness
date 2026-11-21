/**
 * Sponsor service core: challenge, enrol, status and the top-up loop.
 * No network or file access of its own except the state, payout log, codes and
 * pause files. The chain and the hot wallet come in as ChainReader and Payer.
 */
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { assertPilotChain, type ChainReader, type Payer } from "./chain.js";
import { codeAllowed, loadCodeHashes } from "./codes.js";
import type { SponsorConfig } from "./config.js";
import { silentLogger, type Logger } from "./log.js";
import { ML_DSA_87_SIG_BYTES, verifySponsorSignature } from "./message.js";
import {
  appendPayoutLog, enrollmentKey, loadState, saveState, utcDay, type DayUsage, type Enrollment, type Payout, type SponsorState,
} from "./state.js";

export const NONCE_TTL_SECONDS = 300;
const MAX_NONCES = 2000;
export const PILOT_NOTE = "Free pilot. Test tokens without value. No payment is collected.";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export interface Clock {
  now(): number; // unix seconds
}
export const systemClock: Clock = { now: () => Math.floor(Date.now() / 1000) };

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

export class Sponsor {
  private state: SponsorState;
  private readonly nonces = new Map<string, { deviceId: string; expires: number }>();
  private running = false;

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

  async enroll(body: unknown): Promise<{ status: string; capPerDayUqor: string; note: string }> {
    if (this.paused()) throw new ApiError(503, "paused", "the pilot sponsor is paused");
    const b = (body ?? {}) as Record<string, unknown>;
    const { pilotCode, deviceId, owner, nonce, signature } = b;
    if (typeof pilotCode !== "string" || pilotCode.length < 4 || pilotCode.length > 64) throw new ApiError(400, "bad_code", "pilotCode missing");
    if (typeof deviceId !== "string" || !HEX32.test(deviceId)) throw new ApiError(400, "bad_device", "deviceId must be 0x + 64 hex");
    if (typeof owner !== "string" || !isAddress(owner, { strict: false })) throw new ApiError(400, "bad_owner", "owner must be a 0x address");
    if (typeof nonce !== "string" || !HEX32.test(nonce)) throw new ApiError(400, "bad_nonce", "nonce must be 0x + 64 hex");
    const sigHex = typeof signature === "string" ? (signature.startsWith("0x") ? signature : `0x${signature}`) : "";
    if (!/^0x[0-9a-fA-F]+$/.test(sigHex) || sigHex.length !== 2 + 2 * ML_DSA_87_SIG_BYTES) {
      throw new ApiError(400, "bad_signature", "signature must be a 4,627-byte ML-DSA-87 signature in hex");
    }
    this.consumeNonce(nonce, deviceId);

    const ownerAddr = getAddress(owner);
    const dev = deviceId.toLowerCase() as Hex;
    const codeHash = codeAllowed(pilotCode, loadCodeHashes(this.cfg.codesFile));
    if (!codeHash) throw new ApiError(403, "bad_code", "unknown pilot code");
    const boundTo = this.state.codes[codeHash];
    if (boundTo && boundTo !== ownerAddr) throw new ApiError(403, "code_used", "this pilot code belongs to another owner");

    // The device must be active for this owner on chain. Devices are stored per owner,
    // so an active entry under `owner` means `owner` is the on-chain owner.
    const d = await this.chain.getDevice(ownerAddr, dev);
    if (d.status !== "active") throw new ApiError(403, "not_owner", "no active device with this id for this owner on the registry");
    const pub = await this.chain.devicePubkey(ownerAddr, dev, d.keyHash);
    if (!pub) throw new ApiError(409, "key_not_found", "device key not found on chain yet: let the camera anchor once, then retry");
    const ok = verifySponsorSignature({
      registry: this.cfg.registry, deviceId: dev, owner: ownerAddr, nonce: nonce as Hex, signature: sigHex as Hex,
      devicePubkey: pub, onChainKeyHash: d.keyHash,
    });
    if (!ok) throw new ApiError(401, "bad_signature", "the camera signature does not verify");

    const key = enrollmentKey(ownerAddr, dev);
    const capPerDayUqor = this.cfg.capCameraDayUqor.toString();
    if (this.state.enrollments[key]) return { status: "enrolled", capPerDayUqor, note: PILOT_NOTE };

    const all = Object.values(this.state.enrollments);
    if (all.length >= this.cfg.maxCameras) throw new ApiError(409, "pilot_full", "the pilot is full");
    if (all.filter((e) => e.owner === ownerAddr).length >= this.cfg.maxCamerasPerOwner) {
      throw new ApiError(409, "owner_full", "this owner has the maximum number of pilot cameras");
    }
    const count = await this.chain.anchorCount(ownerAddr, dev);
    const now = this.clock.now();
    this.state.codes[codeHash] = ownerAddr;
    this.state.enrollments[key] = {
      owner: ownerAddr, deviceId: dev, codeHash, enrolledAt: now, paidAnchorCount: count.toString(), paidAt: now,
    };
    this.save();
    this.log.info("enrolled", { owner: ownerAddr, device: dev, enrolled: all.length + 1 });
    return { status: "enrolled", capPerDayUqor, note: PILOT_NOTE };
  }

  // ------------------------------------------------------------ status

  status(deviceId: string, owner?: string) {
    if (!HEX32.test(deviceId)) throw new ApiError(400, "bad_device", "deviceId must be 0x + 64 hex");
    let list = Object.values(this.state.enrollments).filter((e) => e.deviceId === deviceId.toLowerCase());
    if (owner) {
      if (!isAddress(owner, { strict: false })) throw new ApiError(400, "bad_owner", "owner must be a 0x address");
      list = list.filter((e) => e.owner === getAddress(owner));
    }
    if (list.length > 1) throw new ApiError(409, "ambiguous", "several owners use this device id: add ?owner=0x...");
    const e = list[0];
    const day = this.state.days[utcDay(this.clock.now())];
    return {
      deviceId: deviceId.toLowerCase(),
      enrolled: Boolean(e),
      owner: e?.owner ?? null,
      lastTopUp: e?.lastTopUp ?? null,
      usedTodayUqor: e ? (day?.devices[enrollmentKey(e.owner, e.deviceId)] ?? "0") : "0",
      capPerDayUqor: this.cfg.capCameraDayUqor.toString(),
      paused: this.paused(),
      note: PILOT_NOTE,
    };
  }

  health() {
    return {
      ok: true, paused: this.paused(), enrolled: Object.keys(this.state.enrollments).length, maxCameras: this.cfg.maxCameras,
      chainId: 9800, note: PILOT_NOTE,
    };
  }

  // ------------------------------------------------------------ top-up loop

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

  private autoPause(reason: string): void {
    try {
      writeFileSync(this.cfg.pauseFile, `${new Date().toISOString()} automatic pause: ${reason}\n`, { mode: 0o600, flag: "wx" });
    } catch {
      // Already paused.
    }
    this.log.alert("auto_pause", { reason });
  }

  /**
   * One pass over all enrolled devices. Per owner: skip while paused, while the
   * balance is at or above the threshold, or within the minimum payout interval.
   * Credit = anchors seen on chain since the last payout x perAnchorUqor, for devices
   * that anchored recently. The payout is the smallest of: the credit, the camera,
   * owner and global day caps left, target minus balance, and the float minus the reserve.
   */
  async runOnce(): Promise<{ paid: number; totalUqor: bigint; skipped: string[] }> {
    const result = { paid: 0, totalUqor: 0n, skipped: [] as string[] };
    if (this.running) return { ...result, skipped: ["busy"] };
    this.running = true;
    try {
      if (this.paused()) {
        this.log.warn("paused", {});
        return { ...result, skipped: ["paused"] };
      }
      await assertPilotChain(this.chain);
      const now = this.clock.now();
      this.prune(now);
      const day = this.dayUsage(utcDay(now));

      const owners = new Map<string, Enrollment[]>();
      for (const e of Object.values(this.state.enrollments)) owners.set(e.owner, [...(owners.get(e.owner) ?? []), e]);

      let float = await this.payer.floatUqor();
      if (float > this.cfg.maxFloatUqor) this.log.warn("float_high", { floatUqor: float.toString(), maxUqor: this.cfg.maxFloatUqor.toString() });
      if (float < this.cfg.capGlobalDayUqor) this.log.alert("float_low", { floatUqor: float.toString() });

      for (const [owner, devices] of owners) {
        if (this.paused()) { result.skipped.push("paused"); break; }
        const skip = (why: string) => { result.skipped.push(`${owner}:${why}`); };
        const lastPaid = Math.max(0, ...devices.map((e) => e.lastTopUp?.at ?? 0));
        if (now - lastPaid < this.cfg.minPayoutIntervalSeconds) { skip("interval"); continue; }

        const balance = await this.chain.balanceUqor(owner as Address);
        if (balance >= this.cfg.thresholdUqor) { skip("balance_ok"); continue; }

        const parts: { e: Enrollment; key: string; count: bigint; allow: bigint }[] = [];
        for (const e of devices) {
          const key = enrollmentKey(e.owner, e.deviceId);
          const d = await this.chain.getDevice(owner as Address, e.deviceId as Hex);
          if (d.status !== "active") { skip(`${e.deviceId}:inactive`); continue; }
          const end = await this.chain.lastWindowEnd(owner as Address, e.deviceId as Hex);
          if (end < now - this.cfg.activeWithinSeconds) { skip(`${e.deviceId}:no_recent_anchor`); continue; }
          const count = await this.chain.anchorCount(owner as Address, e.deviceId as Hex);
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
          at: now, owner, amountUqor: amount.toString(), status: "pending",
          devices: split.map((s) => ({ deviceId: s.e.deviceId, amountUqor: s.amount.toString() })),
        };
        const apply = (sign: 1n | -1n) => {
          day.globalUqor = (BigInt(day.globalUqor) + sign * amount).toString();
          day.owners[owner] = (BigInt(day.owners[owner] ?? "0") + sign * amount).toString();
          for (const s of split) day.devices[s.key] = (BigInt(day.devices[s.key] ?? "0") + sign * s.amount).toString();
        };
        const before = split.map((s) => ({ key: s.key, paidAnchorCount: s.e.paidAnchorCount, paidAt: s.e.paidAt }));
        apply(1n);
        for (const s of split) {
          s.e.paidAnchorCount = s.count.toString();
          s.e.paidAt = now;
        }
        this.state.recent.push(payout);
        this.save();
        appendPayoutLog(this.cfg.payoutLog, payout);

        try {
          const r = await this.payer.pay(owner as Address, amount);
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
            apply(-1n);
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
    } finally {
      this.running = false;
    }
  }

  /** Read-only view for tests and the daily summary. */
  snapshot(): SponsorState {
    return structuredClone(this.state);
  }
}
