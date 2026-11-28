// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {RegistryFixture} from "./utils/Fixture.sol";
import {AnchorRegistry} from "../../contracts/AnchorRegistry.sol";
import {DeviceRegistry} from "../../contracts/DeviceRegistry.sol";

/// @notice Stateless fuzz tests: signature binding, domain separation and replay.
/// @dev Signatures come from MockPqcVerify (see utils/Fixture.sol). Not real ML-DSA-87.
///      Threat ids refer to docs/THREAT_MODEL.md (A1 to A9) and docs/AUDIT.md.
contract SignaturesFuzzTest is RegistryFixture {
    bytes32 internal constant DEV2 = keccak256("back-yard");

    function _assumeSigs(bytes memory a, bytes memory valid) internal pure {
        vm.assume(keccak256(a) != keccak256(valid));
    }

    // =============================================================== signed bytes

    /// A3/A7: the contract's message builders return exactly the reference bytes (the bytes the
    /// device and owner sign, see src/core/message.ts); the window message is 256 bytes.
    function testFuzz_messagesMatchReference(
        address owner,
        bytes32 id,
        bytes32 kh,
        bytes32 kh2,
        uint256 nonce,
        uint64 start,
        uint32 secs,
        uint32 leaves,
        bytes32 root,
        uint64 refBlock
    ) public view {
        assertEq(reg.registerMessage(owner, id, kh, nonce), _regMsg(address(reg), owner, id, kh, nonce));
        assertEq(reg.revokeMessage(owner, id, nonce), _revMsg(address(reg), owner, id, nonce));
        assertEq(reg.rotateMessage(owner, id, kh, kh2, nonce), _rotMsg(address(reg), owner, id, kh, kh2, nonce));
        AnchorRegistry.WindowClaim memory w = AnchorRegistry.WindowClaim(id, start, secs, leaves, root, kh, refBlock, kh2);
        bytes memory wm = reg.signingMessage(owner, w);
        assertEq(wm, _winMsg(address(reg), owner, w));
        assertEq(wm.length, 256);
        assertEq(reg.anchorIdOf(owner, id, start), keccak256(abi.encode(owner, id, start)));
    }

    // =============================================================== any other signature fails

    /// A3 (rogue key): registerDevice accepts only the exact owner and device signatures.
    function testFuzz_register_rejectsAnyOtherSignature(uint256 mode, uint256 pos, bytes memory junk, bool hitDevice)
        public
    {
        bytes memory m = _regMsg(address(reg), alice, DEV, keccak256(devKey), 0);
        bytes memory os = _sign(aliceKey, m);
        bytes memory ds = _sign(devKey, m);
        bytes32 before = _digest(reg, alice, DEV);
        if (hitDevice) {
            ds = _otherSig(ds, mode, pos, junk);
            _assumeSigs(ds, _sign(devKey, m));
            vm.expectRevert(DeviceRegistry.BadDeviceSignature.selector);
        } else {
            os = _otherSig(os, mode, pos, junk);
            _assumeSigs(os, _sign(aliceKey, m));
            vm.expectRevert(DeviceRegistry.BadOwnerSignature.selector);
        }
        vm.prank(alice);
        reg.registerDevice(DEV, devKey, os, ds);
        assertEq(_digest(reg, alice, DEV), before, "state changed");
        assertEq(uint8(reg.getDevice(alice, DEV).status), 0);
    }

    /// A3: revokeDevice accepts only the exact owner signature.
    function testFuzz_revoke_rejectsAnyOtherSignature(uint256 mode, uint256 pos, bytes memory junk) public {
        _register(reg, alice, aliceKey, DEV, devKey);
        bytes memory valid = _sign(aliceKey, _revMsg(address(reg), alice, DEV, 1));
        bytes memory s = _otherSig(valid, mode, pos, junk);
        _assumeSigs(s, valid);
        bytes32 before = _digest(reg, alice, DEV);
        vm.prank(alice);
        vm.expectRevert(DeviceRegistry.BadOwnerSignature.selector);
        reg.revokeDevice(DEV, s);
        assertEq(_digest(reg, alice, DEV), before, "state changed");
        assertEq(uint8(reg.getDevice(alice, DEV).status), 1);
    }

    /// A3: rotateDeviceKey accepts only the exact old-key and new-key signatures.
    function testFuzz_rotate_rejectsAnyOtherSignature(uint256 mode, uint256 pos, bytes memory junk, bool hitNew)
        public
    {
        _register(reg, alice, aliceKey, DEV, devKey);
        bytes memory newKey = _key(2);
        bytes memory m = _rotMsg(address(reg), alice, DEV, keccak256(devKey), keccak256(newKey), 1);
        bytes memory so = _sign(devKey, m);
        bytes memory sn = _sign(newKey, m);
        if (hitNew) {
            sn = _otherSig(sn, mode, pos, junk);
            _assumeSigs(sn, _sign(newKey, m));
        } else {
            so = _otherSig(so, mode, pos, junk);
            _assumeSigs(so, _sign(devKey, m));
        }
        bytes32 before = _digest(reg, alice, DEV);
        vm.prank(alice);
        vm.expectRevert(hitNew ? DeviceRegistry.BadNewKeySignature.selector : DeviceRegistry.BadOldKeySignature.selector);
        reg.rotateDeviceKey(DEV, devKey, newKey, so, sn);
        assertEq(_digest(reg, alice, DEV), before, "state changed");
        assertEq(reg.getDevice(alice, DEV).keyHash, keccak256(devKey));
    }

    /// A3 (forged anchor): anchor accepts only the exact device signature over the claim.
    function testFuzz_anchor_rejectsAnyOtherSignature(uint256 mode, uint256 pos, bytes memory junk) public {
        _register(reg, alice, aliceKey, DEV, devKey);
        AnchorRegistry.WindowClaim memory w = _claim(reg, alice, DEV, T0 - 600, 60, 5, keccak256("root"));
        bytes memory valid = _sign(devKey, _winMsg(address(reg), alice, w));
        bytes memory s = _otherSig(valid, mode, pos, junk);
        _assumeSigs(s, valid);
        bytes32 before = _digest(reg, alice, DEV);
        vm.prank(alice);
        vm.expectRevert(AnchorRegistry.BadSignature.selector);
        reg.anchor(w, devKey, s);
        assertEq(_digest(reg, alice, DEV), before, "state changed");
        bytes32 id = reg.anchorIdOf(alice, DEV, w.windowStart);
        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.UnknownAnchor.selector, id));
        reg.getAnchor(id);
        // Positive control: the exact signature is accepted.
        vm.prank(alice);
        reg.anchor(w, devKey, valid);
        assertEq(reg.anchorCount(alice, DEV), 1);
    }

    // =============================================================== domain separation

    function _assumeUsable(address a) internal view {
        // Low addresses hold precompiles (0x01 to 0x11, 0x100 P256VERIFY) and the QoreChain ones (0x0A01, 0x0A02).
        vm.assume(uint160(a) > 0xffff && a != alice && a != bob);
        assumeNotPrecompile(a);
        assumeNotForgeAddress(a);
        vm.assume(a.code.length == 0);
    }

    /// A3: a signature for one owner never works for another owner, even one with the same PQC key.
    function testFuzz_domain_otherOwner(address other) public {
        _assumeUsable(other);
        _setOwnerKey(other, aliceKey, true); // worst case: both owners have the same chain key
        // register: alice's signatures sent by `other`
        bytes memory m = _regMsg(address(reg), alice, DEV, keccak256(devKey), 0);
        bytes memory os = _sign(aliceKey, m);
        bytes memory ds = _sign(devKey, m);
        vm.prank(other);
        vm.expectRevert(DeviceRegistry.BadOwnerSignature.selector);
        reg.registerDevice(DEV, devKey, os, ds);
        // anchor: both own DEV with the same device key; alice's window signature sent by `other`
        _register(reg, alice, aliceKey, DEV, devKey);
        _register(reg, other, aliceKey, DEV, devKey);
        AnchorRegistry.WindowClaim memory w = _claim(reg, alice, DEV, T0 - 600, 60, 5, keccak256("root"));
        bytes memory s = _sign(devKey, _winMsg(address(reg), alice, w));
        vm.prank(other);
        vm.expectRevert(AnchorRegistry.BadSignature.selector);
        reg.anchor(w, devKey, s);
        // revoke: alice's revoke signature at the same nonce (1) sent by `other`
        bytes memory rs = _sign(aliceKey, _revMsg(address(reg), alice, DEV, 1));
        assertEq(reg.nonces(other), 1);
        vm.prank(other);
        vm.expectRevert(DeviceRegistry.BadOwnerSignature.selector);
        reg.revokeDevice(DEV, rs);
        // rotate: alice's rotation signatures sent by `other`
        bytes memory k2 = _key(2);
        bytes memory rm = _rotMsg(address(reg), alice, DEV, keccak256(devKey), keccak256(k2), 1);
        bytes memory s1 = _sign(devKey, rm);
        bytes memory s2 = _sign(k2, rm);
        vm.prank(other);
        vm.expectRevert(DeviceRegistry.BadOldKeySignature.selector);
        reg.rotateDeviceKey(DEV, devKey, k2, s1, s2);
        assertEq(reg.anchorCount(other, DEV), 0);
        assertEq(reg.nonces(other), 1);
        assertEq(uint8(reg.getDevice(other, DEV).status), 1);
    }

    /// A1/A3: a signature for one device never works for another device of the same owner, same key.
    function testFuzz_domain_otherDevice(bytes32 otherId) public {
        vm.assume(otherId != DEV);
        _register(reg, alice, aliceKey, DEV, devKey);
        // register: the signatures for DEV (nonce 1) used for otherId
        bytes memory m = _regMsg(address(reg), alice, DEV, keccak256(devKey), 1);
        bytes memory os = _sign(aliceKey, m);
        bytes memory ds = _sign(devKey, m);
        vm.prank(alice);
        vm.expectRevert(DeviceRegistry.BadOwnerSignature.selector);
        reg.registerDevice(otherId, devKey, os, ds);
        _register(reg, alice, aliceKey, otherId, devKey); // same key, nonce 1 -> 2
        // anchor: claim signed for DEV, sent for otherId
        AnchorRegistry.WindowClaim memory w = _claim(reg, alice, DEV, T0 - 600, 60, 5, keccak256("root"));
        bytes memory s = _sign(devKey, _winMsg(address(reg), alice, w));
        w.deviceId = otherId;
        vm.prank(alice);
        vm.expectRevert(AnchorRegistry.BadSignature.selector);
        reg.anchor(w, devKey, s);
        // revoke: signature for DEV used on otherId
        bytes memory rs = _sign(aliceKey, _revMsg(address(reg), alice, DEV, 2));
        vm.prank(alice);
        vm.expectRevert(DeviceRegistry.BadOwnerSignature.selector);
        reg.revokeDevice(otherId, rs);
        // rotate: signatures for DEV used on otherId
        bytes memory k2 = _key(2);
        bytes memory rm = _rotMsg(address(reg), alice, DEV, keccak256(devKey), keccak256(k2), 2);
        bytes memory s1 = _sign(devKey, rm);
        bytes memory s2 = _sign(k2, rm);
        vm.prank(alice);
        vm.expectRevert(DeviceRegistry.BadOldKeySignature.selector);
        reg.rotateDeviceKey(otherId, devKey, k2, s1, s2);
        assertEq(reg.nonces(alice), 2);
        assertEq(reg.anchorCount(alice, otherId), 0);
        assertEq(reg.getDevice(alice, otherId).keyVersion, 1);
    }

    /// A3: a signature for one registry instance never works on another instance at any address.
    function testFuzz_domain_otherRegistry(address at) public {
        _assumeUsable(at);
        vm.etch(at, address(reg).code); // same code, same immutables, empty storage
        AnchorRegistry reg2 = AnchorRegistry(at);
        // register: signatures for reg used on reg2
        bytes memory m = _regMsg(address(reg), alice, DEV, keccak256(devKey), 0);
        bytes memory os = _sign(aliceKey, m);
        bytes memory ds = _sign(devKey, m);
        vm.prank(alice);
        vm.expectRevert(DeviceRegistry.BadOwnerSignature.selector);
        reg2.registerDevice(DEV, devKey, os, ds);
        _register(reg, alice, aliceKey, DEV, devKey);
        _register(reg2, alice, aliceKey, DEV, devKey);
        // anchor
        AnchorRegistry.WindowClaim memory w = _claim(reg, alice, DEV, T0 - 600, 60, 5, keccak256("root"));
        bytes memory s = _sign(devKey, _winMsg(address(reg), alice, w));
        vm.prank(alice);
        vm.expectRevert(AnchorRegistry.BadSignature.selector);
        reg2.anchor(w, devKey, s);
        // revoke
        bytes memory rs = _sign(aliceKey, _revMsg(address(reg), alice, DEV, 1));
        vm.prank(alice);
        vm.expectRevert(DeviceRegistry.BadOwnerSignature.selector);
        reg2.revokeDevice(DEV, rs);
        // rotate
        bytes memory k2 = _key(2);
        bytes memory rm = _rotMsg(address(reg), alice, DEV, keccak256(devKey), keccak256(k2), 1);
        bytes memory s1 = _sign(devKey, rm);
        bytes memory s2 = _sign(k2, rm);
        vm.prank(alice);
        vm.expectRevert(DeviceRegistry.BadOldKeySignature.selector);
        reg2.rotateDeviceKey(DEV, devKey, k2, s1, s2);
        // the same signatures still work on reg: they were valid, only the domain differed
        vm.prank(alice);
        reg.anchor(w, devKey, s);
        assertEq(reg2.anchorCount(alice, DEV), 0);
        assertEq(reg2.nonces(alice), 1);
    }

    /// A3: a signature made for one chain id never works after a change of chain id (fork, other network).
    function testFuzz_domain_otherChainId(uint64 cid) public {
        vm.assume(cid != block.chainid && cid != 0);
        _register(reg, alice, aliceKey, DEV, devKey);
        // all four signatures are made on the current chain id
        bytes memory k2 = _key(2);
        bytes memory rm = _rotMsg(address(reg), alice, DEV, keccak256(devKey), keccak256(k2), 1);
        bytes memory s1 = _sign(devKey, rm);
        bytes memory s2 = _sign(k2, rm);
        bytes memory rs = _sign(aliceKey, _revMsg(address(reg), alice, DEV, 1));
        bytes memory gm = _regMsg(address(reg), alice, DEV2, keccak256(k2), 1);
        bytes memory gos = _sign(aliceKey, gm);
        bytes memory gds = _sign(k2, gm);
        AnchorRegistry.WindowClaim memory w = _claim(reg, alice, DEV, T0 - 600, 60, 5, keccak256("root"));
        bytes memory s = _sign(devKey, _winMsg(address(reg), alice, w));
        bytes32 before = _digest(reg, alice, DEV);

        vm.chainId(cid);
        vm.prank(alice);
        vm.expectRevert(AnchorRegistry.BadSignature.selector);
        reg.anchor(w, devKey, s);
        vm.prank(alice);
        vm.expectRevert(DeviceRegistry.BadOwnerSignature.selector);
        reg.revokeDevice(DEV, rs);
        vm.prank(alice);
        vm.expectRevert(DeviceRegistry.BadOldKeySignature.selector);
        reg.rotateDeviceKey(DEV, devKey, k2, s1, s2);
        vm.prank(alice);
        vm.expectRevert(DeviceRegistry.BadOwnerSignature.selector);
        reg.registerDevice(DEV2, k2, gos, gds);
        assertEq(_digest(reg, alice, DEV), before, "state changed");
        assertEq(uint8(reg.getDevice(alice, DEV2).status), 0);
    }

    /// A3: a valid signature for one action is never accepted as another action
    ///     (register, revoke, rotate and anchor messages carry different tags and layouts).
    function testFuzz_domain_actionConfusion(bytes32 rootSeed, uint256 keySeed) public {
        vm.assume(keySeed > 10);
        bytes memory k2 = _key(keySeed);
        _register(reg, alice, aliceKey, DEV, devKey); // nonce 1
        AnchorRegistry.WindowClaim memory w = _claim(reg, alice, DEV, T0 - 600, 60, 5, rootSeed);

        bytes[4] memory msgs = [
            _regMsg(address(reg), alice, DEV2, keccak256(k2), 1),
            _revMsg(address(reg), alice, DEV, 1),
            _rotMsg(address(reg), alice, DEV, keccak256(devKey), keccak256(k2), 1),
            _winMsg(address(reg), alice, w)
        ];
        bytes[3] memory keys = [aliceKey, devKey, k2];
        bytes32 before = _digest(reg, alice, DEV);
        for (uint256 i = 0; i < 4; i++) {
            for (uint256 k = 0; k < 3; k++) {
                bytes memory s = _sign(keys[k], msgs[i]);
                // as a revoke (owner key): only (revoke message, owner key) may pass
                if (!(i == 1 && k == 0)) {
                    vm.prank(alice);
                    vm.expectRevert(DeviceRegistry.BadOwnerSignature.selector);
                    reg.revokeDevice(DEV, s);
                }
                // as the old-key rotation signature: only (rotate message, old key) may pass
                if (!(i == 2 && k == 1)) {
                    bytes memory goodNew = _sign(k2, msgs[2]);
                    vm.prank(alice);
                    vm.expectRevert(DeviceRegistry.BadOldKeySignature.selector);
                    reg.rotateDeviceKey(DEV, devKey, k2, s, goodNew);
                }
                // as the owner signature of a registration: only (register message, owner key) may pass
                if (!(i == 0 && k == 0)) {
                    bytes memory goodDev = _sign(k2, msgs[0]);
                    vm.prank(alice);
                    vm.expectRevert(DeviceRegistry.BadOwnerSignature.selector);
                    reg.registerDevice(DEV2, k2, s, goodDev);
                }
                // as a window signature: only (window message, device key) may pass
                if (!(i == 3 && k == 1)) {
                    vm.prank(alice);
                    vm.expectRevert(AnchorRegistry.BadSignature.selector);
                    reg.anchor(w, devKey, s);
                }
            }
        }
        assertEq(_digest(reg, alice, DEV), before, "state changed");
        assertEq(uint8(reg.getDevice(alice, DEV2).status), 0);
    }

    // =============================================================== replay

    /// A3: an owner signature for a registration is dead once the nonce has moved, used or not.
    function testFuzz_replay_register(uint8 steps) public {
        uint256 k = _bound(steps, 1, 6);
        // signed at nonce 0 for DEV2, held back
        bytes memory k2 = _key(2);
        bytes memory m = _regMsg(address(reg), alice, DEV2, keccak256(k2), 0);
        bytes memory os = _sign(aliceKey, m);
        bytes memory ds = _sign(k2, m);
        for (uint256 i = 0; i < k; i++) _register(reg, alice, aliceKey, bytes32(i + 100), _key(i + 100));
        assertEq(reg.nonces(alice), k);
        vm.prank(alice);
        vm.expectRevert(DeviceRegistry.BadOwnerSignature.selector);
        reg.registerDevice(DEV2, k2, os, ds);
        // a used registration cannot be replayed either, also not after a revoke
        bytes memory m1 = _regMsg(address(reg), alice, DEV, keccak256(devKey), k);
        bytes memory os1 = _sign(aliceKey, m1);
        bytes memory ds1 = _sign(devKey, m1);
        vm.prank(alice);
        reg.registerDevice(DEV, devKey, os1, ds1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DeviceRegistry.DeviceExists.selector, DEV));
        reg.registerDevice(DEV, devKey, os1, ds1);
        _revoke(reg, alice, aliceKey, DEV);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DeviceRegistry.DeviceExists.selector, DEV));
        reg.registerDevice(DEV, devKey, os1, ds1);
        assertEq(reg.nonces(alice), k + 2);
    }

    /// A3: a revoke signature works once, and a held-back revoke signature dies when the nonce moves.
    function testFuzz_replay_revoke(uint8 steps) public {
        uint256 k = _bound(steps, 1, 6);
        _register(reg, alice, aliceKey, DEV, devKey);
        _register(reg, alice, aliceKey, DEV2, _key(2));
        bytes memory held = _sign(aliceKey, _revMsg(address(reg), alice, DEV2, 2));
        for (uint256 i = 0; i < k; i++) _register(reg, alice, aliceKey, bytes32(i + 100), _key(i + 100));
        vm.prank(alice);
        vm.expectRevert(DeviceRegistry.BadOwnerSignature.selector);
        reg.revokeDevice(DEV2, held);
        bytes memory s = _sign(aliceKey, _revMsg(address(reg), alice, DEV, 2 + k));
        vm.prank(alice);
        reg.revokeDevice(DEV, s);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DeviceRegistry.DeviceNotActive.selector, DEV));
        reg.revokeDevice(DEV, s);
        assertEq(reg.nonces(alice), 3 + k);
        assertEq(uint8(reg.getDevice(alice, DEV2).status), 1);
    }

    /// @dev Calldata of owner or device action X for the replay test, signed at `nonce`.
    ///      0: revoke DEV (owner key). 1: rotate DEV to a new key (old and new device key). 2: register a new device.
    function _heldBackAction(uint256 x, uint256 nonce) internal view returns (bytes memory) {
        if (x == 0) {
            return abi.encodeCall(DeviceRegistry.revokeDevice, (DEV, _sign(aliceKey, _revMsg(address(reg), alice, DEV, nonce))));
        }
        if (x == 1) {
            bytes memory nk = _key(40);
            bytes memory m = _rotMsg(address(reg), alice, DEV, keccak256(devKey), keccak256(nk), nonce);
            return abi.encodeCall(DeviceRegistry.rotateDeviceKey, (DEV, devKey, nk, _sign(devKey, m), _sign(nk, m)));
        }
        bytes32 nid = keccak256("held-back-device");
        bytes memory k = _key(41);
        bytes memory rm = _regMsg(address(reg), alice, nid, keccak256(k), nonce);
        return abi.encodeCall(DeviceRegistry.registerDevice, (nid, k, _sign(aliceKey, rm), _sign(k, rm)));
    }

    /// A3: held-back signature replay that reaches the signature check. The owner signs action X at
    /// nonce n and holds it back, then performs a different action Y, which moves the nonce. X at the
    /// old nonce fails on the signature check itself (BadOwnerSignature or BadOldKeySignature, never a
    /// state check), and X signed again at the new nonce succeeds. Every pair of X and Y in
    /// register, rotate and revoke.
    function testFuzz_replay_heldBackReachesSignatureCheck(uint8 x, uint8 y) public {
        uint256 xi = x % 3;
        uint256 yi = y % 3;
        _register(reg, alice, aliceKey, DEV, devKey);
        _register(reg, alice, aliceKey, DEV2, _key(2));
        uint256 n = reg.nonces(alice);
        bytes memory held = _heldBackAction(xi, n);
        // Y acts on DEV2 or on a third device, never on what X touches
        if (yi == 0) _register(reg, alice, aliceKey, keccak256("third-device"), _key(3));
        else if (yi == 1) _rotate(reg, alice, DEV2, _key(2), _key(4));
        else _revoke(reg, alice, aliceKey, DEV2);
        assertEq(reg.nonces(alice), n + 1, "Y moved the nonce");
        bytes32 before = _digest(reg, alice, DEV);
        vm.prank(alice);
        (bool ok, bytes memory ret) = address(reg).call(held);
        assertFalse(ok, "held-back signature accepted after the nonce moved");
        bytes4 expected = xi == 1 ? DeviceRegistry.BadOldKeySignature.selector : DeviceRegistry.BadOwnerSignature.selector;
        assertEq(ret, abi.encodePacked(expected), "refused by the signature check");
        assertEq(_digest(reg, alice, DEV), before, "state changed");
        vm.prank(alice);
        (ok,) = address(reg).call(_heldBackAction(xi, n + 1));
        assertTrue(ok, "X signed at the new nonce refused");
        assertEq(reg.nonces(alice), n + 2);
    }

    /// A3/A4: rotation K1 -> K2 -> K1 does not make the first K1 -> K2 signatures valid again.
    function testFuzz_replay_rotateBackAndForth(uint256 seedB) public {
        vm.assume(seedB != 1);
        bytes memory k1 = devKey;
        bytes memory kb = _key(seedB);
        _register(reg, alice, aliceKey, DEV, k1);
        bytes memory m = _rotMsg(address(reg), alice, DEV, keccak256(k1), keccak256(kb), 1);
        bytes memory s1 = _sign(k1, m);
        bytes memory s2 = _sign(kb, m);
        vm.prank(alice);
        reg.rotateDeviceKey(DEV, k1, kb, s1, s2);
        _rotate(reg, alice, DEV, kb, k1); // back to K1, nonce 3
        assertEq(reg.getDevice(alice, DEV).keyHash, keccak256(k1));
        bytes32 before = _digest(reg, alice, DEV);
        vm.prank(alice);
        vm.expectRevert(DeviceRegistry.BadOldKeySignature.selector);
        reg.rotateDeviceKey(DEV, k1, kb, s1, s2);
        assertEq(_digest(reg, alice, DEV), before, "state changed");
        assertEq(reg.getDevice(alice, DEV).keyVersion, 3);
    }

    /// A1/A2: no anchor signature is accepted twice, whichever earlier window is replayed.
    function testFuzz_replay_anchor(uint8 count, uint256 pick, uint256 gapSeed) public {
        uint256 n = _bound(count, 1, 8);
        _register(reg, alice, aliceKey, DEV, devKey);
        AnchorRegistry.WindowClaim[] memory ws = new AnchorRegistry.WindowClaim[](n);
        bytes[] memory sigs = new bytes[](n);
        uint64 start = T0 - 7 days;
        for (uint256 i = 0; i < n; i++) {
            vm.roll(block.number + 1);
            ws[i] = _claim(reg, alice, DEV, start, 600, 10, keccak256(abi.encode("root", i)));
            sigs[i] = _sign(devKey, _winMsg(address(reg), alice, ws[i]));
            vm.prank(alice);
            reg.anchor(ws[i], devKey, sigs[i]);
            start += 600 + uint64(_bound(uint256(keccak256(abi.encode(gapSeed, i))), 0, 3600));
        }
        uint256 j = pick % n;
        bytes32 before = _digest(reg, alice, DEV);
        vm.roll(block.number + 1);
        bytes memory err =
            abi.encodeWithSelector(AnchorRegistry.WindowOverlap.selector, ws[j].windowStart, reg.nextWindowStart(alice, DEV));
        vm.prank(alice);
        vm.expectRevert(err);
        reg.anchor(ws[j], devKey, sigs[j]);
        assertEq(_digest(reg, alice, DEV), before, "state changed");
        assertEq(reg.anchorCount(alice, DEV), n);
    }

    // =============================================================== key format and key status forms

    /// A3 (rogue key): a device key that is not 2,592 bytes is refused at register and at rotate.
    function testFuzz_rejectsWrongKeyLength(uint16 len) public {
        uint256 n = _bound(len, 0, 6000);
        vm.assume(n != KEY_LEN);
        bytes memory bad = new bytes(n);
        bytes memory m = _regMsg(address(reg), alice, DEV, keccak256(bad), 0);
        bytes memory os = _sign(aliceKey, m);
        bytes memory ds = _sign(bad, m);
        vm.prank(alice);
        vm.expectRevert(DeviceRegistry.BadDeviceKey.selector);
        reg.registerDevice(DEV, bad, os, ds);
        _register(reg, alice, aliceKey, DEV, devKey);
        bytes memory rm = _rotMsg(address(reg), alice, DEV, keccak256(devKey), keccak256(bad), 1);
        bytes memory s1 = _sign(devKey, rm);
        bytes memory s2 = _sign(bad, rm);
        vm.prank(alice);
        vm.expectRevert(DeviceRegistry.BadDeviceKey.selector);
        reg.rotateDeviceKey(DEV, devKey, bad, s1, s2);
        assertEq(reg.getDevice(alice, DEV).keyHash, keccak256(devKey));
    }

    /// A4: rotation must start from the current key and move to a different key.
    function testFuzz_rotate_needsCurrentKeyAndNewKey(uint256 seed) public {
        vm.assume(seed > 2);
        _register(reg, alice, aliceKey, DEV, devKey);
        bytes memory notCurrent = _key(seed);
        bytes memory k2 = _key(2);
        bytes memory m = _rotMsg(address(reg), alice, DEV, keccak256(notCurrent), keccak256(k2), 1);
        bytes memory s1 = _sign(notCurrent, m);
        bytes memory s2 = _sign(k2, m);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DeviceRegistry.DeviceKeyMismatch.selector, DEV));
        reg.rotateDeviceKey(DEV, notCurrent, k2, s1, s2);
        bytes memory same = _rotMsg(address(reg), alice, DEV, keccak256(devKey), keccak256(devKey), 1);
        bytes memory s3 = _sign(devKey, same);
        vm.prank(alice);
        vm.expectRevert(DeviceRegistry.SameKey.selector);
        reg.rotateDeviceKey(DEV, devKey, devKey, s3, s3);
        assertEq(reg.nonces(alice), 1);
        assertEq(reg.getDevice(alice, DEV).keyVersion, 1);
    }

    /// A3: with each key-status mock (3, 4 and 5 values), registration needs possession proof exactly
    /// when the registry requires it, and the 3-value form never counts as proven.
    function testFuzz_registry_eachKeyStatusForm(uint8 shape, bool requirePop, bool pop) public {
        shape = uint8(3 + shape % 3);
        _installMocks(shape);
        _setOwnerKey(alice, aliceKey, pop);
        AnchorRegistry r = new AnchorRegistry(requirePop);
        bytes memory m = _regMsg(address(r), alice, DEV, keccak256(devKey), 0);
        bytes memory os = _sign(aliceKey, m);
        bytes memory ds = _sign(devKey, m);
        bool ok = !requirePop || (pop && shape != 3);
        if (!ok) vm.expectRevert(abi.encodeWithSelector(DeviceRegistry.PossessionNotProven.selector, alice));
        vm.prank(alice);
        r.registerDevice(DEV, devKey, os, ds);
        assertEq(r.nonces(alice), ok ? 1 : 0);
        // an account without a chain key is refused with every form
        vm.prank(address(0xC0FFEE));
        vm.expectRevert(abi.encodeWithSelector(DeviceRegistry.NoPqcKey.selector, address(0xC0FFEE)));
        r.registerDevice(DEV, devKey, os, ds);
    }
}
