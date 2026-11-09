import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { network } from "hardhat";
import { encodePacked, keccak256, toHex, type Address, type Hex } from "viem";
import { buildLevels, merkleProof, merkleRoot } from "../src/core/merkle.js";
import { deviceIdOf, signingMessage } from "../src/core/message.js";

const PQC_VERIFY: Address = "0x0000000000000000000000000000000000000a01";
const PQC_KEY_STATUS: Address = "0x0000000000000000000000000000000000000a02";

const { viem, networkHelpers } = await network.connect();

/** Fake "signature" accepted by MockPqcVerify. */
function fakeSign(pubkey: Hex, message: Uint8Array): Hex {
  return encodePacked(["bytes32", "bytes32"], [keccak256(pubkey), keccak256(message)]);
}

function segments(n: number): Uint8Array[] {
  return Array.from({ length: n }, (_, i) => {
    const b = new Uint8Array(32);
    b[0] = i + 1;
    return b;
  });
}

async function deploy(keyStatusMock: "MockPqcKeyStatus3" | "MockPqcKeyStatus4", requirePop = false) {
  const verifyMock = await viem.deployContract("MockPqcVerify");
  const statusMock = await viem.deployContract(keyStatusMock);
  const publicClient = await viem.getPublicClient();
  await networkHelpers.setCode(PQC_VERIFY, (await publicClient.getCode({ address: verifyMock.address }))!);
  await networkHelpers.setCode(PQC_KEY_STATUS, (await publicClient.getCode({ address: statusMock.address }))!);
  const status = await viem.getContractAt(keyStatusMock, PQC_KEY_STATUS);
  const registry = await viem.deployContract("AnchorRegistry", [requirePop]);
  const [wallet, other] = await viem.getWalletClients();
  const pubkey = toHex(new Uint8Array(2592).fill(7));
  await status.write.setKey([wallet.account.address, pubkey, true]);
  const chainId = BigInt(await publicClient.getChainId());
  return { registry, status, wallet, other, pubkey, chainId, publicClient };
}

describe("AnchorRegistry", () => {
  let ctx: Awaited<ReturnType<typeof deploy>>;
  const deviceId = deviceIdOf("front-door");

  beforeEach(async () => {
    ctx = await deploy("MockPqcKeyStatus4");
  });

  async function anchorWindow(windowStart: bigint, n = 5, windowSeconds = 60) {
    const segs = segments(n);
    const root = toHex(merkleRoot(segs));
    const claim = { signer: ctx.wallet.account.address, deviceId, windowStart, windowSeconds, leafCount: n, root };
    const msg = signingMessage(ctx.chainId, ctx.registry.address, claim);
    const sig = fakeSign(ctx.pubkey, msg);
    await ctx.registry.write.anchor([deviceId, windowStart, windowSeconds, n, root, sig]);
    const id = await ctx.registry.read.anchorIdOf([ctx.wallet.account.address, deviceId, windowStart]);
    return { segs, root, id, msg };
  }

  it("signing message in TypeScript matches the contract", async () => {
    const claim = {
      signer: ctx.wallet.account.address,
      deviceId,
      windowStart: 1_700_000_000n,
      windowSeconds: 60,
      leafCount: 3,
      root: toHex(new Uint8Array(32).fill(9)),
    };
    const onChain = await ctx.registry.read.signingMessage([
      claim.signer, claim.deviceId, claim.windowStart, claim.windowSeconds, claim.leafCount, claim.root,
    ]);
    assert.equal(onChain, toHex(signingMessage(ctx.chainId, ctx.registry.address, claim)));
  });

  it("anchors a window and verifies every segment on chain", async () => {
    const now = BigInt(await networkHelpers.time.latest());
    for (const n of [1, 2, 5, 7, 16]) {
      const start = now - 10_000n + BigInt(n) * 100n;
      const { segs, id } = await anchorWindow(start, n);
      const a = (await ctx.registry.read.getAnchor([id])) as { leafCount: number };
      assert.equal(a.leafCount, n);
      for (let i = 0; i < n; i++) {
        const proof = merkleProof(segs, i).map((p) => toHex(p));
        assert.equal(await ctx.registry.read.verifySegment([id, toHex(segs[i]), BigInt(i), proof]), true, `n=${n} i=${i}`);
      }
      const wrong = merkleProof(segs, 0).map((p) => toHex(p));
      assert.equal(await ctx.registry.read.verifySegment([id, toHex(new Uint8Array(32)), 0n, wrong]), false);
    }
  });

  it("rejects a bad signature", async () => {
    const now = BigInt(await networkHelpers.time.latest());
    const root = toHex(merkleRoot(segments(2)));
    await viem.assertions.revertWithCustomError(
      ctx.registry.write.anchor([deviceId, now - 100n, 60, 2, root, "0x1234"]),
      ctx.registry,
      "BadSignature",
    );
  });

  it("rejects a sender without a PQC key", async () => {
    const now = BigInt(await networkHelpers.time.latest());
    const root = toHex(merkleRoot(segments(2)));
    await viem.assertions.revertWithCustomError(
      ctx.registry.write.anchor([deviceId, now - 100n, 60, 2, root, "0x"], { account: ctx.other.account }),
      ctx.registry,
      "NoPqcKey",
    );
  });

  it("rejects overlapping and backdated windows", async () => {
    const now = BigInt(await networkHelpers.time.latest());
    await anchorWindow(now - 1000n);
    await assert.rejects(anchorWindow(now - 1000n), /WindowOverlap/);
    await assert.rejects(anchorWindow(now - 990n), /WindowOverlap/);
    await anchorWindow(now - 940n); // starts exactly at the previous window end
    assert.equal(await ctx.registry.read.anchorCount([ctx.wallet.account.address, deviceId]), 2n);
  });

  it("rejects windows that end in the future", async () => {
    const now = BigInt(await networkHelpers.time.latest());
    await assert.rejects(anchorWindow(now + 600n), /WindowInFuture/);
  });

  it("works with the 3-value pqcKeyStatus form", async () => {
    ctx = await deploy("MockPqcKeyStatus3");
    const now = BigInt(await networkHelpers.time.latest());
    const { id } = await anchorWindow(now - 500n);
    assert.equal(((await ctx.registry.read.getAnchor([id])) as { leafCount: number }).leafCount, 5);
  });

  it("enforces proof of possession when required", async () => {
    ctx = await deploy("MockPqcKeyStatus3", true);
    const now = BigInt(await networkHelpers.time.latest());
    await assert.rejects(anchorWindow(now - 500n), /PossessionNotProven/);
  });

  it("builds consistent levels", () => {
    const levels = buildLevels(segments(5));
    assert.deepEqual(levels.map((l) => l.length), [5, 3, 2, 1]);
  });
});
