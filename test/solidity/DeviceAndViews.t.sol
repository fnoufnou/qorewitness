// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {RegistryFixture} from "./utils/Fixture.sol";
import {AnchorRegistry} from "../../contracts/AnchorRegistry.sol";
import {DeviceRegistry} from "../../contracts/DeviceRegistry.sol";

/// @notice Device records, exact events, status changes and the shapes of the view functions.
/// @dev Signatures come from MockPqcVerify (see utils/Fixture.sol). Not real ML-DSA-87.
///      Most tests here were added for mutants that the earlier tests did not catch (docs/TESTING.md).
contract DeviceAndViewsTest is RegistryFixture {
    bytes32 internal constant DEV2 = keccak256("back-yard");

    // =============================================================== register: record, event, isolation

    /// A3: registerDevice stores the exact record (registeredAt is the block time) and emits
    /// DeviceRegistered with the exact fields. Another owner with the same device id is not touched.
    function testFuzz_register_exactRecordAndEvent(uint64 t, uint256 keySeed, bytes32 id) public {
        t = uint64(_bound(t, T0 + 1, T0 + 3650 days));
        vm.warp(t);
        bytes memory k = _key(keySeed);
        bytes memory m = _regMsg(address(reg), alice, id, keccak256(k), 0);
        bytes memory os = _sign(aliceKey, m);
        bytes memory ds = _sign(k, m);
        vm.expectEmit(true, true, true, true, address(reg));
        emit DeviceRegistry.DeviceRegistered(alice, id, keccak256(k));
        vm.recordLogs();
        vm.prank(alice);
        reg.registerDevice(id, k, os, ds);
        assertEq(vm.getRecordedLogs().length, 1, "one event");
        DeviceRegistry.Device memory d = reg.getDevice(alice, id);
        assertEq(d.keyHash, keccak256(k));
        assertEq(d.keyVersion, 1);
        assertEq(uint8(d.status), uint8(DeviceRegistry.DeviceStatus.Active));
        assertEq(d.registeredAt, t, "registeredAt is the block time");
        assertEq(d.revokedAt, 0);
        DeviceRegistry.Device memory b = reg.getDevice(bob, id);
        assertEq(keccak256(abi.encode(b)), keccak256(abi.encode(DeviceRegistry.Device(0, 0, DeviceRegistry.DeviceStatus.None, 0, 0))));
        assertEq(reg.nonces(alice), 1);
        assertEq(reg.nonces(bob), 0, "nonces are per owner");
    }

    /// A3: nonces are per owner. After another owner has moved its own nonce k times, an owner still
    /// registers, rotates and revokes with signatures at its own nonce (0, 1, 2), and a signature at the
    /// other owner's nonce is refused.
    function testFuzz_nonces_isolatedPerOwner(uint8 kSeed) public {
        uint256 k = _bound(kSeed, 1, 5);
        for (uint256 i = 0; i < k; i++) _register(reg, bob, bobKey, bytes32(i + 1), _key(i + 300));
        assertEq(reg.nonces(bob), k);
        assertEq(reg.nonces(alice), 0);
        // alice's register signed at bob's nonce k: refused
        bytes memory m = _regMsg(address(reg), alice, DEV, keccak256(devKey), k);
        bytes memory os = _sign(aliceKey, m);
        bytes memory ds = _sign(devKey, m);
        vm.prank(alice);
        vm.expectRevert(DeviceRegistry.BadOwnerSignature.selector);
        reg.registerDevice(DEV, devKey, os, ds);
        // at her own nonces: accepted
        _register(reg, alice, aliceKey, DEV, devKey);
        _register(reg, alice, aliceKey, DEV2, _key(2));
        _rotate(reg, alice, DEV, devKey, _key(3));
        _revoke(reg, alice, aliceKey, DEV2);
        assertEq(reg.nonces(alice), 4);
        assertEq(reg.nonces(bob), k, "bob's nonce did not move");
        _register(reg, bob, bobKey, DEV, devKey); // bob at his own nonce k
        assertEq(reg.nonces(bob), k + 1);
    }

    // =============================================================== rotate and revoke: exact events and record

    /// A4: each rotation emits DeviceKeyRotated(owner, device, old key hash, new key hash, new version),
    /// and the revocation emits DeviceRevoked with the current key version. The record follows.
    function testFuzz_rotateAndRevoke_exactEvents(uint8 rotations, uint256 seedBase, uint64 dt) public {
        uint256 n = _bound(rotations, 0, 3);
        uint64 t = T0 + uint64(_bound(dt, 1, 365 days));
        _register(reg, alice, aliceKey, DEV, devKey);
        bytes memory cur = devKey;
        for (uint256 i = 0; i < n; i++) {
            bytes memory nk = _key(uint256(keccak256(abi.encode(seedBase, i))));
            bytes memory m = _rotMsg(address(reg), alice, DEV, keccak256(cur), keccak256(nk), reg.nonces(alice));
            bytes memory so = _sign(cur, m);
            bytes memory sn = _sign(nk, m);
            vm.expectEmit(true, true, true, true, address(reg));
            emit DeviceRegistry.DeviceKeyRotated(alice, DEV, keccak256(cur), keccak256(nk), uint32(i + 2));
            vm.prank(alice);
            reg.rotateDeviceKey(DEV, cur, nk, so, sn);
            cur = nk;
        }
        vm.warp(t);
        bytes memory rs = _sign(aliceKey, _revMsg(address(reg), alice, DEV, reg.nonces(alice)));
        vm.expectEmit(true, true, true, true, address(reg));
        emit DeviceRegistry.DeviceRevoked(alice, DEV, uint32(n + 1));
        vm.prank(alice);
        reg.revokeDevice(DEV, rs);
        DeviceRegistry.Device memory d = reg.getDevice(alice, DEV);
        assertEq(uint8(d.status), uint8(DeviceRegistry.DeviceStatus.Revoked));
        assertEq(d.revokedAt, t);
        assertEq(d.registeredAt, T0);
        assertEq(d.keyVersion, n + 1);
        assertEq(d.keyHash, keccak256(cur));
        assertEq(reg.nonces(alice), n + 2);
    }

    /// A4: a revoked device and an unknown device cannot rotate, even with valid old-key and new-key
    /// signatures at the current nonce. The error is DeviceNotActive and nothing changes.
    function testFuzz_rotate_revokedOrUnknownDeviceRefused(bool revoked, uint256 seed) public {
        vm.assume(seed != 1);
        bytes memory k2 = _key(seed);
        if (revoked) {
            _register(reg, alice, aliceKey, DEV, devKey);
            _revoke(reg, alice, aliceKey, DEV);
        }
        bytes memory m = _rotMsg(address(reg), alice, DEV, keccak256(devKey), keccak256(k2), reg.nonces(alice));
        bytes memory so = _sign(devKey, m);
        bytes memory sn = _sign(k2, m);
        bytes32 before = _digest(reg, alice, DEV);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DeviceRegistry.DeviceNotActive.selector, DEV));
        reg.rotateDeviceKey(DEV, devKey, k2, so, sn);
        assertEq(_digest(reg, alice, DEV), before, "state changed");
    }

    /// A4: Active to Revoked is final. A revoked device cannot be revoked again or registered again.
    function test_status_revokedIsFinal() public {
        assertEq(uint8(reg.getDevice(alice, DEV).status), uint8(DeviceRegistry.DeviceStatus.None));
        _register(reg, alice, aliceKey, DEV, devKey);
        _revoke(reg, alice, aliceKey, DEV);
        bytes memory rs = _sign(aliceKey, _revMsg(address(reg), alice, DEV, reg.nonces(alice)));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DeviceRegistry.DeviceNotActive.selector, DEV));
        reg.revokeDevice(DEV, rs);
        bytes memory m = _regMsg(address(reg), alice, DEV, keccak256(devKey), reg.nonces(alice));
        bytes memory os = _sign(aliceKey, m);
        bytes memory ds = _sign(devKey, m);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DeviceRegistry.DeviceExists.selector, DEV));
        reg.registerDevice(DEV, devKey, os, ds);
        assertEq(uint8(reg.getDevice(alice, DEV).status), uint8(DeviceRegistry.DeviceStatus.Revoked));
    }

    // =============================================================== verifyAnchor: full shape

    /// A1/A4: verifyAnchor reports the device status and revocation time now, the chain head, and the
    /// full anchor. An unknown window gives found=false, included=false, the computed anchor id and an
    /// empty anchor record. An unknown device gives status None and a zero chain head.
    function testFuzz_verifyAnchor_statusRevocationAndShapes(bytes32 seg, uint64 dt) public {
        uint64 tRevoke = T0 + uint64(_bound(dt, 1, 365 days));
        bytes32 root = sha256(abi.encodePacked(bytes1(0x00), seg)); // one-leaf tree
        _register(reg, alice, aliceKey, DEV, devKey);
        uint64 ws = T0 - 1 days;
        bytes32 id = _anchor(reg, alice, _claim(reg, alice, DEV, ws, 600, 1, root), devKey);
        bytes32[] memory none = new bytes32[](0);

        {
            AnchorRegistry.Verification memory a = reg.verifyAnchor(alice, DEV, ws, seg, 0, none);
            assertTrue(a.found && a.included);
            assertEq(uint8(a.deviceStatus), uint8(DeviceRegistry.DeviceStatus.Active));
            assertEq(a.deviceRevokedAt, 0);
        }

        vm.warp(tRevoke);
        _revoke(reg, alice, aliceKey, DEV);
        AnchorRegistry.Verification memory v = reg.verifyAnchor(alice, DEV, ws, seg, 0, none);
        assertTrue(v.found, "found");
        assertTrue(v.included, "included");
        assertEq(v.anchorId, id);
        assertEq(keccak256(abi.encode(v.anchor)), keccak256(abi.encode(reg.getAnchor(id))), "anchor record");
        assertEq(uint8(v.deviceStatus), uint8(DeviceRegistry.DeviceStatus.Revoked), "status now");
        assertEq(v.deviceRevokedAt, tRevoke, "revokedAt");
        assertEq(v.chainHead, root);
        assertFalse(reg.verifyAnchor(alice, DEV, ws, ~seg, 0, none).included, "other segment");

        AnchorRegistry.Verification memory u = reg.verifyAnchor(alice, DEV, ws + 600, seg, 0, none);
        assertFalse(u.found);
        assertFalse(u.included);
        assertEq(u.anchorId, reg.anchorIdOf(alice, DEV, ws + 600));
        AnchorRegistry.Anchor memory empty;
        assertEq(keccak256(abi.encode(u.anchor)), keccak256(abi.encode(empty)), "empty anchor for an unknown window");
        assertEq(uint8(u.deviceStatus), uint8(DeviceRegistry.DeviceStatus.Revoked));
        assertEq(u.deviceRevokedAt, tRevoke);
        assertEq(u.chainHead, root);

        _assertUnknownDevice(bob, ws, seg);
    }

    function _assertUnknownDevice(address owner, uint64 ws, bytes32 seg) internal view {
        AnchorRegistry.Verification memory z = reg.verifyAnchor(owner, DEV, ws, seg, 0, new bytes32[](0));
        assertFalse(z.found || z.included);
        assertEq(z.anchorId, reg.anchorIdOf(owner, DEV, ws));
        assertEq(uint8(z.deviceStatus), uint8(DeviceRegistry.DeviceStatus.None));
        assertEq(z.deviceRevokedAt, 0);
        assertEq(z.chainHead, bytes32(0));
    }

    // =============================================================== constructor flag

    /// A3: requirePossessionProof is what the constructor got. With false, an owner key without
    /// possession proof can register. With true, the same owner is refused.
    function test_constructor_possessionFlag() public {
        AnchorRegistry loose = new AnchorRegistry(false);
        assertFalse(loose.requirePossessionProof());
        assertTrue(reg.requirePossessionProof());
        _setOwnerKey(alice, aliceKey, false);
        bytes memory m = _regMsg(address(reg), alice, DEV, keccak256(devKey), 0);
        bytes memory os = _sign(aliceKey, m);
        bytes memory ds = _sign(devKey, m);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DeviceRegistry.PossessionNotProven.selector, alice));
        reg.registerDevice(DEV, devKey, os, ds);
        _register(loose, alice, aliceKey, DEV, devKey);
        assertEq(uint8(loose.getDevice(alice, DEV).status), uint8(DeviceRegistry.DeviceStatus.Active));
    }
}
