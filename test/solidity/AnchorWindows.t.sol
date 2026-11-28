// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {RegistryFixture} from "./utils/Fixture.sol";
import {MerkleReference} from "./utils/MerkleReference.sol";
import {AnchorRegistry} from "../../contracts/AnchorRegistry.sol";
import {DeviceRegistry} from "../../contracts/DeviceRegistry.sol";

/// @notice Stateless fuzz tests for anchor: the stored record, claim binding, window and refBlock rules.
/// @dev Signatures come from MockPqcVerify (see utils/Fixture.sol). Not real ML-DSA-87.
///      Every negative case below uses a correctly signed claim, so the revert comes from the rule under test.
contract AnchorWindowsFuzzTest is RegistryFixture, MerkleReference {
    bytes32 internal constant DEV2 = keccak256("back-yard");
    uint64 internal constant SKEW = 120;
    uint32 internal constant MAX_SECS = 86_400;

    function setUp() public override {
        super.setUp();
        _register(reg, alice, aliceKey, DEV, devKey);
    }

    /// @dev Make blockhash() return 0 for the last 256 blocks, as on qorechain-diana.
    function _forgetBlockhashes() internal {
        for (uint256 i = 1; i <= 256 && i < block.number; i++) vm.setBlockhash(block.number - i, bytes32(0));
        assertEq(blockhash(block.number - 1), bytes32(0));
    }

    function _try(AnchorRegistry.WindowClaim memory w, bytes memory key, bytes memory sig)
        internal
        returns (bool ok, bytes memory ret)
    {
        vm.prank(alice);
        (ok, ret) = address(reg).call(abi.encodeCall(AnchorRegistry.anchor, (w, key, sig)));
    }

    // =============================================================== accepted windows are stored exactly

    /// @dev Anchors a correctly signed claim of alice and checks the exact events: WindowGap(owner,
    ///      device, gap start, gap) first when `gap` > 0, then Anchored with every field, nothing else.
    ///      The first window of a device has gap 0 and so emits Anchored only.
    function _anchorExpectingEvents(AnchorRegistry.WindowClaim memory w, uint64 gap) internal returns (bytes32 id) {
        bytes memory sig = _sign(devKey, _winMsg(address(reg), alice, w));
        if (gap > 0) {
            vm.expectEmit(true, true, true, true, address(reg));
            emit AnchorRegistry.WindowGap(alice, w.deviceId, w.windowStart - gap, gap);
        }
        vm.expectEmit(true, true, true, true, address(reg));
        emit AnchorRegistry.Anchored(
            keccak256(abi.encode(alice, w.deviceId, w.windowStart)), alice, w.deviceId, w.windowStart, w.windowSeconds,
            w.leafCount, w.root, keccak256(sig)
        );
        vm.recordLogs();
        vm.prank(alice);
        id = reg.anchor(w, devKey, sig);
        assertEq(vm.getRecordedLogs().length, gap > 0 ? 2 : 1, "one Anchored, plus one WindowGap when there is a gap");
    }

    /// A1/A2: a valid claim is stored field by field; the chain head, the pointer and the gap follow it.
    function testFuzz_anchor_storesExactRecord(uint32 secs1, uint32 secs2, uint32 leaves, bytes32 root1, bytes32 root2, uint32 gap)
        public
    {
        secs1 = uint32(_bound(secs1, 1, MAX_SECS));
        secs2 = uint32(_bound(secs2, 1, MAX_SECS));
        leaves = uint32(_bound(leaves, 1, type(uint32).max));
        uint64 g = uint64(_bound(gap, 0, 30 days));
        uint64 s1 = T0 - 40 days;
        bytes32 id1 = _anchorExpectingEvents(_claim(reg, alice, DEV, s1, secs1, leaves, root1), 0);
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 13);
        uint64 s2 = s1 + secs1 + g;
        AnchorRegistry.WindowClaim memory w2 = _claim(reg, alice, DEV, s2, secs2, 7, root2);
        bytes memory sig2 = _sign(devKey, _winMsg(address(reg), alice, w2));
        bytes32 id2 = _anchorExpectingEvents(w2, g);

        assertEq(id1, keccak256(abi.encode(alice, DEV, s1)));
        assertEq(id2, keccak256(abi.encode(alice, DEV, s2)));
        AnchorRegistry.Anchor memory a = reg.getAnchor(id2);
        assertEq(a.root, root2);
        assertEq(a.sigHash, keccak256(sig2));
        assertEq(a.deviceKeyHash, keccak256(devKey));
        assertEq(a.prevRoot, root1);
        assertEq(a.owner, alice);
        assertEq(a.deviceKeyVersion, 1);
        assertEq(a.windowStart, s2);
        assertEq(a.windowSeconds, secs2);
        assertEq(a.leafCount, 7);
        assertEq(a.anchoredAt, block.timestamp);
        assertEq(a.blockNumber, block.number);
        assertEq(a.refBlock, block.number - 1);
        assertEq(a.gapBefore, g);
        assertEq(reg.getAnchor(id1).gapBefore, 0, "first window has no gap");
        assertEq(reg.getAnchor(id1).leafCount, leaves);
        assertEq(reg.chainHead(alice, DEV), root2);
        assertEq(reg.nextWindowStart(alice, DEV), s2 + secs2);
        assertEq(reg.anchorCount(alice, DEV), 2);
    }

    // =============================================================== any change to a signed claim fails

    /// A1/A2: changing any single field of a signed WindowClaim never yields a stored anchor.
    ///        Each field fails with the specific check that guards it.
    function testFuzz_claimFieldMutation(uint8 field, bytes32 value, bool unknownBlockhash) public {
        field = uint8(field % 8);
        _register(reg, alice, aliceKey, DEV2, devKey); // same key, used by the deviceId mutation
        // one earlier window, so prevRoot is non-zero and nextWindowStart > 0
        _anchor(reg, alice, _claim(reg, alice, DEV, T0 - 3 days, 600, 4, keccak256("w0")), devKey);
        // DEV2 gets the same first window, so its chain head equals DEV's and only the device id differs
        _anchor(reg, alice, _claim(reg, alice, DEV2, T0 - 3 days, 600, 4, keccak256("w0")), devKey);
        vm.roll(block.number + 300);
        if (unknownBlockhash) _forgetBlockhashes();
        AnchorRegistry.WindowClaim memory w = _claim(reg, alice, DEV, T0 - 2 days, 600, 4, keccak256("w1"));
        bytes memory sig = _sign(devKey, _winMsg(address(reg), alice, w));
        uint256 v = uint256(value);
        bytes4 expected = AnchorRegistry.BadSignature.selector;

        if (field == 0) {
            w.deviceId = DEV2; // registered, active, same device key
        } else if (field == 1) {
            uint64 lo = reg.nextWindowStart(alice, DEV);
            uint64 ns = uint64(_bound(v, lo, T0 + SKEW - 600));
            if (ns == w.windowStart) ns += 1;
            w.windowStart = ns;
        } else if (field == 2) {
            uint32 ns = uint32(_bound(v, 1, MAX_SECS));
            if (ns == w.windowSeconds) ns += 1;
            w.windowSeconds = ns;
        } else if (field == 3) {
            uint32 nl = uint32(_bound(v, 1, type(uint32).max));
            if (nl == w.leafCount) nl = nl == 1 ? 2 : nl - 1;
            w.leafCount = nl;
        } else if (field == 4) {
            if (value == w.root) value = ~value;
            w.root = value;
        } else if (field == 5) {
            if (value == w.prevRoot) value = ~value;
            w.prevRoot = value;
            expected = AnchorRegistry.BrokenChain.selector;
        } else if (field == 6) {
            uint64 nr = uint64(_bound(v, block.number - 256, block.number - 1));
            if (nr == w.refBlock) nr -= 1;
            w.refBlock = nr;
            if (!unknownBlockhash) expected = AnchorRegistry.BadRefBlock.selector;
        } else {
            if (value == w.refBlockHash || value == bytes32(0)) value = keccak256(abi.encode(value));
            w.refBlockHash = value;
            if (!unknownBlockhash) expected = AnchorRegistry.BadRefBlock.selector;
        }
        bytes32 before = _digest(reg, alice, DEV);
        bytes32 before2 = _digest(reg, alice, DEV2);
        (bool ok, bytes memory ret) = _try(w, devKey, sig);
        assertFalse(ok, "mutated claim accepted");
        assertEq(bytes4(ret), expected, "unexpected error");
        assertEq(_digest(reg, alice, DEV), before, "state changed");
        assertEq(_digest(reg, alice, DEV2), before2, "state changed");
        // positive control: the original claim with the same signature is accepted
        AnchorRegistry.WindowClaim memory orig = _claim(reg, alice, DEV, T0 - 2 days, 600, 4, keccak256("w1"));
        (ok,) = _try(orig, devKey, sig);
        assertTrue(ok, "original claim rejected");
    }

    // =============================================================== window rules

    /// A2 (backdater): a window that starts before the end of the previous one is refused.
    function testFuzz_window_overlap(uint32 secs, uint64 back) public {
        secs = uint32(_bound(secs, 1, MAX_SECS));
        uint64 s0 = T0 - 10 days;
        _anchor(reg, alice, _claim(reg, alice, DEV, s0, secs, 3, keccak256("a")), devKey);
        uint64 end = s0 + secs;
        uint64 start = uint64(_bound(back, 0, end - 1)); // any start before the end of the last window
        vm.roll(block.number + 1);
        AnchorRegistry.WindowClaim memory w = _claim(reg, alice, DEV, start, 60, 3, keccak256("b"));
        bytes memory sig = _sign(devKey, _winMsg(address(reg), alice, w));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.WindowOverlap.selector, start, end));
        reg.anchor(w, devKey, sig);
        // the first start that does not overlap is accepted
        w.windowStart = end;
        (bool ok,) = _try(w, devKey, _sign(devKey, _winMsg(address(reg), alice, w)));
        assertTrue(ok);
        assertEq(reg.getAnchor(reg.anchorIdOf(alice, DEV, end)).gapBefore, 0);
    }

    /// A1/A4 (re-recorded window, fork): a claim whose prevRoot is not the chain head is refused even
    /// when the device key signed it. The device key holder cannot start a second chain.
    function testFuzz_window_forkRefusedEvenWhenSigned(bytes32 wrongPrev, uint8 earlier) public {
        uint256 k = _bound(earlier, 0, 3);
        uint64 s0 = T0 - 10 days;
        for (uint256 i = 0; i < k; i++) {
            vm.roll(block.number + 1);
            _anchor(reg, alice, _claim(reg, alice, DEV, s0 + uint64(i) * 600, 600, 3, keccak256(abi.encode(i))), devKey);
        }
        bytes32 head = reg.chainHead(alice, DEV);
        vm.assume(wrongPrev != head);
        vm.roll(block.number + 1);
        AnchorRegistry.WindowClaim memory w = _claim(reg, alice, DEV, T0 - 1 days, 60, 3, keccak256("next"));
        w.prevRoot = wrongPrev;
        bytes memory sig = _sign(devKey, _winMsg(address(reg), alice, w));
        bytes32 before = _digest(reg, alice, DEV);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.BrokenChain.selector, head, wrongPrev));
        reg.anchor(w, devKey, sig);
        assertEq(_digest(reg, alice, DEV), before, "state changed");
    }

    /// A8/A2: a window with zero seconds or zero leaves is refused.
    function testFuzz_window_empty(uint32 secs, uint32 leaves, bool zeroSecs) public {
        if (zeroSecs) {
            secs = 0;
            leaves = uint32(_bound(leaves, 0, type(uint32).max));
        } else {
            secs = uint32(_bound(secs, 0, MAX_SECS));
            leaves = 0;
        }
        AnchorRegistry.WindowClaim memory w = _claim(reg, alice, DEV, T0 - 1 days, secs, leaves, keccak256("r"));
        bytes memory sig = _sign(devKey, _winMsg(address(reg), alice, w));
        vm.prank(alice);
        vm.expectRevert(AnchorRegistry.EmptyWindow.selector);
        reg.anchor(w, devKey, sig);
    }

    /// Audit ETH-001: a window longer than MAX_WINDOW_SECONDS is refused, a window of exactly 1 day is not.
    function testFuzz_window_tooLong(uint32 secs) public {
        secs = uint32(_bound(secs, uint256(MAX_SECS) + 1, type(uint32).max));
        AnchorRegistry.WindowClaim memory w = _claim(reg, alice, DEV, T0 - 400 days, secs, 1, keccak256("r"));
        bytes memory sig = _sign(devKey, _winMsg(address(reg), alice, w));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.WindowTooLong.selector, secs, MAX_SECS));
        reg.anchor(w, devKey, sig);
        w.windowSeconds = MAX_SECS;
        (bool ok,) = _try(w, devKey, _sign(devKey, _winMsg(address(reg), alice, w)));
        assertTrue(ok);
    }

    /// A2: the window end may be at most MAX_FUTURE_SKEW after block time, for any start (overflow included).
    /// Mode 0 takes any start. Mode 1 puts the end within 2 days of the limit, so a changed limit
    /// (for example 100,000 s instead of 120 s) is hit. Mode 2 puts the end within 3 s of the limit.
    function testFuzz_window_future(uint64 start, uint32 secs, uint8 mode, uint64 delta) public {
        secs = uint32(_bound(secs, 1, MAX_SECS));
        mode %= 3;
        if (mode != 0) {
            uint256 span = mode == 1 ? 2 days : 3;
            uint256 end_ = _bound(delta, uint256(T0) + SKEW - span, uint256(T0) + SKEW + span);
            start = uint64(end_ - secs);
        }
        AnchorRegistry.WindowClaim memory w = _claim(reg, alice, DEV, start, secs, 1, keccak256("r"));
        (bool ok, bytes memory ret) = _try(w, devKey, _sign(devKey, _winMsg(address(reg), alice, w)));
        uint256 end = uint256(start) + secs;
        if (end > type(uint64).max) {
            assertFalse(ok, "overflowing window accepted");
            assertEq(ret, abi.encodeWithSignature("Panic(uint256)", 0x11));
        } else if (end > uint256(T0) + SKEW) {
            assertFalse(ok, "future window accepted");
            assertEq(ret, abi.encodeWithSelector(AnchorRegistry.WindowInFuture.selector, uint64(end), T0));
        } else {
            assertTrue(ok, "valid window refused");
        }
        assertEq(reg.anchorCount(alice, DEV), ok ? 1 : 0);
    }

    /// A2: exact boundary of the future rule.
    function test_window_futureBoundary() public {
        AnchorRegistry.WindowClaim memory w = _claim(reg, alice, DEV, T0 + SKEW - 60 + 1, 60, 1, keccak256("r"));
        (bool ok,) = _try(w, devKey, _sign(devKey, _winMsg(address(reg), alice, w)));
        assertFalse(ok);
        w.windowStart = T0 + SKEW - 60;
        (ok,) = _try(w, devKey, _sign(devKey, _winMsg(address(reg), alice, w)));
        assertTrue(ok);
    }

    /// A2 (late window with an old start): refBlock must be one of the last 256 blocks, with a
    /// non-zero hash that matches the chain where the EVM knows it. Checked against a reference predicate.
    function testFuzz_refBlock_rules(uint256 cur, uint64 refSeed, bytes32 hash, uint8 mode) public {
        cur = _bound(cur, 2, 10_000_000);
        vm.roll(cur);
        mode %= 4;
        uint64 ref;
        if (mode == 0) ref = refSeed; // anything
        else if (mode == 3) ref = uint64(cur - _bound(refSeed, 0, cur < 300 ? cur : 300)); // anywhere near the range
        else ref = uint64(cur - _bound(refSeed, cur < 250 ? 0 : 250, cur < 262 ? cur : 262)); // at the 256-block edge
        if (mode == 1) hash = blockhash(ref); // the true hash (0 when the EVM does not know it)
        if (mode == 2 && ref < cur && ref + 256 >= cur) vm.setBlockhash(ref, keccak256(abi.encode(hash))); // known, differs from `hash` (almost surely)
        bytes32 known = blockhash(ref);
        bool expectOk = ref < cur && cur - ref <= 256 && hash != bytes32(0) && (known == bytes32(0) || known == hash);

        AnchorRegistry.WindowClaim memory w = _claim(reg, alice, DEV, T0 - 1 days, 60, 1, keccak256("r"));
        w.refBlock = ref;
        w.refBlockHash = hash;
        (bool ok, bytes memory ret) = _try(w, devKey, _sign(devKey, _winMsg(address(reg), alice, w)));
        assertEq(ok, expectOk, "refBlock rule");
        if (!ok) assertEq(ret, abi.encodeWithSelector(AnchorRegistry.BadRefBlock.selector, ref));
        else assertEq(reg.getAnchor(reg.anchorIdOf(alice, DEV, w.windowStart)).refBlock, ref);
    }

    /// A2: exact edges of the refBlock range, with a non-zero signed hash and the EVM not knowing
    /// the hash (as on qorechain-diana): 256 blocks back is accepted, 257 back and the current block are not.
    function test_refBlock_rangeEdges() public {
        vm.roll(10_000);
        _forgetBlockhashes();
        uint64[4] memory backs = [uint64(1), 256, 257, 0];
        bool[4] memory accepted = [true, true, false, false];
        for (uint256 i = 0; i < 4; i++) {
            AnchorRegistry.WindowClaim memory w =
                _claim(reg, alice, DEV, T0 - 1 days + uint64(i) * 60, 60, 1, keccak256(abi.encode(i)));
            w.refBlock = uint64(block.number) - backs[i];
            w.refBlockHash = keccak256(abi.encode("signed", i));
            (bool ok, bytes memory ret) = _try(w, devKey, _sign(devKey, _winMsg(address(reg), alice, w)));
            assertEq(ok, accepted[i]);
            if (!ok) assertEq(ret, abi.encodeWithSelector(AnchorRegistry.BadRefBlock.selector, w.refBlock));
        }
    }

    /// A2: with block hashes unknown to the EVM (as on qorechain-diana), a signed refBlockHash of 0 is
    /// refused with BadRefBlock. Without the zero check the contract could not compare anything here.
    function test_refBlock_zeroSignedHashRefusedWhenUnknown() public {
        vm.roll(10_000);
        _forgetBlockhashes();
        AnchorRegistry.WindowClaim memory w = _claim(reg, alice, DEV, T0 - 1 days, 60, 1, keccak256("r"));
        w.refBlockHash = bytes32(0);
        bytes memory sig = _sign(devKey, _winMsg(address(reg), alice, w));
        bytes32 before = _digest(reg, alice, DEV);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.BadRefBlock.selector, w.refBlock));
        reg.anchor(w, devKey, sig);
        assertEq(_digest(reg, alice, DEV), before, "state changed");
        // positive control: the same claim with a non-zero signed hash is accepted
        w.refBlockHash = keccak256("signed");
        (bool ok,) = _try(w, devKey, _sign(devKey, _winMsg(address(reg), alice, w)));
        assertTrue(ok, "non-zero signed hash refused");
    }

    /// A2: unknown block hash combined with a zero and with a non-zero signed hash, anywhere in the
    /// 256-block range: zero is always refused, non-zero is always accepted.
    function testFuzz_refBlock_unknownHashZeroOrNot(uint256 cur, uint16 back, bytes32 signedHash, bool zero) public {
        cur = _bound(cur, 300, 10_000_000);
        vm.roll(cur);
        _forgetBlockhashes();
        uint64 ref = uint64(cur - _bound(back, 1, 256));
        assertEq(blockhash(ref), bytes32(0));
        bytes32 h = zero ? bytes32(0) : (signedHash == bytes32(0) ? keccak256(abi.encode(cur)) : signedHash);
        AnchorRegistry.WindowClaim memory w = _claim(reg, alice, DEV, T0 - 1 days, 60, 1, keccak256("r"));
        w.refBlock = ref;
        w.refBlockHash = h;
        (bool ok, bytes memory ret) = _try(w, devKey, _sign(devKey, _winMsg(address(reg), alice, w)));
        assertEq(ok, !zero, "zero hash rule with unknown block hash");
        if (!ok) assertEq(ret, abi.encodeWithSelector(AnchorRegistry.BadRefBlock.selector, ref));
        else assertEq(reg.getAnchor(reg.anchorIdOf(alice, DEV, w.windowStart)).refBlock, ref);
    }

    /// A2: a known block hash that differs from the signed one is refused; the true one is accepted.
    function testFuzz_refBlock_knownHashMismatch(bytes32 chainHash, bytes32 signedHash, uint8 back) public {
        vm.assume(chainHash != bytes32(0) && signedHash != bytes32(0) && chainHash != signedHash);
        uint64 ref = uint64(block.number - _bound(back, 1, 256));
        vm.setBlockhash(ref, chainHash);
        AnchorRegistry.WindowClaim memory w = _claim(reg, alice, DEV, T0 - 1 days, 60, 1, keccak256("r"));
        w.refBlock = ref;
        w.refBlockHash = signedHash;
        bytes memory sig = _sign(devKey, _winMsg(address(reg), alice, w));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.BadRefBlock.selector, ref));
        reg.anchor(w, devKey, sig);
        w.refBlockHash = chainHash;
        (bool ok,) = _try(w, devKey, _sign(devKey, _winMsg(address(reg), alice, w)));
        assertTrue(ok);
    }

    // =============================================================== device state

    /// A4 (breach, device revoked): a revoked device never anchors again, even with a valid signature.
    function testFuzz_revokedDeviceNeverAnchors(uint64 start, uint32 secs, bytes32 root) public {
        _revoke(reg, alice, aliceKey, DEV);
        secs = uint32(_bound(secs, 1, MAX_SECS));
        start = uint64(_bound(start, 0, T0 + SKEW - secs));
        AnchorRegistry.WindowClaim memory w = _claim(reg, alice, DEV, start, secs, 1, root);
        bytes memory sig = _sign(devKey, _winMsg(address(reg), alice, w));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DeviceRegistry.DeviceNotActive.selector, DEV));
        reg.anchor(w, devKey, sig);
    }

    /// A4: after a rotation the old key cannot anchor; the new key can, and the record names the new key.
    function testFuzz_rotation_oldKeyDead(uint256 seed) public {
        vm.assume(seed != 1);
        bytes memory k2 = _key(seed);
        _rotate(reg, alice, DEV, devKey, k2);
        AnchorRegistry.WindowClaim memory w = _claim(reg, alice, DEV, T0 - 1 days, 60, 1, keccak256("r"));
        bytes memory oldSig = _sign(devKey, _winMsg(address(reg), alice, w));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DeviceRegistry.DeviceKeyMismatch.selector, DEV));
        reg.anchor(w, devKey, oldSig);
        // new key presented, old-key signature: refused by the signature check
        vm.prank(alice);
        vm.expectRevert(AnchorRegistry.BadSignature.selector);
        reg.anchor(w, k2, oldSig);
        bytes32 id = _anchor(reg, alice, w, k2);
        assertEq(reg.getAnchor(id).deviceKeyHash, keccak256(k2));
        assertEq(reg.getAnchor(id).deviceKeyVersion, 2);
    }

    // =============================================================== segments of a stored window

    /// A1: for a stored window, every segment verifies on chain at its index, and the size used is
    /// always the signed, stored leafCount (the caller cannot pass one). A changed segment, another
    /// index or another window's anchor id fails. verifyAnchor never reverts for an unknown window.
    function testFuzz_verifySegment_usesStoredLeafCount(uint256 sizeSeed, bytes32 salt, uint256 idx, uint256 other)
        public
    {
        uint256 n = _bound(sizeSeed, 1, 300);
        Tree memory t = _tree(n, salt);
        bytes32 id = _anchor(reg, alice, _claim(reg, alice, DEV, T0 - 1 days, 600, uint32(n), t.root), devKey);
        uint256 i = idx % n;
        assertTrue(reg.verifySegment(id, t.segs[i], i, t.proofs[i]), "valid segment refused");
        AnchorRegistry.Verification memory v = reg.verifyAnchor(alice, DEV, T0 - 1 days, t.segs[i], i, t.proofs[i]);
        assertTrue(v.found && v.included);
        assertEq(v.chainHead, t.root);
        assertEq(v.anchor.leafCount, n);
        assertFalse(reg.verifySegment(id, keccak256(abi.encode(t.segs[i])), i, t.proofs[i]), "changed segment");
        if (n > 1) {
            uint256 j = (i + 1 + other % (n - 1)) % n;
            assertFalse(reg.verifySegment(id, t.segs[i], j, t.proofs[i]), "other index");
        }
        assertFalse(reg.verifySegment(id, t.segs[i], n + other % 100, t.proofs[i]), "index >= leafCount");
        bytes32 unknown = reg.anchorIdOf(alice, DEV, T0 - 2 days);
        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.UnknownAnchor.selector, unknown));
        reg.verifySegment(unknown, t.segs[i], i, t.proofs[i]);
        AnchorRegistry.Verification memory u = reg.verifyAnchor(alice, DEV, T0 - 2 days, t.segs[i], i, t.proofs[i]);
        assertFalse(u.found || u.included);
        assertEq(u.chainHead, t.root);
    }
}
