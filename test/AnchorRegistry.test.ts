import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { network } from "hardhat";
import { encodePacked, keccak256, toHex, type Address, type Hex } from "viem";
import { buildLevels, merkleProof, merkleRoot } from "../src/core/merkle.js";
import {
  deviceIdOf, keyHashOf, registerMessage, revokeMessage, rotateMessage, signingMessage, ZERO32,
} from "../src/core/message.js";

const PQC_VERIFY: Address = "0x0000000000000000000000000000000000000a01";
const PQC_KEY_STATUS: Address = "0x0000000000000000000000000000000000000a02";
const ACTIVE = 1;
const REVOKED = 2;

const { viem, networkHelpers } = await network.connect();

/** Fake "signature" accepted by MockPqcVerify. */
function fakeSign(pubkey: Hex, message: Uint8Array): Hex {
  return encodePacked(["bytes32", "bytes32"], [keccak256(pubkey), keccak256(message)]);
}

/** A distinct fake 2,592-byte ML-DSA-87 public key. */
const fakeKey = (fill: number): Hex => toHex(new Uint8Array(2592).fill(fill));

function segments(n: number): Uint8Array[] {
  return Array.from({ length: n }, (_, i) => {
    const b = new Uint8Array(32);
    b[0] = i + 1;
    return b;
  });
}

async function deploy(keyStatusMock: "MockPqcKeyStatus3" | "MockPqcKeyStatus4", requirePop = false, ownerPop = true) {
  const verifyMock = await viem.deployContract("MockPqcVerify");
  const statusMock = await viem.deployContract(keyStatusMock);
  const publicClient = await viem.getPublicClient();
  await networkHelpers.setCode(PQC_VERIFY, (await publicClient.getCode({ address: verifyMock.address }))!);
  await networkHelpers.setCode(PQC_KEY_STATUS, (await publicClient.getCode({ address: statusMock.address }))!);
  // Both mocks have the same setKey(); the 4-value ABI is enough to call it.
  const status = await viem.getContractAt("MockPqcKeyStatus4", PQC_KEY_STATUS);
  const registry = await viem.deployContract("AnchorRegistry", [requirePop]);
  const [wallet, other] = await viem.getWalletClients();
  const ownerKey = fakeKey(7);
  await status.write.setKey([wallet.account.address, ownerKey, ownerPop]);
  const chainId = BigInt(await publicClient.getChainId());
  return { registry, status, wallet, other, ownerKey, chainId, publicClient };
}

type Ctx = Awaited<ReturnType<typeof deploy>>;

describe("AnchorRegistry v2 with DeviceRegistry", () => {
  let ctx: Ctx;
  const deviceId = deviceIdOf("front-door");
  const deviceKey = fakeKey(1);
  const owner = () => ctx.wallet.account.address;

  // ---- helpers that build correctly signed calls -------------------------------------
  async function nonce(addr: Address = owner()) {
    return ctx.registry.read.nonces([addr]);
  }

  async function register(id: Hex = deviceId, key: Hex = deviceKey, opts: { ownerKey?: Hex; devKey?: Hex } = {}) {
    const msg = registerMessage(ctx.chainId, ctx.registry.address, owner(), id, keyHashOf(key), await nonce());
    const ownerSig = fakeSign(opts.ownerKey ?? ctx.ownerKey, msg);
    const devSig = fakeSign(opts.devKey ?? key, msg);
    return ctx.registry.write.registerDevice([id, key, ownerSig, devSig]);
  }

  async function revoke(id: Hex = deviceId, signKey?: Hex) {
    const msg = revokeMessage(ctx.chainId, ctx.registry.address, owner(), id, await nonce());
    return ctx.registry.write.revokeDevice([id, fakeSign(signKey ?? ctx.ownerKey, msg)]);
  }

  async function rotate(oldKey: Hex, newKey: Hex, opts: { oldSigner?: Hex; newSigner?: Hex; id?: Hex } = {}) {
    const id = opts.id ?? deviceId;
    const msg = rotateMessage(ctx.chainId, ctx.registry.address, owner(), id, keyHashOf(oldKey), keyHashOf(newKey), await nonce());
    return ctx.registry.write.rotateDeviceKey([
      id, oldKey, newKey, fakeSign(opts.oldSigner ?? oldKey, msg), fakeSign(opts.newSigner ?? newKey, msg),
    ]);
  }

  type AnchorOpts = { key?: Hex; signKey?: Hex; id?: Hex; prevRoot?: Hex; refBlock?: bigint; refHash?: Hex; from?: Address; seconds?: number };

  /** A correctly chained, signed window claim (prevRoot = chain head, refBlock = latest block). */
  async function claimFor(windowStart: bigint, n: number, opts: AnchorOpts = {}) {
    const id = opts.id ?? deviceId;
    const from = opts.from ?? owner();
    const segs = segments(n);
    const root = toHex(merkleRoot(segs));
    const prevRoot = opts.prevRoot ?? (await ctx.registry.read.chainHead([from, id]));
    const latest = await ctx.publicClient.getBlock();
    const refBlock = opts.refBlock ?? latest.number;
    const refHash = opts.refHash ?? (await ctx.publicClient.getBlock({ blockNumber: refBlock })).hash!;
    const w = { deviceId: id, windowStart, windowSeconds: opts.seconds ?? 60, leafCount: n, root, prevRoot, refBlock };
    const msg = signingMessage(ctx.chainId, ctx.registry.address, { owner: from, ...w }, refHash);
    return { w, segs, root, sig: fakeSign(opts.signKey ?? opts.key ?? deviceKey, msg) };
  }

  async function anchorWindow(windowStart: bigint, n = 5, opts: AnchorOpts = {}) {
    const { w, segs, root, sig } = await claimFor(windowStart, n, opts);
    await ctx.registry.write.anchor([w, opts.key ?? deviceKey, sig]);
    const anchorId = await ctx.registry.read.anchorIdOf([owner(), w.deviceId, windowStart]);
    return { segs, root, anchorId };
  }

  /** Anchor call with raw values, for checks that fail before the signature. */
  const rawAnchor = (windowStart: bigint, windowSeconds: number, leafCount: number) =>
    ctx.registry.write.anchor([
      { deviceId, windowStart, windowSeconds, leafCount, root: ZERO32, prevRoot: ZERO32, refBlock: 1n }, deviceKey, "0x",
    ]);

  const now = async () => BigInt(await networkHelpers.time.latest());

  beforeEach(async () => {
    ctx = await deploy("MockPqcKeyStatus4");
  });

  // ---- message formats ----------------------------------------------------------------
  describe("message formats", () => {
    it("window message in TypeScript matches the contract (256 bytes)", async () => {
      const w = {
        deviceId, windowStart: 1_700_000_000n, windowSeconds: 60, leafCount: 3,
        root: toHex(new Uint8Array(32).fill(9)), prevRoot: toHex(new Uint8Array(32).fill(8)), refBlock: 12345n,
      };
      const refHash = toHex(new Uint8Array(32).fill(7));
      const onChain = await ctx.registry.read.signingMessage([owner(), w, refHash]);
      const local = signingMessage(ctx.chainId, ctx.registry.address, { owner: owner(), ...w }, refHash);
      assert.equal(onChain, toHex(local));
      assert.equal(local.length, 256);
    });

    it("register, revoke and rotate messages in TypeScript match the contract", async () => {
      const kh = keyHashOf(deviceKey);
      const kh2 = keyHashOf(fakeKey(2));
      const reg = ctx.registry.address;
      assert.equal(
        await ctx.registry.read.registerMessage([owner(), deviceId, kh, 5n]),
        toHex(registerMessage(ctx.chainId, reg, owner(), deviceId, kh, 5n)),
      );
      assert.equal(
        await ctx.registry.read.revokeMessage([owner(), deviceId, 6n]),
        toHex(revokeMessage(ctx.chainId, reg, owner(), deviceId, 6n)),
      );
      assert.equal(
        await ctx.registry.read.rotateMessage([owner(), deviceId, kh, kh2, 7n]),
        toHex(rotateMessage(ctx.chainId, reg, owner(), deviceId, kh, kh2, 7n)),
      );
    });
  });

  // ---- T2: register and revoke ---------------------------------------------------------
  describe("device registration (T2)", () => {
    it("registers a device with owner and device signatures", async () => {
      await register();
      const d = await ctx.registry.read.getDevice([owner(), deviceId]);
      assert.equal(d.status, ACTIVE);
      assert.equal(d.keyHash, keyHashOf(deviceKey));
      assert.equal(d.keyVersion, 1);
      assert.equal(await nonce(), 1n);
    });

    it("rejects a bad owner signature", async () => {
      await viem.assertions.revertWithCustomError(register(deviceId, deviceKey, { ownerKey: fakeKey(9) }), ctx.registry, "BadOwnerSignature");
    });

    it("rejects a missing device proof of possession", async () => {
      await viem.assertions.revertWithCustomError(register(deviceId, deviceKey, { devKey: fakeKey(9) }), ctx.registry, "BadDeviceSignature");
    });

    it("rejects a device key with the wrong length", async () => {
      await viem.assertions.revertWithCustomError(
        ctx.registry.write.registerDevice([deviceId, "0x1234", "0x", "0x"]), ctx.registry, "BadDeviceKey",
      );
    });

    it("rejects an owner without a PQC key on chain", async () => {
      await viem.assertions.revertWithCustomError(
        ctx.registry.write.registerDevice([deviceId, deviceKey, "0x", "0x"], { account: ctx.other.account }),
        ctx.registry, "NoPqcKey",
      );
    });

    it("rejects an owner key without proof of possession when required", async () => {
      ctx = await deploy("MockPqcKeyStatus3", true);
      await viem.assertions.revertWithCustomError(register(), ctx.registry, "PossessionNotProven");
    });

    it("accepts the 3-value pqcKeyStatus form when no proof of possession is required", async () => {
      ctx = await deploy("MockPqcKeyStatus3", false);
      await register();
      const { anchorId } = await anchorWindow((await now()) - 500n);
      assert.equal((await ctx.registry.read.getAnchor([anchorId])).leafCount, 5);
    });

    it("rejects a second registration of the same device id", async () => {
      await register();
      await viem.assertions.revertWithCustomError(register(deviceId, fakeKey(2)), ctx.registry, "DeviceExists");
    });

    it("rejects a replayed register signature (nonce)", async () => {
      const id2 = deviceIdOf("garden");
      const msg = registerMessage(ctx.chainId, ctx.registry.address, owner(), deviceId, keyHashOf(deviceKey), 0n);
      const sigs = [fakeSign(ctx.ownerKey, msg), fakeSign(deviceKey, msg)] as const;
      await ctx.registry.write.registerDevice([deviceId, deviceKey, ...sigs]);
      // Same signatures, other device id: message differs, so the owner signature fails.
      await viem.assertions.revertWithCustomError(
        ctx.registry.write.registerDevice([id2, deviceKey, ...sigs]), ctx.registry, "BadOwnerSignature",
      );
    });

    it("devices are per owner: another account cannot use or revoke them", async () => {
      await register();
      await viem.assertions.revertWithCustomError(
        ctx.registry.write.revokeDevice([deviceId, "0x"], { account: ctx.other.account }), ctx.registry, "DeviceNotActive",
      );
    });

    it("revokes a device with the owner signature, final", async () => {
      await register();
      await revoke();
      const d = await ctx.registry.read.getDevice([owner(), deviceId]);
      assert.equal(d.status, REVOKED);
      assert.ok(d.revokedAt > 0n);
      await viem.assertions.revertWithCustomError(revoke(), ctx.registry, "DeviceNotActive");
      await viem.assertions.revertWithCustomError(register(), ctx.registry, "DeviceExists");
    });

    it("rejects revoke with a bad owner signature, or with the device key", async () => {
      await register();
      await viem.assertions.revertWithCustomError(revoke(deviceId, fakeKey(9)), ctx.registry, "BadOwnerSignature");
      await viem.assertions.revertWithCustomError(revoke(deviceId, deviceKey), ctx.registry, "BadOwnerSignature");
    });

    it("rejects revoke of an unknown device", async () => {
      await viem.assertions.revertWithCustomError(revoke(), ctx.registry, "DeviceNotActive");
    });

    it("rejects a replayed revoke signature", async () => {
      const id2 = deviceIdOf("garden");
      await register();
      await register(id2, fakeKey(3));
      const msg = revokeMessage(ctx.chainId, ctx.registry.address, owner(), deviceId, await nonce());
      const sig = fakeSign(ctx.ownerKey, msg);
      await ctx.registry.write.revokeDevice([deviceId, sig]);
      await viem.assertions.revertWithCustomError(ctx.registry.write.revokeDevice([id2, sig]), ctx.registry, "BadOwnerSignature");
    });

    it("anchors from a revoked device fail, older anchors stay verifiable", async () => {
      await register();
      const t = await now();
      const { segs, anchorId } = await anchorWindow(t - 1000n, 3);
      await revoke();
      await viem.assertions.revertWithCustomError(anchorWindow(t - 500n), ctx.registry, "DeviceNotActive");
      const proof = merkleProof(segs, 1).map((p) => toHex(p));
      assert.equal(await ctx.registry.read.verifySegment([anchorId, toHex(segs[1]), 1n, proof]), true);
      const v = await ctx.registry.read.verifyAnchor([owner(), deviceId, t - 1000n, toHex(segs[1]), 1n, proof]);
      assert.equal(v.found, true);
      assert.equal(v.included, true);
      assert.equal(v.deviceStatus, REVOKED);
      assert.ok(v.deviceRevokedAt >= v.anchor.anchoredAt);
    });
  });

  // ---- T3: key rotation ----------------------------------------------------------------
  describe("device key rotation (T3)", () => {
    const newKey = fakeKey(2);

    it("rotates with signatures from the old and the new key", async () => {
      await register();
      await rotate(deviceKey, newKey);
      const d = await ctx.registry.read.getDevice([owner(), deviceId]);
      assert.equal(d.keyHash, keyHashOf(newKey));
      assert.equal(d.keyVersion, 2);
    });

    it("after rotation only the new key can anchor", async () => {
      await register();
      const t = await now();
      const first = await anchorWindow(t - 2000n, 2);
      await rotate(deviceKey, newKey);
      await viem.assertions.revertWithCustomError(anchorWindow(t - 1000n, 2), ctx.registry, "DeviceKeyMismatch");
      const second = await anchorWindow(t - 1000n, 2, { key: newKey });
      assert.equal((await ctx.registry.read.getAnchor([first.anchorId])).deviceKeyVersion, 1);
      assert.equal((await ctx.registry.read.getAnchor([second.anchorId])).deviceKeyVersion, 2);
      assert.equal((await ctx.registry.read.getAnchor([second.anchorId])).deviceKeyHash, keyHashOf(newKey));
    });

    it("rejects rotation without a valid old-key signature", async () => {
      await register();
      await viem.assertions.revertWithCustomError(rotate(deviceKey, newKey, { oldSigner: fakeKey(9) }), ctx.registry, "BadOldKeySignature");
    });

    it("rejects rotation without a valid new-key signature", async () => {
      await register();
      await viem.assertions.revertWithCustomError(rotate(deviceKey, newKey, { newSigner: fakeKey(9) }), ctx.registry, "BadNewKeySignature");
    });

    it("rejects rotation from a key that is not current", async () => {
      await register();
      await viem.assertions.revertWithCustomError(rotate(fakeKey(5), newKey), ctx.registry, "DeviceKeyMismatch");
    });

    it("rejects rotation to the same key and to a malformed key", async () => {
      await register();
      await viem.assertions.revertWithCustomError(rotate(deviceKey, deviceKey), ctx.registry, "SameKey");
      await viem.assertions.revertWithCustomError(
        ctx.registry.write.rotateDeviceKey([deviceId, deviceKey, "0x12", "0x", "0x"]), ctx.registry, "BadDeviceKey",
      );
    });

    it("rejects rotation of a revoked or unknown device", async () => {
      await viem.assertions.revertWithCustomError(rotate(deviceKey, newKey), ctx.registry, "DeviceNotActive");
      await register();
      await revoke();
      await viem.assertions.revertWithCustomError(rotate(deviceKey, newKey), ctx.registry, "DeviceNotActive");
    });

    it("rejects a replayed rotation (nonce)", async () => {
      await register();
      const msg = rotateMessage(ctx.chainId, ctx.registry.address, owner(), deviceId, keyHashOf(deviceKey), keyHashOf(newKey), await nonce());
      const args = [deviceId, deviceKey, newKey, fakeSign(deviceKey, msg), fakeSign(newKey, msg)] as const;
      await ctx.registry.write.rotateDeviceKey([...args]);
      await rotate(newKey, deviceKey); // back to the first key
      await viem.assertions.revertWithCustomError(ctx.registry.write.rotateDeviceKey([...args]), ctx.registry, "BadOldKeySignature");
    });
  });

  // ---- anchoring ------------------------------------------------------------------------
  describe("anchoring", () => {
    beforeEach(async () => {
      await register();
    });

    it("anchors a window and verifies every segment on chain", async () => {
      const t = await now();
      for (const n of [1, 2, 5, 7, 16]) {
        const start = t - 10_000n + BigInt(n) * 100n;
        const { segs, anchorId } = await anchorWindow(start, n);
        const a = await ctx.registry.read.getAnchor([anchorId]);
        assert.equal(a.leafCount, n);
        assert.equal(a.owner.toLowerCase(), owner().toLowerCase());
        for (let i = 0; i < n; i++) {
          const proof = merkleProof(segs, i).map((p) => toHex(p));
          assert.equal(await ctx.registry.read.verifySegment([anchorId, toHex(segs[i]), BigInt(i), proof]), true, `n=${n} i=${i}`);
        }
        const wrong = merkleProof(segs, 0).map((p) => toHex(p));
        assert.equal(await ctx.registry.read.verifySegment([anchorId, toHex(new Uint8Array(32)), 0n, wrong]), false);
      }
    });

    it("rejects a bad device signature", async () => {
      await viem.assertions.revertWithCustomError(anchorWindow((await now()) - 100n, 2, { signKey: fakeKey(9) }), ctx.registry, "BadSignature");
    });

    it("rejects a signature by the owner key instead of the device key", async () => {
      await viem.assertions.revertWithCustomError(anchorWindow((await now()) - 100n, 2, { signKey: ctx.ownerKey }), ctx.registry, "BadSignature");
    });

    it("rejects an unregistered device", async () => {
      await viem.assertions.revertWithCustomError(
        anchorWindow((await now()) - 100n, 2, { id: deviceIdOf("unknown") }), ctx.registry, "DeviceNotActive",
      );
    });

    it("rejects a device key that is not registered for the device", async () => {
      const k = fakeKey(4);
      await viem.assertions.revertWithCustomError(anchorWindow((await now()) - 100n, 2, { key: k }), ctx.registry, "DeviceKeyMismatch");
    });

    it("rejects another account that sends the device key and a valid signature", async () => {
      const t = await now();
      // Signature made for the other account, so only the owner binding stops it.
      const { w, sig } = await claimFor(t - 100n, 2, { from: ctx.other.account.address });
      await viem.assertions.revertWithCustomError(
        ctx.registry.write.anchor([w, deviceKey, sig], { account: ctx.other.account }), ctx.registry, "DeviceNotActive",
      );
    });

    it("rejects empty windows", async () => {
      await viem.assertions.revertWithCustomError(
        rawAnchor(1n, 0, 1), ctx.registry, "EmptyWindow",
      );
      await viem.assertions.revertWithCustomError(
        rawAnchor(1n, 60, 0), ctx.registry, "EmptyWindow",
      );
    });

    it("rejects overlapping and backdated windows", async () => {
      const t = await now();
      await anchorWindow(t - 1000n);
      await assert.rejects(anchorWindow(t - 1000n), /WindowOverlap/);
      await assert.rejects(anchorWindow(t - 990n), /WindowOverlap/);
      await anchorWindow(t - 940n); // starts exactly at the previous window end
      assert.equal(await ctx.registry.read.anchorCount([owner(), deviceId]), 2n);
    });

    it("rejects windows that end in the future", async () => {
      await assert.rejects(anchorWindow((await now()) + 600n), /WindowInFuture/);
    });

    it("rejects windows longer than one day (audit ETH-001)", async () => {
      const start = (await now()) - 200_000n;
      await viem.assertions.revertWithCustomError(
        rawAnchor(start, 86_401, 1), ctx.registry, "WindowTooLong",
      );
      await viem.assertions.revertWithCustomError(
        rawAnchor(start, 4_294_967_295, 1), ctx.registry, "WindowTooLong",
      );
      assert.equal(await ctx.registry.read.MAX_WINDOW_SECONDS(), 86_400);
    });

    it("rejects Merkle proofs longer than 32 hashes (audit ETH-004)", async () => {
      const { segs, anchorId } = await anchorWindow((await now()) - 1000n, 4);
      const good = merkleProof(segs, 1).map((p) => toHex(p));
      assert.equal(await ctx.registry.read.verifySegment([anchorId, toHex(segs[1]), 1n, good]), true);
      const long = [...good, ...Array<Hex>(33 - good.length).fill(toHex(new Uint8Array(32)))];
      assert.equal(await ctx.registry.read.verifySegment([anchorId, toHex(segs[1]), 1n, long]), false);
    });
  });

  // ---- v4: chained windows and time bounds -----------------------------------------------
  describe("chained windows and time bounds (v4)", () => {
    beforeEach(async () => {
      await register();
    });

    it("links each window to the previous root and moves the chain head", async () => {
      const t = await now();
      assert.equal(await ctx.registry.read.chainHead([owner(), deviceId]), ZERO32);
      const a1 = await anchorWindow(t - 3000n, 2);
      const a2 = await anchorWindow(t - 2940n, 3);
      assert.equal((await ctx.registry.read.getAnchor([a1.anchorId])).prevRoot, ZERO32);
      assert.equal((await ctx.registry.read.getAnchor([a2.anchorId])).prevRoot, a1.root);
      assert.equal(await ctx.registry.read.chainHead([owner(), deviceId]), a2.root);
    });

    it("rejects a window that does not link to the chain head (replaced or re-recorded window)", async () => {
      const t = await now();
      const a1 = await anchorWindow(t - 3000n, 3); // other leaf count, so another root than a2
      await anchorWindow(t - 2940n, 2);
      // Skipping a window or building on an older root breaks the chain.
      await viem.assertions.revertWithCustomError(anchorWindow(t - 2880n, 2, { prevRoot: a1.root }), ctx.registry, "BrokenChain");
      await viem.assertions.revertWithCustomError(anchorWindow(t - 2880n, 2, { prevRoot: ZERO32 }), ctx.registry, "BrokenChain");
    });

    it("the first window of a device must start the chain with a zero root", async () => {
      await viem.assertions.revertWithCustomError(
        anchorWindow((await now()) - 500n, 2, { prevRoot: toHex(new Uint8Array(32).fill(1)) }), ctx.registry, "BrokenChain",
      );
    });

    it("stores the gap before a window and emits WindowGap", async () => {
      const t = await now();
      await anchorWindow(t - 3000n, 2); // ends at t - 2940
      const a2 = await anchorWindow(t - 2000n, 2); // 940 s later
      assert.equal((await ctx.registry.read.getAnchor([a2.anchorId])).gapBefore, 940n);
      const events = await ctx.registry.getEvents.WindowGap();
      assert.equal(events.length, 1);
      assert.equal(events[0].args.gapSeconds, 940n);
      assert.equal(events[0].args.gapStart, t - 2940n);
      const a3 = await anchorWindow(t - 1940n, 2); // contiguous
      assert.equal((await ctx.registry.read.getAnchor([a3.anchorId])).gapBefore, 0n);
    });

    it("records the reference block: signed after it, anchored at or after it", async () => {
      const { anchorId } = await anchorWindow((await now()) - 500n, 2);
      const a = await ctx.registry.read.getAnchor([anchorId]);
      assert.ok(a.refBlock < a.blockNumber);
    });

    it("rejects a reference block in the future, the current block and one older than 256 blocks", async () => {
      const latest = await ctx.publicClient.getBlockNumber();
      const zero = ZERO32;
      // A future block has no hash yet. The tx is mined in latest + 1, so latest + 1 is the current block.
      await viem.assertions.revertWithCustomError(
        anchorWindow((await now()) - 500n, 2, { refBlock: latest + 5n, refHash: zero }), ctx.registry, "BadRefBlock",
      );
      await viem.assertions.revertWithCustomError(
        anchorWindow((await now()) - 500n, 2, { refBlock: latest + 1n, refHash: zero }), ctx.registry, "BadRefBlock",
      );
      const old = await ctx.publicClient.getBlock();
      await networkHelpers.mine(300);
      await viem.assertions.revertWithCustomError(
        anchorWindow((await now()) - 500n, 2, { refBlock: old.number, refHash: old.hash! }), ctx.registry, "BadRefBlock",
      );
    });

    it("rejects a signature over a different block hash", async () => {
      await viem.assertions.revertWithCustomError(
        anchorWindow((await now()) - 500n, 2, { refHash: toHex(new Uint8Array(32).fill(3)) }), ctx.registry, "BadSignature",
      );
    });

    it("verifyAnchor returns the chain head and the full record", async () => {
      const t = await now();
      const a1 = await anchorWindow(t - 3000n, 3);
      const a2 = await anchorWindow(t - 2000n, 2);
      const proof = merkleProof(a1.segs, 1).map((p) => toHex(p));
      const v = await ctx.registry.read.verifyAnchor([owner(), deviceId, t - 3000n, toHex(a1.segs[1]), 1n, proof]);
      assert.equal(v.included, true);
      assert.equal(v.chainHead, a2.root);
      assert.equal(v.anchor.prevRoot, ZERO32);
      assert.equal(v.anchor.gapBefore, 0n);
    });
  });

  // ---- T4: verifyAnchor -------------------------------------------------------------------
  describe("verifyAnchor (T4)", () => {
    it("confirms each segment and returns the anchor data", async () => {
      await register();
      const t = await now();
      const { segs, root, anchorId } = await anchorWindow(t - 1000n, 7);
      for (let i = 0; i < 7; i++) {
        const proof = merkleProof(segs, i).map((p) => toHex(p));
        const v = await ctx.registry.read.verifyAnchor([owner(), deviceId, t - 1000n, toHex(segs[i]), BigInt(i), proof]);
        assert.equal(v.found, true);
        assert.equal(v.included, true, `i=${i}`);
        assert.equal(v.anchorId, anchorId);
        assert.equal(v.anchor.root, root);
        assert.equal(v.anchor.leafCount, 7);
        assert.equal(v.anchor.windowSeconds, 60);
        assert.equal(v.anchor.deviceKeyHash, keyHashOf(deviceKey));
        assert.equal(v.anchor.deviceKeyVersion, 1);
        assert.equal(v.deviceStatus, ACTIVE);
        assert.equal(v.deviceRevokedAt, 0n);
      }
    });

    it("reports included = false for a changed file, a wrong index or a wrong path", async () => {
      await register();
      const t = await now();
      const { segs } = await anchorWindow(t - 1000n, 4);
      const proof = merkleProof(segs, 2).map((p) => toHex(p));
      const changed = new Uint8Array(segs[2]);
      changed[31] ^= 1;
      const call = (h: Uint8Array, i: bigint, p: Hex[]) =>
        ctx.registry.read.verifyAnchor([owner(), deviceId, t - 1000n, toHex(h), i, p]);
      assert.equal((await call(changed, 2n, proof)).included, false);
      assert.equal((await call(segs[2], 1n, proof)).included, false);
      assert.equal((await call(segs[2], 9n, proof)).included, false);
      assert.equal((await call(segs[2], 2n, proof.slice(1))).included, false);
      assert.equal((await call(segs[2], 2n, [...proof, proof[0]])).included, false);
    });

    it("returns found = false for an unknown window and does not revert", async () => {
      const v = await ctx.registry.read.verifyAnchor([owner(), deviceId, 123n, toHex(new Uint8Array(32)), 0n, []]);
      assert.equal(v.found, false);
      assert.equal(v.included, false);
      assert.equal(v.deviceStatus, 0);
    });
  });

  it("builds consistent Merkle levels", () => {
    const levels = buildLevels(segments(5));
    assert.deepEqual(levels.map((l) => l.length), [5, 3, 2, 1]);
  });
});
