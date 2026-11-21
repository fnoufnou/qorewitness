/**
 * setup.ts - first-run setup for one camera in the terminal. The browser setup
 * (src/web/wizard.ts) runs the same steps from src/setup/steps.ts. Safe to run
 * again: every step checks what exists and skips it.
 *
 *   1. Camera settings      -> /data/camera.env (mode 600)
 *   2. Owner account        -> /data/qorewitness.env (new recovery phrase, mode 600, testnet only)
 *   3. Test QOR             -> waits until the faucet funds the account
 *   4. Camera key           -> /data/keys/<camera>.key (mode 600)
 *   5. Registration         -> account ML-DSA-87 key, scoped EVM window, camera in the registry
 *
 * Usage (Docker): docker compose run --rm agent setup [--camera front-door] [--stream rtsp://...]
 * Env: QW_DATA (default /data), QORE_REGISTRY (default: the public v4 registry).
 */
import { createInterface } from "node:readline/promises";
import { redactSecrets, safeError } from "../src/core/redact.js";
import {
  FAUCET, MIN_SETUP_UQOR, dataPaths, ensureDeviceKey, ensureOwnerAccount, finishSetup, keyFingerprint, liveChain,
  readAccountInfo, readEnvFile, registerOnChain, saveCamera,
} from "../src/setup/steps.js";

const p = dataPaths();
const chain = liveChain();
const rl = createInterface({ input: process.stdin, output: process.stdout });
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const say = (s: string) => console.log(s);
const step = (n: number, s: string) => say(`\n[${n}/5] ${s}`);

async function main(): Promise<void> {
  say("QoreWitness setup (QoreChain testnet). Nothing here touches mainnet funds.");

  step(1, "Camera");
  const cam = readEnvFile(p.cameraEnv);
  const label = cam.QW_DEVICE ?? arg("camera") ?? ((await rl.question("Camera name (letters, digits, dashes) [camera]: ")).trim() || "camera");
  const stream = cam.QW_STREAM_URL ?? cam.QW_RTSP_URL ?? arg("stream") ?? arg("rtsp") ??
    (await rl.question("Stream URL of the camera (rtsp://, rtmp:// or https://): ")).trim();
  saveCamera(p, { label, streamUrl: stream });
  say(`  camera "${label}" saved in ${p.cameraEnv} (mode 600), stream ${redactSecrets(stream)}`);

  step(2, "Owner account");
  const owner = await ensureOwnerAccount(p);
  if (owner.created) say("  new account created from a fresh recovery phrase");
  say(`  address ${owner.cosmos} (EVM ${owner.evm})`);
  say(`  the recovery phrase is in ${p.accountEnv} (mode 600). Back it up. Never use it on mainnet.`);

  step(3, "Test QOR");
  for (let bal = await chain.balanceUqor(owner.cosmos); bal < MIN_SETUP_UQOR; bal = await chain.balanceUqor(owner.cosmos)) {
    say(`  balance ${Number(bal) / 1e6} QOR. Claim test QOR for ${owner.cosmos} at ${FAUCET} (Faucet).`);
    await rl.question("  Press Enter when the faucet has sent it... ");
  }
  say(`  balance ${Number(await chain.balanceUqor(owner.cosmos)) / 1e6} QOR`);

  step(4, "Camera key");
  const { key, created } = ensureDeviceKey(p, label);
  say(`  ${created ? "created" : "found"} camera key ${keyFingerprint(key.keyHash)}`);

  step(5, "Registration on QoreChain");
  const r = await registerOnChain(p, label, chain, (n, total, text) => say(`  (${n}/${total}) ${text}`));
  if (r.txHash) say(`  camera registered: tx ${r.txHash}`);
  say(`  camera "${label}" is active, key version ${r.keyVersion}`);
  finishSetup(p, {
    device: label, deviceId: r.deviceId, owner: owner.evm, qor1: owner.cosmos, registry: owner.registry,
    plan: readAccountInfo(p)?.plan ?? "self", keyFingerprint: keyFingerprint(key.keyHash),
    registeredTx: r.txHash ?? readAccountInfo(p)?.registeredTx, setupAt: new Date().toISOString(),
  });

  say("\nDone. Start recording and anchoring with: docker compose up -d");
  say("Receipts appear in ./data/" + label + "/receipts every 10 minutes.");
}

main()
  .catch((e: unknown) => {
    console.error(`\nSetup stopped: ${safeError(e)}`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
