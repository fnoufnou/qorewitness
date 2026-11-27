// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {RegistryFixture} from "./utils/Fixture.sol";
import {QorePqc} from "../../contracts/QorePqc.sol";
import {AnchorRegistry} from "../../contracts/AnchorRegistry.sol";
import {DeviceRegistry} from "../../contracts/DeviceRegistry.sol";

/// @dev Exposes the internal library functions for direct calls.
contract PqcHarness {
    function verify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external
        view
        returns (bool)
    {
        return QorePqc.verify(pubkey, signature, message);
    }

    function keyStatus(address account) external view returns (bool, uint8, bytes memory, bool) {
        return QorePqc.keyStatus(account);
    }
}

/// @dev A hostile or broken precompile: answers every call with fixed bytes, or reverts with them.
contract HostilePrecompile {
    bytes internal answer;
    bool internal fail;

    function setAnswer(bytes calldata a, bool f) external {
        answer = a;
        fail = f;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        bytes memory a = answer;
        if (fail) {
            assembly {
                revert(add(a, 0x20), mload(a))
            }
        }
        assembly {
            return(add(a, 0x20), mload(a))
        }
    }
}

/// @notice Fail-closed behaviour of QorePqc when a precompile is missing, broken or hostile,
///         and the 3-, 4- and 5-value forms of pqcKeyStatus.
/// @dev The "precompiles" here are test contracts. Real ML-DSA-87 is not run in these tests
///      (see utils/Fixture.sol). Threat model: "Residual risks", network upgrade changes the
///      precompile answers, the contract must then refuse (fail closed).
contract QorePqcFailClosedTest is RegistryFixture {
    PqcHarness internal h;

    function setUp() public override {
        super.setUp();
        h = new PqcHarness();
    }

    function _hostile(address at, bytes memory answer, bool fail) internal {
        vm.etch(at, address(new HostilePrecompile()).code);
        HostilePrecompile(payable(at)).setAnswer(answer, fail);
    }

    function _word(bytes memory b, uint256 i) internal pure returns (uint256 w) {
        assembly {
            w := mload(add(add(b, 0x20), mul(i, 0x20)))
        }
    }

    // =============================================================== no code at the precompile address

    /// Fail closed: pqcVerify without code (empty answer) reverts PqcPrecompileInactive, never false or true.
    function testFuzz_verify_noCodeReverts(bytes calldata pk, bytes calldata sig, bytes calldata m) public {
        vm.etch(PQC_VERIFY, "");
        vm.expectRevert(QorePqc.PqcPrecompileInactive.selector);
        h.verify(pk, sig, m);
    }

    /// Fail closed: pqcKeyStatus without code reverts PqcPrecompileInactive.
    function testFuzz_keyStatus_noCodeReverts(address a) public {
        vm.etch(PQC_KEY_STATUS, "");
        vm.expectRevert(QorePqc.PqcPrecompileInactive.selector);
        h.keyStatus(a);
    }

    /// Fail closed at registry level: no anchor, no registration while pqcVerify is inactive.
    function test_registry_inactiveVerify() public {
        _register(reg, alice, aliceKey, DEV, devKey);
        vm.etch(PQC_VERIFY, "");
        AnchorRegistry.WindowClaim memory w = _claim(reg, alice, DEV, T0 - 600, 60, 1, keccak256("r"));
        bytes memory s = _sign(devKey, _winMsg(address(reg), alice, w));
        vm.prank(alice);
        vm.expectRevert(QorePqc.PqcPrecompileInactive.selector);
        reg.anchor(w, devKey, s);
        bytes memory k2 = _key(2);
        bytes memory m = _regMsg(address(reg), alice, keccak256("d2"), keccak256(k2), 1);
        bytes memory os = _sign(aliceKey, m);
        bytes memory ds = _sign(k2, m);
        vm.prank(alice);
        vm.expectRevert(QorePqc.PqcPrecompileInactive.selector);
        reg.registerDevice(keccak256("d2"), k2, os, ds);
        assertEq(reg.anchorCount(alice, DEV), 0);
        assertEq(reg.nonces(alice), 1);
    }

    // =============================================================== hostile pqcVerify

    /// Fail closed: for any answer bytes, verify returns true only if the first word is exactly 1,
    /// reverts on an answer shorter than 32 bytes, and reverts on a dirty bool.
    function testFuzz_verify_garbageAnswer(bytes memory answer, uint256 head, uint8 mode) public {
        mode %= 3;
        if (mode == 1) answer = bytes.concat(bytes32(head % 4), answer); // 0, 1, 2 or 3, then junk
        if (mode == 2) answer = bytes.concat(bytes32(head), answer); // any first word
        _hostile(PQC_VERIFY, answer, false);
        try h.verify(devKey, hex"00", hex"01") returns (bool valid) {
            assertGe(answer.length, 32, "short answer accepted");
            uint256 w0 = _word(answer, 0);
            assertLe(w0, 1, "dirty bool decoded");
            assertEq(valid, w0 == 1, "verify result differs from the answer");
        } catch (bytes memory err) {
            if (answer.length < 32) assertEq(err, abi.encodeWithSelector(QorePqc.PqcPrecompileInactive.selector));
            else assertGt(_word(answer, 0), 1, "reverted on a clean answer");
        }
    }

    /// Fail closed: a pqcVerify that reverts (any revert data) counts as an invalid signature.
    function testFuzz_verify_revertingPrecompileIsFalse(bytes memory data) public {
        _register(reg, alice, aliceKey, DEV, devKey);
        _hostile(PQC_VERIFY, data, true);
        assertFalse(h.verify(devKey, hex"00", hex"01"));
        AnchorRegistry.WindowClaim memory w = _claim(reg, alice, DEV, T0 - 600, 60, 1, keccak256("r"));
        bytes memory s = _sign(devKey, _winMsg(address(reg), alice, w));
        vm.prank(alice);
        vm.expectRevert(AnchorRegistry.BadSignature.selector);
        reg.anchor(w, devKey, s);
    }

    /// Fail closed: with a pqcVerify that answers anything but a clean `true`, no anchor is stored.
    function testFuzz_registry_garbageVerifyNeverAnchors(bytes memory answer) public {
        _register(reg, alice, aliceKey, DEV, devKey);
        vm.assume(answer.length < 32 || _word(answer, 0) != 1);
        _hostile(PQC_VERIFY, answer, false);
        AnchorRegistry.WindowClaim memory w = _claim(reg, alice, DEV, T0 - 600, 60, 1, keccak256("r"));
        bytes memory s = _sign(devKey, _winMsg(address(reg), alice, w));
        vm.prank(alice);
        (bool ok,) = address(reg).call(abi.encodeCall(AnchorRegistry.anchor, (w, devKey, s)));
        assertFalse(ok);
        assertEq(reg.anchorCount(alice, DEV), 0);
    }

    // =============================================================== pqcKeyStatus forms

    /// A3 (rogue key): the 3-, 4- and 5-value answers decode to the same fields, possessionProven is
    /// false for 3 values, and the registry accepts the owner key only when it is registered,
    /// ML-DSA-87 (alg 1), 2,592 bytes and (when required) possession-proven.
    function testFuzz_keyStatus_shapes(uint8 shape, bool registered, uint8 alg, uint16 len, bool pop, uint64 extra, bool requirePop)
        public
    {
        shape = uint8(3 + (shape % 3));
        if (alg % 2 == 0) alg = 1; // reach the accepted case often
        bytes memory key = _shapeKey(len, extra);
        bytes memory answer;
        if (shape == 3) answer = abi.encode(registered, alg, key);
        else if (shape == 4) answer = abi.encode(registered, alg, key, pop);
        else answer = abi.encode(registered, alg, key, pop, extra);
        _hostile(PQC_KEY_STATUS, answer, false);

        bool popSeen = shape == 3 ? false : pop;
        _checkDecoded(registered, alg, key, popSeen);
        _checkRegistry(key, registered && alg == 1 && key.length == KEY_LEN, !requirePop || popSeen, requirePop);
    }

    function _shapeKey(uint16 len, uint64 extra) internal pure returns (bytes memory key) {
        uint256 keyLen = len % 3 == 0 ? KEY_LEN : _bound(len, 0, 3000);
        key = new bytes(keyLen);
        if (keyLen >= 32) {
            bytes32 fill = keccak256(abi.encode(len, extra));
            assembly {
                mstore(add(key, 0x20), fill)
            }
        }
    }

    function _checkDecoded(bool registered, uint8 alg, bytes memory key, bool popSeen) internal view {
        (bool r, uint8 a, bytes memory k, bool p) = h.keyStatus(alice);
        assertEq(r, registered);
        assertEq(a, alg);
        assertEq(k, key);
        assertEq(p, popSeen, "possessionProven");
    }

    function _checkRegistry(bytes memory key, bool keyOk, bool popOk, bool requirePop) internal {
        AnchorRegistry r2 = new AnchorRegistry(requirePop);
        bytes memory m = _regMsg(address(r2), alice, DEV, keccak256(devKey), 0);
        bytes memory os = _sign(key, m);
        bytes memory ds = _sign(devKey, m);
        if (!keyOk) vm.expectRevert(abi.encodeWithSelector(DeviceRegistry.NoPqcKey.selector, alice));
        else if (!popOk) vm.expectRevert(abi.encodeWithSelector(DeviceRegistry.PossessionNotProven.selector, alice));
        vm.prank(alice);
        r2.registerDevice(DEV, devKey, os, ds);
        assertEq(r2.nonces(alice), keyOk && popOk ? 1 : 0);
    }

    /// Fail closed: for any answer bytes, keyStatus reverts on less than 96 bytes, reports
    /// registered only for a first word of exactly 1, an algorithm that fits uint8, and
    /// possessionProven only when the bytes offset says 4 or more values.
    function testFuzz_keyStatus_garbageAnswer(bytes memory answer, uint256 pos, uint8 mode) public {
        mode %= 3;
        if (mode == 1) {
            // a valid 4-value answer with one byte changed
            answer = abi.encode(true, uint8(1), aliceKey, true);
            uint256 i = pos % answer.length;
            answer[i] = bytes1(uint8(answer[i]) ^ uint8(1 + (pos >> 128) % 255));
        } else if (mode == 2) {
            answer = bytes.concat(abi.encode(uint256(pos % 3), uint256(1), uint256(0x60 + 0x20 * ((pos >> 8) % 3))), answer);
        }
        _hostile(PQC_KEY_STATUS, answer, false);
        try h.keyStatus(alice) returns (bool r, uint8 a, bytes memory k, bool p) {
            assertGe(answer.length, 96, "short answer accepted");
            if (r) assertEq(_word(answer, 0), 1, "registered from a dirty bool");
            assertEq(uint256(a), _word(answer, 1), "algorithm id");
            if (p) assertGe(_word(answer, 2), 0x80, "possessionProven read from a 3-value answer");
            // the registry accepts the owner key only for a well-formed, ML-DSA-87, proven key
            bytes memory m = _regMsg(address(reg), alice, DEV, keccak256(devKey), 0);
            bytes memory os = _sign(k, m);
            bytes memory ds = _sign(devKey, m);
            vm.prank(alice);
            (bool ok,) = address(reg).call(abi.encodeCall(DeviceRegistry.registerDevice, (DEV, devKey, os, ds)));
            assertEq(ok, r && a == 1 && k.length == KEY_LEN && p, "registry disagrees with the decoded key status");
        } catch (bytes memory err) {
            if (answer.length < 96) assertEq(err, abi.encodeWithSelector(QorePqc.PqcPrecompileInactive.selector));
            assertEq(reg.nonces(alice), 0);
        }
    }

    /// Fail closed: a pqcKeyStatus that reverts reports no key, so no owner action passes.
    function testFuzz_keyStatus_revertingPrecompileIsNoKey(bytes memory data) public {
        _hostile(PQC_KEY_STATUS, data, true);
        (bool r, uint8 a, bytes memory k, bool p) = h.keyStatus(alice);
        assertFalse(r);
        assertEq(a, 0);
        assertEq(k.length, 0);
        assertFalse(p);
        bytes memory m = _regMsg(address(reg), alice, DEV, keccak256(devKey), 0);
        bytes memory os = _sign(aliceKey, m);
        bytes memory ds = _sign(devKey, m);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DeviceRegistry.NoPqcKey.selector, alice));
        reg.registerDevice(DEV, devKey, os, ds);
    }
}
