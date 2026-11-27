// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {AnchorRegistry} from "../../../contracts/AnchorRegistry.sol";
import {DeviceRegistry} from "../../../contracts/DeviceRegistry.sol";
import {
    MockPqcVerify, MockPqcKeyStatus3, MockPqcKeyStatus4, MockPqcKeyStatus5
} from "../../../contracts/test/PqcMocks.sol";

/// @notice Shared setup for the Solidity tests.
/// @dev Test boundary: the simulated chain has no QoreChain precompiles.
///      The tests place contracts/test/PqcMocks.sol at 0x0A01 and 0x0A02 with vm.etch.
///      MockPqcVerify accepts exactly one "signature" per (key, message):
///      abi.encodePacked(keccak256(pubkey), keccak256(message)). That binds a signature
///      to its key and its message, which is what the registry logic depends on, so
///      fuzzing the registry against it is meaningful. These tests do NOT verify real
///      ML-DSA-87. Real ML-DSA-87 is checked against the live testnet precompile by
///      `pnpm probe:pqc` (scripts/probe-pqc.ts) and by every live anchor on registry v4.
/// @notice Constants, stand-in keys, mock signatures and reference messages. Used by the tests and the invariant handler.
/// @dev The message builders follow src/core/message.ts and docs/SPEC.md. They do not call the
///      contract, so a change of the signed bytes in the contract makes the tests fail.
abstract contract PqcHelpers is CommonBase {
    address internal constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address internal constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;
    uint256 internal constant KEY_LEN = 2592; // ML-DSA-87 public key
    uint256 internal constant SIG_LEN = 4627; // ML-DSA-87 signature

    /// @dev A distinct 2,592-byte stand-in for an ML-DSA-87 public key.
    function _key(uint256 seed) internal pure returns (bytes memory k) {
        k = new bytes(KEY_LEN);
        bytes32 a = keccak256(abi.encode("qw-test-key-head", seed));
        bytes32 b = keccak256(abi.encode("qw-test-key-tail", seed));
        assembly {
            mstore(add(k, 0x20), a)
            mstore(add(k, KEY_LEN), b) // last 32 bytes of the key
        }
    }

    /// @dev The only signature MockPqcVerify accepts for (pubkey, message).
    function _sign(bytes memory pubkey, bytes memory message) internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256(pubkey), keccak256(message));
    }

    function _regMsg(address registry, address owner, bytes32 id, bytes32 keyHash, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            keccak256("QoreWitness/DeviceRegistry/register/v1"), block.chainid, registry, owner, id, keyHash, nonce
        );
    }

    function _revMsg(address registry, address owner, bytes32 id, uint256 nonce) internal view returns (bytes memory) {
        return abi.encodePacked(
            keccak256("QoreWitness/DeviceRegistry/revoke/v1"), block.chainid, registry, owner, id, nonce
        );
    }

    function _rotMsg(address registry, address owner, bytes32 id, bytes32 oldKh, bytes32 newKh, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            keccak256("QoreWitness/DeviceRegistry/rotate/v1"), block.chainid, registry, owner, id, oldKh, newKh, nonce
        );
    }

    function _winMsg(address registry, address owner, AnchorRegistry.WindowClaim memory w)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            abi.encodePacked(keccak256("QoreWitness/AnchorRegistry/v3"), block.chainid, registry, owner, w.deviceId),
            abi.encodePacked(
                w.windowStart, w.windowSeconds, w.leafCount, w.root, w.prevRoot, w.refBlock, w.refBlockHash
            )
        );
    }

}

abstract contract PqcFixture is PqcHelpers, Test {

    /// @dev Puts the verify mock and one key-status mock (3, 4 or 5 return values) at the precompile addresses.
    function _installMocks(uint8 statusShape) internal {
        vm.etch(PQC_VERIFY, address(new MockPqcVerify()).code);
        if (statusShape == 3) vm.etch(PQC_KEY_STATUS, address(new MockPqcKeyStatus3()).code);
        else if (statusShape == 5) vm.etch(PQC_KEY_STATUS, address(new MockPqcKeyStatus5()).code);
        else vm.etch(PQC_KEY_STATUS, address(new MockPqcKeyStatus4()).code);
    }

    /// @dev Storage setup of the key-status mock: the chain's PQC key of `account`.
    ///      All three mocks share setKey(address,bytes,bool) and the storage layout of `keys`.
    function _setOwnerKey(address account, bytes memory pubkey, bool possessionProven) internal {
        MockPqcKeyStatus4(PQC_KEY_STATUS).setKey(account, pubkey, possessionProven);
    }

    /// @dev A signature that differs from `valid`. Five shapes: arbitrary bytes, one bit flipped,
    ///      truncated (down to empty), extended, and a full-length 4,627-byte blob.
    function _otherSig(bytes memory valid, uint256 mode, uint256 pos, bytes memory junk)
        internal
        pure
        returns (bytes memory s)
    {
        mode %= 5;
        if (mode == 0) {
            s = junk;
        } else if (mode == 1) {
            s = bytes.concat(valid);
            uint256 bit = pos % (s.length * 8);
            s[bit / 8] = bytes1(uint8(s[bit / 8]) ^ uint8(1 << (bit % 8)));
        } else if (mode == 2) {
            uint256 n = pos % valid.length;
            s = new bytes(n);
            for (uint256 i = 0; i < n; i++) s[i] = valid[i];
        } else if (mode == 3) {
            s = bytes.concat(valid, junk.length == 0 ? bytes(hex"00") : junk);
        } else {
            s = new bytes(SIG_LEN);
            bytes32 fill = keccak256(abi.encode(junk, pos));
            assembly {
                mstore(add(s, 0x20), fill)
            }
        }
    }
}

/// @notice A registry with possession proof required (as deployed for v4), two owners with
///         chain PQC keys, and message builders written independently of the contract.
abstract contract RegistryFixture is PqcFixture {
    uint64 internal constant T0 = 1_800_000_000; // start time of every test
    uint256 internal constant B0 = 1_000; // start block of every test

    AnchorRegistry internal reg;
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    bytes internal aliceKey;
    bytes internal bobKey;
    bytes internal devKey;
    bytes32 internal constant DEV = keccak256("front-door");

    function setUp() public virtual {
        vm.warp(T0);
        vm.roll(B0);
        _installMocks(4);
        reg = new AnchorRegistry(true);
        aliceKey = _key(1_001);
        bobKey = _key(1_002);
        devKey = _key(1);
        _setOwnerKey(alice, aliceKey, true);
        _setOwnerKey(bob, bobKey, true);
    }

    // ------------------------------------------------ correctly signed actions

    function _register(AnchorRegistry r, address owner, bytes memory ownerKey, bytes32 id, bytes memory key) internal {
        bytes memory m = _regMsg(address(r), owner, id, keccak256(key), r.nonces(owner));
        bytes memory os = _sign(ownerKey, m);
        bytes memory ds = _sign(key, m);
        vm.prank(owner);
        r.registerDevice(id, key, os, ds);
    }

    function _revoke(AnchorRegistry r, address owner, bytes memory ownerKey, bytes32 id) internal {
        bytes memory s = _sign(ownerKey, _revMsg(address(r), owner, id, r.nonces(owner)));
        vm.prank(owner);
        r.revokeDevice(id, s);
    }

    function _rotate(AnchorRegistry r, address owner, bytes32 id, bytes memory oldKey, bytes memory newKey) internal {
        bytes memory m = _rotMsg(address(r), owner, id, keccak256(oldKey), keccak256(newKey), r.nonces(owner));
        bytes memory so = _sign(oldKey, m);
        bytes memory sn = _sign(newKey, m);
        vm.prank(owner);
        r.rotateDeviceKey(id, oldKey, newKey, so, sn);
    }

    /// @dev A window claim that passes every rule: linked to the chain head, refBlock = previous block.
    function _claim(AnchorRegistry r, address owner, bytes32 id, uint64 start, uint32 secs, uint32 leaves, bytes32 root)
        internal
        view
        returns (AnchorRegistry.WindowClaim memory w)
    {
        uint64 refBlock = uint64(block.number - 1);
        bytes32 h = blockhash(refBlock);
        if (h == bytes32(0)) h = keccak256(abi.encode("ref", refBlock));
        w = AnchorRegistry.WindowClaim({
            deviceId: id,
            windowStart: start,
            windowSeconds: secs,
            leafCount: leaves,
            root: root,
            prevRoot: r.chainHead(owner, id),
            refBlock: refBlock,
            refBlockHash: h
        });
    }

    function _anchor(AnchorRegistry r, address owner, AnchorRegistry.WindowClaim memory w, bytes memory key)
        internal
        returns (bytes32 id)
    {
        bytes memory s = _sign(key, _winMsg(address(r), owner, w));
        vm.prank(owner);
        id = r.anchor(w, key, s);
    }

    // ------------------------------------------------ state digests

    /// @dev Everything the registry stores about one (owner, device), plus the owner's nonce.
    function _digest(AnchorRegistry r, address owner, bytes32 id) internal view returns (bytes32) {
        DeviceRegistry.Device memory d = r.getDevice(owner, id);
        return keccak256(
            abi.encode(
                d, r.nonces(owner), r.anchorCount(owner, id), r.chainHead(owner, id), r.nextWindowStart(owner, id)
            )
        );
    }
}
