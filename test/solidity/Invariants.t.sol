// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {console} from "forge-std/console.sol";
import {PqcFixture, PqcHelpers} from "./utils/Fixture.sol";
import {AnchorRegistry} from "../../contracts/AnchorRegistry.sol";
import {DeviceRegistry} from "../../contracts/DeviceRegistry.sol";

/// @notice Invariant handler: drives one AnchorRegistry with correctly signed owner and device
///         actions, attacker actions (forged, replayed, wrong sender, revoked device) and time and
///         block movement. Keeps ghost state computed without reading the contract's own records.
/// @dev Signatures come from MockPqcVerify at 0x0A01 (see utils/Fixture.sol). Not real ML-DSA-87.
///      The handler lives in this file on purpose: with Hardhat 3.21 a handler in a separate helper
///      file that makes external calls was not picked up as a fuzz target ("No contracts to fuzz").
contract RegistryHandler is PqcHelpers, StdUtils {
    uint256 public constant OWNERS = 3;
    uint256 public constant DEVICES = 4; // device ids per owner
    uint64 internal constant SKEW = 120;

    AnchorRegistry public reg;
    address[OWNERS] public owners;
    bytes[OWNERS] internal ownerKeys;
    address public constant ATTACKER = address(0xBAD);
    bytes internal attackerKey;

    struct GhostDevice {
        uint8 status; // 0 none, 1 active, 2 revoked
        uint256 keySeed; // current key = _key(keySeed); seeds keep the 2,592-byte keys out of storage
        uint256 prevKeySeed; // key before the last rotation, 0 if none
        uint32 version;
        uint256 rotations;
        uint64 revokedAt;
        uint256 countAtRevoke;
        uint64 nextStart; // end of the last window
        bytes32 head;
        bytes32[] anchorIds;
    }

    mapping(uint256 => mapping(uint256 => GhostDevice)) internal _g; // owner index => device index
    mapping(bytes32 => AnchorRegistry.Anchor) internal _ghostAnchor;
    uint256[OWNERS] public ghostNonce;
    uint256[OWNERS] public ownerActions; // successful register + revoke + rotate per owner

    // replay pool: every successful call, with its sender
    address[] internal _pastSender;
    bytes[] internal _pastCall;
    uint256[] internal _pastOwnerDevice; // owner index * DEVICES + device index

    // monotonic watch
    mapping(uint256 => mapping(uint256 => uint64)) internal _seenNextStart;
    mapping(uint256 => mapping(uint256 => uint32)) internal _seenVersion;
    uint256[OWNERS] internal _seenNonce;

    // findings (must stay zero / false)
    uint256 public forgedAccepted; // attacker or replayed call that succeeded
    uint256 public validRejected; // correctly signed, in-rules call that reverted
    uint256 public monotonicBroken; // nextWindowStart, keyVersion or nonce went down

    // reach metrics
    enum A {
        Register,
        Rotate,
        Revoke,
        Anchor,
        Time,
        ForgedAnchor,
        ForgedOwner,
        Replay,
        RevokedAnchor
    }

    uint256[9] public calls;
    uint256[9] public done; // valid action succeeded, or attack really attempted (and refused)
    uint256 internal _keyCounter = 10_000;

    constructor(AnchorRegistry reg_) {
        reg = reg_;
        attackerKey = _key(666);
        for (uint256 i = 0; i < OWNERS; i++) {
            owners[i] = address(uint160(0x1000 + i));
            ownerKeys[i] = _key(500 + i);
        }
    }

    function ownerKey(uint256 i) external view returns (bytes memory) {
        return ownerKeys[i];
    }

    function deviceId(uint256 d) public pure returns (bytes32) {
        return keccak256(abi.encode("qw-device", d));
    }

    // ================================================================ ghost views for the invariants

    function ghostDevice(uint256 o, uint256 d)
        external
        view
        returns (uint8 status, bytes32 keyHash, uint32 version, uint256 rotations, uint64 revokedAt, uint256 countAtRevoke, uint64 nextStart, bytes32 head)
    {
        GhostDevice storage g = _g[o][d];
        return (g.status, g.keySeed == 0 ? bytes32(0) : keccak256(_key(g.keySeed)), g.version, g.rotations, g.revokedAt, g.countAtRevoke, g.nextStart, g.head);
    }

    function ghostAnchorIds(uint256 o, uint256 d) external view returns (bytes32[] memory) {
        return _g[o][d].anchorIds;
    }

    function ghostAnchor(bytes32 id) external view returns (AnchorRegistry.Anchor memory) {
        return _ghostAnchor[id];
    }

    function totals() external view returns (uint256 anchors, uint256 rotations, uint256 revocations, uint256 registrations) {
        return (done[uint256(A.Anchor)], done[uint256(A.Rotate)], done[uint256(A.Revoke)], done[uint256(A.Register)]);
    }

    // ================================================================ helpers

    function _pick(uint256 o, uint256 d, uint8 status) internal view returns (bool found, uint256 oi, uint256 di) {
        oi = o % OWNERS;
        for (uint256 k = 0; k < DEVICES; k++) {
            di = (d + k) % DEVICES;
            if (_g[oi][di].status == status) return (true, oi, di);
        }
    }

    function _call(address sender, bytes memory data) internal returns (bool ok) {
        vm.prank(sender);
        (ok,) = address(reg).call(data);
    }

    function _valid(A a, address sender, bytes memory data, uint256 o, uint256 d) internal returns (bool ok) {
        ok = _call(sender, data);
        if (!ok) {
            validRejected++;
        } else {
            done[uint256(a)]++;
            _pastSender.push(sender);
            _pastCall.push(data);
            _pastOwnerDevice.push(o * DEVICES + d);
        }
        _watch(o, d);
    }

    /// @dev An attack must revert. A reverted call cannot change state, and any accepted attack is
    ///      counted here; the ghost comparisons in the invariants would also see its effect.
    function _attack(A a, address sender, bytes memory data, uint256 o, uint256 d) internal {
        bool ok = _call(sender, data);
        if (ok) forgedAccepted++;
        done[uint256(a)]++;
        _watch(o, d);
    }

    /// @dev Records any decrease of nextWindowStart, keyVersion or nonce of the device and owner a call
    ///      touched. (The invariants also compare every device with the ghost after every call, and the
    ///      ghost only grows, so a decrease anywhere else would fail them too.)
    function _watch(uint256 o, uint256 d) internal {
        uint256 n = reg.nonces(owners[o]);
        uint64 ns = reg.nextWindowStart(owners[o], deviceId(d));
        uint32 v = reg.getDevice(owners[o], deviceId(d)).keyVersion;
        if (n < _seenNonce[o] || ns < _seenNextStart[o][d] || v < _seenVersion[o][d]) monotonicBroken++;
        _seenNonce[o] = n;
        _seenNextStart[o][d] = ns;
        _seenVersion[o][d] = v;
    }

    function _activeCount(uint256 oi) internal view returns (uint256 c) {
        for (uint256 d = 0; d < DEVICES; d++) if (_g[oi][d].status == 1) c++;
    }

    // ================================================================ valid actions

    function register(uint256 o, uint256 d) external {
        calls[uint256(A.Register)]++;
        (bool found, uint256 oi, uint256 di) = _pick(o, d, 0);
        if (!found) return;
        address owner = owners[oi];
        uint256 seed = ++_keyCounter;
        bytes memory key = _key(seed);
        bytes memory m = _regMsg(address(reg), owner, deviceId(di), keccak256(key), ghostNonce[oi]);
        bytes memory data = abi.encodeCall(
            DeviceRegistry.registerDevice, (deviceId(di), key, _sign(ownerKeys[oi], m), _sign(key, m))
        );
        if (_valid(A.Register, owner, data, oi, di)) {
            GhostDevice storage g = _g[oi][di];
            g.status = 1;
            g.keySeed = seed;
            g.version = 1;
            ghostNonce[oi]++;
            ownerActions[oi]++;
        }
    }

    function rotate(uint256 o, uint256 d) external {
        calls[uint256(A.Rotate)]++;
        (bool found, uint256 oi, uint256 di) = _pick(o, d, 1);
        if (!found) return;
        address owner = owners[oi];
        GhostDevice storage g = _g[oi][di];
        uint256 seed = ++_keyCounter;
        bytes memory oldKey = _key(g.keySeed);
        bytes memory newKey = _key(seed);
        bytes memory m = _rotMsg(address(reg), owner, deviceId(di), keccak256(oldKey), keccak256(newKey), ghostNonce[oi]);
        bytes memory data = abi.encodeCall(
            DeviceRegistry.rotateDeviceKey, (deviceId(di), oldKey, newKey, _sign(oldKey, m), _sign(newKey, m))
        );
        if (_valid(A.Rotate, owner, data, oi, di)) {
            g.prevKeySeed = g.keySeed;
            g.keySeed = seed;
            g.version++;
            g.rotations++;
            ghostNonce[oi]++;
            ownerActions[oi]++;
        }
    }

    /// @dev Never revokes the last active device of an owner, so anchoring stays reachable.
    function revoke(uint256 o, uint256 d) external {
        calls[uint256(A.Revoke)]++;
        (bool found, uint256 oi, uint256 di) = _pick(o, d, 1);
        if (!found || _activeCount(oi) < 2) return;
        address owner = owners[oi];
        bytes memory s = _sign(ownerKeys[oi], _revMsg(address(reg), owner, deviceId(di), ghostNonce[oi]));
        if (_valid(A.Revoke, owner, abi.encodeCall(DeviceRegistry.revokeDevice, (deviceId(di), s)), oi, di)) {
            GhostDevice storage g = _g[oi][di];
            g.status = 2;
            g.revokedAt = uint64(block.timestamp);
            g.countAtRevoke = g.anchorIds.length;
            ghostNonce[oi]++;
            ownerActions[oi]++;
        }
    }

    /// @dev Builds a claim that follows every rule for an active device. Moves time forward when
    ///      the window would end too far ahead, and moves one block so refBlock is the previous block.
    /// @param seed Gap (bits 0..63), window length (bits 64..127) and leaf count (bits 128..191).
    function _validClaim(uint256 oi, uint256 di, uint256 seed, bytes32 root, bool setHash)
        internal
        returns (AnchorRegistry.WindowClaim memory w)
    {
        GhostDevice storage g = _g[oi][di];
        uint256 gap = uint64(seed);
        uint32 s = uint32(_bound(uint64(seed >> 64), 1, 3_600));
        uint64 start;
        if (g.anchorIds.length == 0) {
            start = uint64(block.timestamp) - uint64(_bound(gap, s, 2 days));
        } else {
            uint64 gp = gap % 3 == 0 ? 0 : uint64(_bound(gap, 1, 6 hours)); // contiguous a third of the time
            start = g.nextStart + gp;
        }
        if (start + s > uint64(block.timestamp) + SKEW) vm.warp(start + s); // time moves on, as in real life
        vm.roll(block.number + 1);
        uint64 ref = uint64(block.number - 1);
        bytes32 h = blockhash(ref);
        if (setHash || h == bytes32(0)) {
            h = keccak256(abi.encode("hash", ref, root));
            vm.setBlockhash(ref, h); // the EVM now knows this hash, so the contract compares it
        }
        w = AnchorRegistry.WindowClaim({
            deviceId: deviceId(di),
            windowStart: start,
            windowSeconds: s,
            leafCount: uint32(_bound(uint64(seed >> 128), 1, 1_000)),
            root: root,
            prevRoot: g.head,
            refBlock: ref,
            refBlockHash: h
        });
    }

    /// @dev Anchors 1 to 3 consecutive windows of one active device, as a camera does every few minutes.
    function anchor(uint256 o, uint256 d, uint256 seed, bytes32 root) external {
        calls[uint256(A.Anchor)]++;
        (bool found, uint256 oi, uint256 di) = _pick(o, d, 1);
        if (!found) return;
        uint256 n = 1 + uint256(keccak256(abi.encode(seed))) % 3;
        for (uint256 i = 0; i < n; i++) {
            _anchorOne(oi, di, uint256(keccak256(abi.encode(seed, i))), keccak256(abi.encode(root, i)));
        }
    }

    function _anchorOne(uint256 oi, uint256 di, uint256 seed, bytes32 root) internal {
        address owner = owners[oi];
        GhostDevice storage g = _g[oi][di];
        AnchorRegistry.WindowClaim memory w = _validClaim(oi, di, seed, root, (seed >> 200) % 2 == 0);
        bytes memory key = _key(g.keySeed);
        bytes memory sig = _sign(key, _winMsg(address(reg), owner, w));
        if (_valid(A.Anchor, owner, abi.encodeCall(AnchorRegistry.anchor, (w, key, sig)), oi, di)) {
            bytes32 id = keccak256(abi.encode(owner, w.deviceId, w.windowStart));
            uint64 gp = g.anchorIds.length == 0 ? 0 : w.windowStart - g.nextStart;
            _ghostAnchor[id] = AnchorRegistry.Anchor({
                root: w.root,
                sigHash: keccak256(sig),
                deviceKeyHash: keccak256(key),
                prevRoot: w.prevRoot,
                owner: owner,
                deviceKeyVersion: g.version,
                windowStart: w.windowStart,
                windowSeconds: w.windowSeconds,
                leafCount: w.leafCount,
                anchoredAt: uint64(block.timestamp),
                blockNumber: uint64(block.number),
                refBlock: w.refBlock,
                gapBefore: gp
            });
            g.anchorIds.push(id);
            g.nextStart = w.windowStart + w.windowSeconds;
            g.head = w.root;
        }
    }

    function moveTime(uint256 dt, uint256 db) external {
        calls[uint256(A.Time)]++;
        vm.warp(block.timestamp + _bound(dt, 0, 1 days));
        vm.roll(block.number + _bound(db, 0, 400));
        done[uint256(A.Time)]++;
    }

    // ================================================================ attacker actions (must all fail)

    /// A3: a claim that follows every rule but carries a wrong signature, or comes from the wrong sender.
    /// Modes 7 and 8: a correctly signed claim (the device key holder, A4) that forks the chain or
    /// backdates into the previous window.
    function forgedAnchor(uint256 o, uint256 d, uint256 mode, bytes32 root) external {
        calls[uint256(A.ForgedAnchor)]++;
        (bool found, uint256 oi, uint256 di) = _pick(o, d, 1);
        if (!found) return;
        AnchorRegistry.WindowClaim memory w = _validClaim(oi, di, mode, root, false);
        mode %= 9;
        if (mode >= 7 && _g[oi][di].anchorIds.length == 0) mode = 0;
        (address sender, bytes memory key, bytes memory sig) = _forgery(oi, di, w, mode, root);
        _attack(A.ForgedAnchor, sender, abi.encodeCall(AnchorRegistry.anchor, (w, key, sig)), oi, di);
    }

    /// @dev Turns a valid claim into one forgery. May change `w` (modes 7 and 8).
    function _forgery(uint256 oi, uint256 di, AnchorRegistry.WindowClaim memory w, uint256 mode, bytes32 root)
        internal
        view
        returns (address sender, bytes memory key, bytes memory sig)
    {
        sender = owners[oi];
        key = _key(_g[oi][di].keySeed);
        bytes memory signKey = key;
        address signFor = sender;
        if (mode == 7) {
            // A1/A4: the device key itself signs a fork of its chain (prevRoot is not the head)
            w.prevRoot = keccak256(abi.encode(w.prevRoot, root));
        } else if (mode == 8) {
            // A2/A4: the device key itself signs a backdated window that overlaps the last one
            w.windowStart = _g[oi][di].nextStart - 1;
        } else if (mode == 0) {
            signKey = ownerKeys[oi]; // owner key, not device key
        } else if (mode == 1) {
            signKey = attackerKey; // unknown key
        } else if (mode == 2) {
            // rotated-out key (an unrelated key when the device was never rotated)
            signKey = _key(_g[oi][di].prevKeySeed == 0 ? 777 : _g[oi][di].prevKeySeed);
        } else if (mode == 3) {
            signFor = owners[(oi + 1) % OWNERS]; // signed for another owner
        } else if (mode == 5) {
            sender = ATTACKER; // valid signature, sent by the attacker account
        } else if (mode == 6) {
            key = attackerKey; // attacker key presented as the device key
            signKey = attackerKey;
        }
        sig = _sign(signKey, _winMsg(address(reg), signFor, w));
        if (mode == 4) sig = bytes.concat(sig, hex"00"); // valid signature plus one byte
    }

    /// A3: forged owner actions: wrong key, wrong nonce, wrong sender, rotation to an attacker key.
    function forgedOwnerAction(uint256 o, uint256 d, uint256 mode) external {
        calls[uint256(A.ForgedOwner)]++;
        (bool found, uint256 oi, uint256 di) = _pick(o, d, 1);
        if (!found) return;
        address owner = owners[oi];
        bytes32 id = deviceId(di);
        GhostDevice storage g = _g[oi][di];
        uint256 n = ghostNonce[oi];
        mode %= 7;
        bytes memory data;
        address sender = owner;
        if (mode == 0) {
            // revoke signed by the device key instead of the owner key
            data = abi.encodeCall(DeviceRegistry.revokeDevice, (id, _sign(_key(g.keySeed), _revMsg(address(reg), owner, id, n))));
        } else if (mode == 1) {
            // revoke signed for a future nonce (pre-signed and stolen)
            data = abi.encodeCall(DeviceRegistry.revokeDevice, (id, _sign(ownerKeys[oi], _revMsg(address(reg), owner, id, n + 1))));
        } else if (mode == 2) {
            // valid revoke signature, sent by the attacker
            data = abi.encodeCall(DeviceRegistry.revokeDevice, (id, _sign(ownerKeys[oi], _revMsg(address(reg), owner, id, n))));
            sender = ATTACKER;
        } else if (mode == 3) {
            // rotation to an attacker key, signed by the attacker key only
            bytes memory cur = _key(g.keySeed);
            bytes memory m = _rotMsg(address(reg), owner, id, keccak256(cur), keccak256(attackerKey), n);
            data = abi.encodeCall(DeviceRegistry.rotateDeviceKey, (id, cur, attackerKey, _sign(attackerKey, m), _sign(attackerKey, m)));
        } else if (mode == 4) {
            // rotation that presents the attacker key as the old key
            bytes memory m = _rotMsg(address(reg), owner, id, keccak256(attackerKey), keccak256(_key(667)), n);
            data = abi.encodeCall(DeviceRegistry.rotateDeviceKey, (id, attackerKey, _key(667), _sign(attackerKey, m), _sign(_key(667), m)));
        } else if (mode == 5) {
            // register an attacker device in the owner's name, owner signature by the attacker key
            bytes32 nid = deviceId(DEVICES + 1);
            bytes memory m = _regMsg(address(reg), owner, nid, keccak256(attackerKey), n);
            data = abi.encodeCall(DeviceRegistry.registerDevice, (nid, attackerKey, _sign(attackerKey, m), _sign(attackerKey, m)));
        } else {
            // the attacker registers a device in its own name: it has no chain PQC key
            bytes32 nid = deviceId(DEVICES + 2);
            bytes memory m = _regMsg(address(reg), ATTACKER, nid, keccak256(attackerKey), 0);
            data = abi.encodeCall(DeviceRegistry.registerDevice, (nid, attackerKey, _sign(attackerKey, m), _sign(attackerKey, m)));
            sender = ATTACKER;
        }
        _attack(A.ForgedOwner, sender, data, oi, di);
    }

    /// A1/A3: replays any earlier successful call (register, rotate, revoke or anchor) unchanged.
    function replay(uint256 pick) external {
        calls[uint256(A.Replay)]++;
        if (_pastCall.length == 0) return;
        uint256 i = pick % _pastCall.length;
        _attack(A.Replay, _pastSender[i], _pastCall[i], _pastOwnerDevice[i] / DEVICES, _pastOwnerDevice[i] % DEVICES);
    }

    /// A4: a revoked device (or, while none is revoked, a never registered one), correctly signed
    /// claim with its last key: never anchored.
    function revokedAnchor(uint256 o, uint256 d, bytes32 root) external {
        calls[uint256(A.RevokedAnchor)]++;
        (bool found, uint256 oi, uint256 di) = _pick(o, d, 2);
        if (!found) (found, oi, di) = _pick(o, d, 0);
        if (!found) return;
        address owner = owners[oi];
        GhostDevice storage g = _g[oi][di];
        bytes memory key = g.keySeed != 0 ? _key(g.keySeed) : _key(uint256(root));
        AnchorRegistry.WindowClaim memory w = _validClaim(oi, di, uint256(root), root, false);
        bytes memory sig = _sign(key, _winMsg(address(reg), owner, w));
        _attack(A.RevokedAnchor, owner, abi.encodeCall(AnchorRegistry.anchor, (w, key, sig)), oi, di);
    }
}

/// @notice Stateful invariant tests of AnchorRegistry (with DeviceRegistry) through RegistryHandler:
///         3 owners x 4 devices, register / rotate / revoke / anchor with valid signatures, attacker
///         actions with forged or replayed signatures, and time and block movement.
/// @dev Signatures come from MockPqcVerify (see utils/Fixture.sol). Not real ML-DSA-87.
abstract contract RegistryInvariantBase is StdInvariant, PqcFixture {
    AnchorRegistry internal reg;
    RegistryHandler internal handler;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        vm.roll(1_000);
        _installMocks(4);
        reg = new AnchorRegistry(true);
        handler = new RegistryHandler(reg);
        for (uint256 i = 0; i < handler.OWNERS(); i++) _setOwnerKey(handler.owners(i), handler.ownerKey(i), true);
        // one device per owner to start with, so every action is reachable from the first call
        for (uint256 i = 0; i < handler.OWNERS(); i++) handler.register(i, 0);

        bytes4[] memory sel = new bytes4[](9);
        sel[0] = RegistryHandler.register.selector;
        sel[1] = RegistryHandler.rotate.selector;
        sel[2] = RegistryHandler.revoke.selector;
        sel[3] = RegistryHandler.anchor.selector;
        sel[4] = RegistryHandler.moveTime.selector;
        sel[5] = RegistryHandler.forgedAnchor.selector;
        sel[6] = RegistryHandler.forgedOwnerAction.selector;
        sel[7] = RegistryHandler.replay.selector;
        sel[8] = RegistryHandler.revokedAnchor.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    // ================================================================ chain of windows

    /// A1 (dropped, replaced or re-recorded window): chainHead is the root of the last stored anchor,
    /// every anchor's prevRoot is the root of the one before (0 for the first), anchorCount = ghost count.
    function _check_hashChainIntact() internal view {
        for (uint256 o = 0; o < handler.OWNERS(); o++) {
            address owner = handler.owners(o);
            for (uint256 d = 0; d < handler.DEVICES(); d++) {
                bytes32 id = handler.deviceId(d);
                bytes32[] memory ids = handler.ghostAnchorIds(o, d);
                assertEq(reg.anchorCount(owner, id), ids.length, "anchorCount");
                bytes32 prev = bytes32(0);
                for (uint256 k = 0; k < ids.length; k++) {
                    AnchorRegistry.Anchor memory a = reg.getAnchor(ids[k]);
                    assertEq(a.prevRoot, prev, "prevRoot is not the previous root");
                    prev = a.root;
                }
                assertEq(reg.chainHead(owner, id), prev, "chainHead is not the last root");
                (,,,,,,, bytes32 head) = handler.ghostDevice(o, d);
                assertEq(reg.chainHead(owner, id), head, "chainHead differs from ghost");
            }
        }
    }

    /// A1/A6: every anchor ever stored reads back identical, field by field, to what was anchored,
    /// including the device key hash and key version at anchor time.
    function _check_anchorsImmutable() internal view {
        for (uint256 o = 0; o < handler.OWNERS(); o++) {
            for (uint256 d = 0; d < handler.DEVICES(); d++) {
                bytes32[] memory ids = handler.ghostAnchorIds(o, d);
                for (uint256 k = 0; k < ids.length; k++) {
                    AnchorRegistry.Anchor memory a = reg.getAnchor(ids[k]);
                    AnchorRegistry.Anchor memory e = handler.ghostAnchor(ids[k]);
                    assertEq(keccak256(abi.encode(a)), keccak256(abi.encode(e)), "stored anchor changed");
                    assertEq(a.deviceKeyHash, e.deviceKeyHash, "deviceKeyHash");
                    assertEq(a.deviceKeyVersion, e.deviceKeyVersion, "deviceKeyVersion");
                }
            }
        }
    }

    /// A2: windows of a device never overlap, nextWindowStart is the end of the last window,
    /// and gapBefore is the true gap to the previous window (0 for the first).
    function _check_windowsOrderedAndGapsTrue() internal view {
        for (uint256 o = 0; o < handler.OWNERS(); o++) {
            address owner = handler.owners(o);
            for (uint256 d = 0; d < handler.DEVICES(); d++) {
                bytes32[] memory ids = handler.ghostAnchorIds(o, d);
                uint64 end = 0;
                for (uint256 k = 0; k < ids.length; k++) {
                    AnchorRegistry.Anchor memory a = reg.getAnchor(ids[k]);
                    if (k == 0) {
                        assertEq(a.gapBefore, 0, "first window has a gap");
                    } else {
                        assertGe(a.windowStart, end, "windows overlap");
                        assertEq(a.gapBefore, a.windowStart - end, "gapBefore");
                    }
                    assertGt(a.windowSeconds, 0);
                    assertLe(a.windowSeconds, reg.MAX_WINDOW_SECONDS());
                    assertLe(a.windowStart + a.windowSeconds, a.anchoredAt + reg.MAX_FUTURE_SKEW(), "future window");
                    assertLt(a.refBlock, a.blockNumber, "refBlock not before the anchor block");
                    end = a.windowStart + a.windowSeconds;
                }
                assertEq(reg.nextWindowStart(owner, handler.deviceId(d)), end, "nextWindowStart");
            }
        }
    }

    /// A3/A4: device status, key and version match the ghost. A revoked device stays revoked and got
    /// no anchor after its revocation. keyVersion = 1 + number of rotations.
    function _check_devices() internal view {
        for (uint256 o = 0; o < handler.OWNERS(); o++) {
            address owner = handler.owners(o);
            for (uint256 d = 0; d < handler.DEVICES(); d++) {
                bytes32 id = handler.deviceId(d);
                DeviceRegistry.Device memory dev = reg.getDevice(owner, id);
                (uint8 status, bytes32 keyHash, uint32 version, uint256 rotations, uint64 revokedAt, uint256 countAtRevoke,,) =
                    handler.ghostDevice(o, d);
                assertEq(uint8(dev.status), status, "status");
                if (status == 0) continue;
                assertEq(dev.keyHash, keyHash, "keyHash");
                assertEq(dev.keyVersion, version, "keyVersion");
                assertEq(uint256(dev.keyVersion), 1 + rotations, "keyVersion grows only by rotation");
                if (status == 2) {
                    assertEq(dev.revokedAt, revokedAt, "revokedAt");
                    assertEq(reg.anchorCount(owner, id), countAtRevoke, "anchor after revoke");
                } else {
                    assertEq(dev.revokedAt, 0);
                }
            }
        }
    }

    /// A3: each owner's nonce equals the number of its successful owner actions (register, revoke,
    /// rotate): it grows by exactly one per action and by nothing else.
    function _check_noncesCountOwnerActions() internal view {
        for (uint256 o = 0; o < handler.OWNERS(); o++) {
            assertEq(reg.nonces(handler.owners(o)), handler.ghostNonce(o), "nonce vs ghost");
            assertEq(reg.nonces(handler.owners(o)), handler.ownerActions(o), "nonce vs owner actions");
        }
        assertEq(reg.nonces(handler.ATTACKER()), 0, "attacker nonce");
    }

    /// A3/A4: no forged or replayed call was ever accepted, no correctly signed
    /// in-rules call was refused, and nextWindowStart, keyVersion and nonces never went down.
    function _check_noForgeryNoReplay() internal view {
        assertEq(handler.forgedAccepted(), 0, "forged or replayed call accepted");
        assertEq(handler.validRejected(), 0, "valid call refused");
        assertEq(handler.monotonicBroken(), 0, "a counter went down");
    }

    /// Reach check, after every run: the handler did real work, not mostly early returns.
    function _checkReach() internal view {
        uint256 total;
        uint256 useful;
        for (uint256 i = 0; i < 9; i++) {
            total += handler.calls(i);
            useful += handler.done(i);
        }
        // Early returns happen only when no device is in the needed state (for example no revoked
        // device yet). They must stay a minority.
        assertGe(useful * 2, total, "handler mostly skipped its actions");
    }
}

/// @notice Fixed-seed walk of 200 handler calls, with a printed reach report: how many anchors,
///         rotations, revocations and refused attacks a walk of this length produces. It checks the
///         no-forgery invariant after every step and all invariants at the end.
/// @notice The invariant test. Each invariant runs after every handler call of every run.
contract RegistryInvariantTest is RegistryInvariantBase {
    function invariant_hashChainIntact() public view {
        _check_hashChainIntact();
    }

    function invariant_anchorsImmutable() public view {
        _check_anchorsImmutable();
    }

    function invariant_windowsOrderedAndGapsTrue() public view {
        _check_windowsOrderedAndGapsTrue();
    }

    function invariant_devices() public view {
        _check_devices();
    }

    function invariant_noncesCountOwnerActions() public view {
        _check_noncesCountOwnerActions();
    }

    function invariant_noForgeryNoReplay() public view {
        _check_noForgeryNoReplay();
    }

    function afterInvariant() public view {
        _checkReach();
    }
}

contract RegistryHandlerReachTest is RegistryInvariantBase {
    function test_reach_fixedSeedWalk() public {
        uint256 steps = 200;
        for (uint256 s = 0; s < steps; s++) {
            uint256 r = uint256(keccak256(abi.encode("qw-walk", s)));
            uint256 a = r % 9;
            uint256 x = r >> 8;
            uint256 y = r >> 40;
            if (a == 0) handler.register(x, y);
            else if (a == 1) handler.rotate(x, y);
            else if (a == 2) handler.revoke(x, y);
            else if (a == 3) handler.anchor(x, y, uint256(keccak256(abi.encode(r, 1))), keccak256(abi.encode(r)));
            else if (a == 4) handler.moveTime(x, y);
            else if (a == 5) handler.forgedAnchor(x, y, uint256(keccak256(abi.encode(r, 2))), keccak256(abi.encode(r)));
            else if (a == 6) handler.forgedOwnerAction(x, y, r >> 72);
            else if (a == 7) handler.replay(x);
            else handler.revokedAnchor(x, y, keccak256(abi.encode(r)));
            // Cheap check every step, so a failure stops early. Hardhat re-runs a failing test with
            // step tracing to print its stack trace, and that needs a lot of memory for a long walk.
            _check_noForgeryNoReplay();
        }
        _check_hashChainIntact();
        _check_anchorsImmutable();
        _check_windowsOrderedAndGapsTrue();
        _check_devices();
        _check_noncesCountOwnerActions();
        (uint256 anchors, uint256 rotations, uint256 revocations, uint256 registrations) = handler.totals();
        console.log("reach after 200 steps: anchors, rotations, revocations, registrations");
        console.log(anchors, rotations, revocations, registrations);
        console.log("attacks refused: forged anchor, forged owner action, replay, revoked device");
        console.log(handler.done(5), handler.done(6), handler.done(7), handler.done(8));
        assertGe(anchors, 40, "too few anchors");
        assertGe(rotations, 10, "too few rotations");
        assertGe(revocations, 5, "too few revocations");
        assertGe(handler.done(7), 20, "too few replays");
        _checkReach();
    }
}
