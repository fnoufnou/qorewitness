/**
 * device.ts - manage camera devices in the DeviceRegistry.
 *
 *   pnpm device keygen <key-file>                     new random ML-DSA-87 device key (mode 600)
 *   pnpm device status <label> [key-file]             device record on chain
 *   pnpm device register <label> [key-file]           owner key + device key sign
 *   pnpm device revoke <label>                        owner key signs. Final.
 *   pnpm device rotate <label> <old-key> <new-key>    old and new device key sign
 *
 * Env: QORE_MNEMONIC (owner account), QORE_REGISTRY. Default key file: keys/<label>.key.
 * The sender needs a live EVM window that allows the registry (pnpm window open).
 */
import type { Address } from "viem";
import { AnchorClient, DEVICE_STATUS } from "../src/agent/anchor-client.js";
import { createDeviceKey, loadDeviceKey } from "../src/agent/device-key.js";
import { deviceIdOf } from "../src/core/message.js";

const [cmd, a1, a2, a3] = process.argv.slice(2);
const keyFile = (label: string, f?: string) => f ?? `keys/${label}.key`;

function client(): Promise<AnchorClient> {
  const mnemonic = process.env.QORE_MNEMONIC?.trim();
  const registry = process.env.QORE_REGISTRY?.trim() as Address | undefined;
  if (!mnemonic || !registry) throw new Error("set QORE_MNEMONIC and QORE_REGISTRY in .env");
  return AnchorClient.create(mnemonic, registry);
}

const tx = (r: { txHash: string; blockNumber: bigint; gasUsed: bigint }) =>
  `tx ${r.txHash} block ${r.blockNumber} gas ${r.gasUsed}`;

async function main(): Promise<void> {
  switch (cmd) {
    case "keygen": {
      if (!a1) throw new Error("usage: device keygen <key-file>");
      const k = createDeviceKey(a1);
      console.log(`new device key in ${a1}, key hash ${k.keyHash}`);
      return;
    }
    case "status": {
      if (!a1) throw new Error("usage: device status <label> [key-file]");
      const c = await client();
      const d = await c.getDevice(deviceIdOf(a1));
      console.log(`owner ${c.address} device ${a1} (${deviceIdOf(a1)})`);
      console.log(`status ${DEVICE_STATUS[d.status]}, key version ${d.keyVersion}, key hash ${d.keyHash}`);
      if (d.revokedAt > 0n) console.log(`revoked at ${new Date(Number(d.revokedAt) * 1000).toISOString()}`);
      try {
        const k = loadDeviceKey(keyFile(a1, a2));
        console.log(`local key ${k.keyHash === d.keyHash ? "matches" : "does NOT match"} the chain`);
      } catch {
        // no local key: fine for status
      }
      return;
    }
    case "register": {
      if (!a1) throw new Error("usage: device register <label> [key-file]");
      const c = await client();
      console.log(`registered ${a1}: ${tx(await c.registerDevice(deviceIdOf(a1), loadDeviceKey(keyFile(a1, a2))))}`);
      return;
    }
    case "revoke": {
      if (!a1) throw new Error("usage: device revoke <label>");
      const c = await client();
      console.log(`revoked ${a1}: ${tx(await c.revokeDevice(deviceIdOf(a1)))}`);
      return;
    }
    case "rotate": {
      if (!a1 || !a2 || !a3) throw new Error("usage: device rotate <label> <old-key-file> <new-key-file>");
      const c = await client();
      const r = await c.rotateDeviceKey(deviceIdOf(a1), loadDeviceKey(a2), loadDeviceKey(a3));
      console.log(`rotated ${a1}: ${tx(r)}`);
      return;
    }
    default:
      throw new Error("commands: keygen | status | register | revoke | rotate");
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message.split("\n")[0] : err);
  process.exitCode = 1;
});
