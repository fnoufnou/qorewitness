/**
 * Sponsor service configuration. Testnet only: the EVM chain id is fixed to 9800
 * and there is no setting for any other network.
 *
 * Non-secret settings come from the environment (systemd EnvironmentFile).
 * The hot wallet recovery phrase comes from its own file (mode 600), read once at
 * start and never put into the environment, a log line or an HTTP answer.
 */
import { readFileSync, statSync } from "node:fs";
import { getAddress, type Address } from "viem";

export const PILOT_CHAIN_ID = 9800;
export const PILOT_COSMOS_CHAIN_ID = "qorechain-diana";
/** AnchorRegistry v4 on qorechain-diana. */
export const REGISTRY_V4: Address = "0xa1378D6558B32e1f8d37b68cf90e3C93839Da365";

export const UQOR_PER_QOR = 1_000_000n;

export interface SponsorConfig {
  registry: Address;
  evmRpc: string;
  rest: string;
  rpc: string;
  port: number;
  host: string;
  /** Trust X-Real-IP / X-Forwarded-For only from these peers (nginx on the same host). */
  trustedProxies: string[];
  stateFile: string;
  payoutLog: string;
  pauseFile: string;
  secretFile: string;
  loopMinutes: number;
  /** A device counts as live when its last anchored window ended within this time. */
  activeWithinSeconds: number;
  /** No top-up while the owner balance is at or above this. */
  thresholdUqor: bigint;
  /** Never top up above this balance. */
  targetUqor: bigint;
  /** Credit per anchor seen on chain: 0.0457 QOR fee plus a share of the window opens. */
  perAnchorUqor: bigint;
  /** Shortest window the agent uses. Caps the creditable anchors per elapsed time. */
  minWindowSeconds: number;
  capCameraDayUqor: bigint;
  capOwnerDayUqor: bigint;
  capGlobalDayUqor: bigint;
  maxCameras: number;
  maxCamerasPerOwner: number;
  minPayoutUqor: bigint;
  minPayoutIntervalSeconds: number;
  /** Automatic pause when the payouts of the last hour pass this. */
  maxHourlyUqor: bigint;
  /** Keep at least this in the hot wallet for fees. */
  reserveUqor: bigint;
  /** Warn when the hot wallet holds more than this (keep only a small float). */
  maxFloatUqor: bigint;
  /** One start grant per camera (owner and device id) that is not on chain yet. */
  grantUqor: bigint;
  /** Start grants admitted per UTC day, all cameras together. */
  maxGrantsPerDay: number;
  /** New enrolments per client IP per UTC day (kept in memory only). */
  maxEnrolPerIpDay: number;
  /** A pending or funded camera that is not registered within this time expires. */
  pendingTtlSeconds: number;
  /** After an unknown grant result, retry once when the owner still holds 0 after this time. */
  grantRetrySeconds: number;
  /** Blocks to search back for the device public key (registration or rotation event). */
  keyLookbackBlocks: bigint;
  logChunkBlocks: bigint;
}

const qor = (v: string | undefined, dflt: string): bigint => {
  const s = (v ?? dflt).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`bad QOR amount: ${s}`);
  const [i, f = ""] = s.split(".");
  return BigInt(i) * UQOR_PER_QOR + BigInt(f.padEnd(6, "0"));
};

const int = (v: string | undefined, dflt: number, min = 0): number => {
  const n = Number(v ?? dflt);
  if (!Number.isInteger(n) || n < min) throw new Error(`bad integer setting: ${v}`);
  return n;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SponsorConfig {
  const dir = env.SPONSOR_DATA_DIR ?? "/var/lib/qw-sponsor";
  const cfg: SponsorConfig = {
    registry: getAddress(env.SPONSOR_REGISTRY ?? REGISTRY_V4),
    evmRpc: env.SPONSOR_EVM_RPC ?? "https://evm-testnet.qore.host",
    rest: env.SPONSOR_REST ?? "https://api-testnet.qore.host",
    rpc: env.SPONSOR_RPC ?? "https://rpc-testnet.qore.host",
    port: int(env.SPONSOR_PORT, 8787, 1),
    host: env.SPONSOR_HOST ?? "127.0.0.1",
    trustedProxies: (env.SPONSOR_TRUSTED_PROXIES ?? "127.0.0.1,::1,::ffff:127.0.0.1").split(",").map((s) => s.trim()).filter(Boolean),
    stateFile: env.SPONSOR_STATE_FILE ?? `${dir}/state.json`,
    payoutLog: env.SPONSOR_PAYOUT_LOG ?? `${dir}/payouts.jsonl`,
    pauseFile: env.SPONSOR_PAUSE_FILE ?? `${dir}/PAUSED`,
    secretFile: env.SPONSOR_SECRET_FILE ?? "/etc/qw-sponsor/secret.env",
    loopMinutes: int(env.SPONSOR_LOOP_MINUTES, 15, 1),
    activeWithinSeconds: int(env.SPONSOR_ACTIVE_WITHIN_SECONDS, 7200, 60),
    thresholdUqor: qor(env.SPONSOR_THRESHOLD_QOR, "10"),
    targetUqor: qor(env.SPONSOR_TARGET_QOR, "15"),
    perAnchorUqor: qor(env.SPONSOR_PER_ANCHOR_QOR, "0.048"),
    minWindowSeconds: int(env.SPONSOR_MIN_WINDOW_SECONDS, 600, 1),
    capCameraDayUqor: qor(env.SPONSOR_CAP_CAMERA_DAY_QOR, "9"),
    capOwnerDayUqor: qor(env.SPONSOR_CAP_OWNER_DAY_QOR, "18"),
    capGlobalDayUqor: qor(env.SPONSOR_CAP_GLOBAL_DAY_QOR, "90"),
    maxCameras: int(env.SPONSOR_MAX_CAMERAS, 12, 0),
    maxCamerasPerOwner: int(env.SPONSOR_MAX_CAMERAS_PER_OWNER, 2, 0),
    minPayoutUqor: qor(env.SPONSOR_MIN_PAYOUT_QOR, "0.5"),
    minPayoutIntervalSeconds: int(env.SPONSOR_MIN_PAYOUT_INTERVAL_SECONDS, 3600, 0),
    maxHourlyUqor: qor(env.SPONSOR_MAX_HOURLY_QOR, "30"),
    reserveUqor: qor(env.SPONSOR_RESERVE_QOR, "1"),
    maxFloatUqor: qor(env.SPONSOR_MAX_FLOAT_QOR, "200"),
    grantUqor: qor(env.SPONSOR_GRANT_QOR, "3"),
    maxGrantsPerDay: int(env.SPONSOR_MAX_GRANTS_DAY, 6, 0),
    maxEnrolPerIpDay: int(env.SPONSOR_MAX_ENROL_PER_IP_DAY, 1, 0),
    pendingTtlSeconds: int(env.SPONSOR_PENDING_TTL_SECONDS, 48 * 3600, 60),
    grantRetrySeconds: int(env.SPONSOR_GRANT_RETRY_SECONDS, 600, 60),
    keyLookbackBlocks: BigInt(int(env.SPONSOR_KEY_LOOKBACK_BLOCKS, 120_000, 1)),
    logChunkBlocks: BigInt(int(env.SPONSOR_LOG_CHUNK_BLOCKS, 5_000, 1)),
  };
  if (cfg.targetUqor < cfg.thresholdUqor) throw new Error("SPONSOR_TARGET_QOR must be at least SPONSOR_THRESHOLD_QOR");
  return cfg;
}

/**
 * Reads SPONSOR_MNEMONIC from the secret file. Refuses a file that the group or
 * others can read. The error messages never contain the file content.
 */
export function loadMnemonic(path: string): string {
  const st = statSync(path);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
    throw new Error(`secret file ${path} is readable by group or others: chmod 600 it`);
  }
  const line = readFileSync(path, "utf8").split("\n").find((l) => l.startsWith("SPONSOR_MNEMONIC="));
  const m = line?.slice("SPONSOR_MNEMONIC=".length).trim().replace(/^["']|["']$/g, "");
  if (!m) throw new Error(`secret file ${path} has no SPONSOR_MNEMONIC line`);
  const words = m.split(/\s+/).length;
  if (words !== 12 && words !== 24) throw new Error(`SPONSOR_MNEMONIC in ${path} must have 12 or 24 words`);
  return m;
}
