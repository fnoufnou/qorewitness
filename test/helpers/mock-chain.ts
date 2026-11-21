import type { Hex } from "viem";
import { MIN_SETUP_UQOR, type ChainOps } from "../../src/setup/steps.js";

/** In-memory chain: counts every write, never touches a network. */
export function mockChain(opts: { balance?: bigint; pqc?: "none" | "ours" | "other"; wrongNetwork?: boolean } = {}) {
  const calls: string[] = [];
  let pqc = opts.pqc ?? "none";
  const devices = new Map<string, { status: number; keyHash: Hex; keyVersion: number }>();
  const chain: ChainOps = {
    async assertTestnet() {
      calls.push("assert");
      if (opts.wrongNetwork) throw new Error("refusing to write: expected testnet");
    },
    async balanceUqor() {
      return opts.balance ?? MIN_SETUP_UQOR;
    },
    async pqcKeyState() {
      return pqc;
    },
    async registerPqcKey() {
      calls.push("registerPqcKey");
      pqc = "ours";
    },
    async ensureWindow() {
      calls.push("ensureWindow");
      return true;
    },
    async getDevice(_m, _r, id) {
      return devices.get(id) ?? { status: 0, keyHash: `0x${"00".repeat(32)}`, keyVersion: 0 };
    },
    async registerDevice(_m, _r, id, key) {
      calls.push("registerDevice");
      devices.set(id, { status: 1, keyHash: key.keyHash, keyVersion: 1 });
      return { txHash: `0x${"ab".repeat(32)}` };
    },
  };
  return { chain, calls, devices };
}

