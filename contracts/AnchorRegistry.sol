// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {QorePqc} from "./QorePqc.sol";
import {MerkleSha256} from "./MerkleSha256.sol";
import {DeviceRegistry} from "./DeviceRegistry.sol";

/// @title AnchorRegistry (v4)
/// @notice Stores Merkle roots of camera recording windows. Each root carries an
///         ML-DSA-87 signature by the device key that the owner registered in the
///         DeviceRegistry. The contract checks the signature on chain with the
///         pqcVerify precompile.
///         Time is bounded on both sides: the device signs a recent block hash, so the
///         root was signed after that block, and the anchor block shows it existed
///         before the anchor time.
///         Windows of a device form a chain: each window commits to the root of the
///         previous one. A replaced, removed or re-recorded window breaks the chain.
///         A time gap between windows is stored on chain.
/// @dev No contract owner and no upgrade path: an anchor can never be changed or
///      removed. Windows per (owner, device) must not overlap and must move forward.
///      Only the sender itself can anchor for its devices.
contract AnchorRegistry is DeviceRegistry {
    /// @notice Domain tag of the signed window message. Change it on any format change.
    bytes32 public constant DOMAIN = keccak256("QoreWitness/AnchorRegistry/v3");

    /// @notice Max allowed clock skew between the device and the chain, in seconds.
    uint64 public constant MAX_FUTURE_SKEW = 120;

    /// @notice Max window length, in seconds (1 day). Audit QCAI ETH-001.
    uint32 public constant MAX_WINDOW_SECONDS = 86_400;

    /// @notice One window claim, as signed by the device.
    struct WindowClaim {
        bytes32 deviceId;
        uint64 windowStart; // device claim: unix time of the window start
        uint32 windowSeconds; // device claim: window length
        uint32 leafCount; // number of segments in the window
        bytes32 root; // Merkle root over the segment links of the window
        bytes32 prevRoot; // root of the previous window of this device, 0 for the first
        uint64 refBlock; // a recent block. Its hash is part of the signed message.
    }

    struct Anchor {
        bytes32 root;
        bytes32 sigHash; // keccak256 of the ML-DSA-87 signature (full signature is in the tx input)
        bytes32 deviceKeyHash; // keccak256 of the device key that signed
        bytes32 prevRoot; // chain link to the previous window
        address owner; // account that owns the device and sent the anchor
        uint32 deviceKeyVersion;
        uint64 windowStart;
        uint32 windowSeconds;
        uint32 leafCount;
        uint64 anchoredAt; // block.timestamp: signed and anchored no later than this
        uint64 blockNumber;
        uint64 refBlock; // signed no earlier than this block
        uint64 gapBefore; // seconds without an anchor before this window, 0 if contiguous
    }

    /// @notice Result of verifyAnchor. `found` is false for an unknown window.
    struct Verification {
        bool found;
        bool included; // segment link + path lead to the anchored root
        bytes32 anchorId;
        Anchor anchor;
        DeviceStatus deviceStatus; // status now
        uint64 deviceRevokedAt; // 0 if not revoked
        bytes32 chainHead; // root of the newest window of this device
    }

    mapping(bytes32 anchorId => Anchor) private _anchors;
    mapping(address owner => mapping(bytes32 deviceId => uint64)) public nextWindowStart;
    mapping(address owner => mapping(bytes32 deviceId => uint256)) public anchorCount;
    /// @notice Root of the newest window per device: the head of its chain.
    mapping(address owner => mapping(bytes32 deviceId => bytes32)) public chainHead;

    event Anchored(
        bytes32 indexed anchorId,
        address indexed owner,
        bytes32 indexed deviceId,
        uint64 windowStart,
        uint32 windowSeconds,
        uint32 leafCount,
        bytes32 root,
        bytes32 sigHash
    );
    /// @notice No anchor covers `gapSeconds` before this window. Visible to every verifier.
    event WindowGap(address indexed owner, bytes32 indexed deviceId, uint64 gapStart, uint64 gapSeconds);

    error EmptyWindow();
    error WindowInFuture(uint64 windowEnd, uint64 blockTime);
    error WindowTooLong(uint32 windowSeconds, uint32 maxSeconds);
    error WindowOverlap(uint64 windowStart, uint64 nextAllowed);
    error BrokenChain(bytes32 expectedPrevRoot, bytes32 givenPrevRoot);
    error BadRefBlock(uint64 refBlock);
    error BadSignature();
    error UnknownAnchor(bytes32 anchorId);

    constructor(bool requirePossessionProof_) DeviceRegistry(requirePossessionProof_) {}

    /// @notice The exact bytes the device signs with ML-DSA-87 (empty context). 256 bytes.
    function signingMessage(address owner, WindowClaim memory w, bytes32 refBlockHash)
        public
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            abi.encodePacked(DOMAIN, block.chainid, address(this), owner, w.deviceId),
            abi.encodePacked(w.windowStart, w.windowSeconds, w.leafCount, w.root, w.prevRoot, w.refBlock, refBlockHash)
        );
    }

    /// @notice Unique id of the anchor for one window of one device.
    function anchorIdOf(address owner, bytes32 deviceId, uint64 windowStart) public pure returns (bytes32) {
        return keccak256(abi.encode(owner, deviceId, windowStart));
    }

    /// @notice Anchors the Merkle root of one recording window.
    /// @param w The window claim. `prevRoot` must be the current chain head of the device.
    ///        `refBlock` must be one of the last 256 blocks.
    /// @param devicePubkey Current ML-DSA-87 key of the device (2,592 bytes).
    /// @param signature ML-DSA-87 signature by the device key over signingMessage.
    function anchor(WindowClaim calldata w, bytes calldata devicePubkey, bytes calldata signature)
        external
        returns (bytes32 anchorId)
    {
        uint64 gap = _checkWindow(w);
        bytes32 head = chainHead[msg.sender][w.deviceId];
        if (w.prevRoot != head) revert BrokenChain(head, w.prevRoot);
        // blockhash is 0 for the current block, future blocks and blocks older than 256.
        bytes32 refHash = w.refBlock < block.number ? blockhash(w.refBlock) : bytes32(0);
        if (refHash == bytes32(0)) revert BadRefBlock(w.refBlock);

        Device storage d = _activeDeviceKey(msg.sender, w.deviceId, devicePubkey);
        if (!QorePqc.verify(devicePubkey, signature, signingMessage(msg.sender, w, refHash))) revert BadSignature();

        anchorId = _store(w, d, keccak256(signature), gap);
    }

    /// @dev Writes the anchor and moves the device's window and chain head forward.
    function _store(WindowClaim calldata w, Device storage d, bytes32 sigHash, uint64 gap)
        private
        returns (bytes32 anchorId)
    {
        anchorId = anchorIdOf(msg.sender, w.deviceId, w.windowStart);
        Anchor storage a = _anchors[anchorId];
        a.root = w.root;
        a.sigHash = sigHash;
        a.deviceKeyHash = d.keyHash;
        a.prevRoot = w.prevRoot;
        a.owner = msg.sender;
        a.deviceKeyVersion = d.keyVersion;
        a.windowStart = w.windowStart;
        a.windowSeconds = w.windowSeconds;
        a.leafCount = w.leafCount;
        a.anchoredAt = uint64(block.timestamp);
        a.blockNumber = uint64(block.number);
        a.refBlock = w.refBlock;
        a.gapBefore = gap;
        nextWindowStart[msg.sender][w.deviceId] = w.windowStart + w.windowSeconds;
        anchorCount[msg.sender][w.deviceId] += 1;
        chainHead[msg.sender][w.deviceId] = w.root;
        if (gap > 0) emit WindowGap(msg.sender, w.deviceId, w.windowStart - gap, gap);
        emit Anchored(anchorId, msg.sender, w.deviceId, w.windowStart, w.windowSeconds, w.leafCount, w.root, sigHash);
    }

    /// @dev Window rules: not empty, at most 1 day long, not in the future, after the
    ///      previous window of the device. Returns the gap after the previous window.
    function _checkWindow(WindowClaim calldata w) private view returns (uint64 gap) {
        if (w.windowSeconds == 0 || w.leafCount == 0) revert EmptyWindow();
        if (w.windowSeconds > MAX_WINDOW_SECONDS) revert WindowTooLong(w.windowSeconds, MAX_WINDOW_SECONDS);
        uint64 windowEnd = w.windowStart + w.windowSeconds;
        if (windowEnd > uint64(block.timestamp) + MAX_FUTURE_SKEW) {
            revert WindowInFuture(windowEnd, uint64(block.timestamp));
        }
        uint64 nextAllowed = nextWindowStart[msg.sender][w.deviceId];
        if (w.windowStart < nextAllowed) revert WindowOverlap(w.windowStart, nextAllowed);
        // The first window of a device has no gap.
        if (anchorCount[msg.sender][w.deviceId] > 0) gap = w.windowStart - nextAllowed;
    }

    /// @notice Returns a stored anchor. Reverts for an unknown id.
    function getAnchor(bytes32 anchorId) external view returns (Anchor memory a) {
        a = _anchors[anchorId];
        if (a.anchoredAt == 0) revert UnknownAnchor(anchorId);
    }

    /// @notice Checks that a segment link is part of an anchored window.
    /// @param segmentLink The segment's chain link (see docs/SPEC.md), the Merkle leaf input.
    /// @param index Position of the segment in the window (0-based).
    /// @param proof Sibling hashes from leaf to root.
    function verifySegment(bytes32 anchorId, bytes32 segmentLink, uint256 index, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        Anchor storage a = _anchors[anchorId];
        if (a.anchoredAt == 0) revert UnknownAnchor(anchorId);
        return MerkleSha256.verify(a.root, MerkleSha256.leaf(segmentLink), index, a.leafCount, proof);
    }

    /// @notice One call for third parties: is this segment in the anchored window of
    ///         (owner, device, windowStart), the full anchor record (time bounds, chain
    ///         link, gap, signing key), the device status now and the chain head.
    ///         Never reverts.
    function verifyAnchor(
        address owner,
        bytes32 deviceId,
        uint64 windowStart,
        bytes32 segmentLink,
        uint256 index,
        bytes32[] calldata proof
    ) external view returns (Verification memory v) {
        v.anchorId = anchorIdOf(owner, deviceId, windowStart);
        Device memory d = getDevice(owner, deviceId);
        v.deviceStatus = d.status;
        v.deviceRevokedAt = d.revokedAt;
        v.chainHead = chainHead[owner][deviceId];
        Anchor storage a = _anchors[v.anchorId];
        if (a.anchoredAt == 0) return v;
        v.found = true;
        v.anchor = a;
        v.included = MerkleSha256.verify(a.root, MerkleSha256.leaf(segmentLink), index, a.leafCount, proof);
    }
}
