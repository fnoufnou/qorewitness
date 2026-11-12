// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {QorePqc} from "./QorePqc.sol";
import {MerkleSha256} from "./MerkleSha256.sol";
import {DeviceRegistry} from "./DeviceRegistry.sol";

/// @title AnchorRegistry
/// @notice Stores Merkle roots of camera recording windows. Each root carries an
///         ML-DSA-87 signature by the device key that the owner registered in the
///         DeviceRegistry. The contract checks the signature on chain with the
///         pqcVerify precompile. The block time of the anchor is the trusted
///         "existed before" time.
/// @dev No contract owner and no upgrade path: an anchor can never be changed or
///      removed. Windows per (owner, device) must not overlap and must move
///      forward, so a verifier can show that no window was inserted later.
///      Only the sender itself can anchor for its devices.
contract AnchorRegistry is DeviceRegistry {
    /// @notice Domain tag of the signed window message. Change it on any format change.
    bytes32 public constant DOMAIN = keccak256("QoreWitness/AnchorRegistry/v2");

    /// @notice Max allowed clock skew between the device and the chain, in seconds.
    uint64 public constant MAX_FUTURE_SKEW = 120;

    /// @notice Max window length, in seconds (1 day). Audit QCAI ETH-001.
    uint32 public constant MAX_WINDOW_SECONDS = 86_400;

    struct Anchor {
        bytes32 root; // Merkle root over the segment hashes of the window
        bytes32 sigHash; // keccak256 of the ML-DSA-87 signature (full signature is in the tx input)
        bytes32 deviceKeyHash; // keccak256 of the device key that signed
        address owner; // account that owns the device and sent the anchor
        uint32 deviceKeyVersion;
        uint64 windowStart; // device claim: unix time of the window start
        uint32 windowSeconds; // device claim: window length
        uint32 leafCount; // number of segments in the window
        uint64 anchoredAt; // block.timestamp: the trusted time
        uint64 blockNumber;
    }

    /// @notice Result of verifyAnchor. `found` is false for an unknown window.
    struct Verification {
        bool found;
        bool included; // segment hash + path lead to the anchored root
        bytes32 anchorId;
        bytes32 root;
        uint64 windowStart;
        uint32 windowSeconds;
        uint32 leafCount;
        uint64 anchoredAt;
        uint64 blockNumber;
        bytes32 deviceKeyHash; // key that signed this anchor
        uint32 deviceKeyVersion;
        DeviceStatus deviceStatus; // status now
        uint64 deviceRevokedAt; // 0 if not revoked
    }

    mapping(bytes32 anchorId => Anchor) private _anchors;
    mapping(address owner => mapping(bytes32 deviceId => uint64)) public nextWindowStart;
    mapping(address owner => mapping(bytes32 deviceId => uint256)) public anchorCount;

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

    error EmptyWindow();
    error WindowInFuture(uint64 windowEnd, uint64 blockTime);
    error WindowTooLong(uint32 windowSeconds, uint32 maxSeconds);
    error WindowOverlap(uint64 windowStart, uint64 nextAllowed);
    error BadSignature();
    error UnknownAnchor(bytes32 anchorId);

    constructor(bool requirePossessionProof_) DeviceRegistry(requirePossessionProof_) {}

    /// @notice The exact bytes the device signs with ML-DSA-87 (empty context).
    function signingMessage(
        address owner,
        bytes32 deviceId,
        uint64 windowStart,
        uint32 windowSeconds,
        uint32 leafCount,
        bytes32 root
    ) public view returns (bytes memory) {
        return abi.encodePacked(
            DOMAIN, block.chainid, address(this), owner, deviceId, windowStart, windowSeconds, leafCount, root
        );
    }

    /// @notice Unique id of the anchor for one window of one device.
    function anchorIdOf(address owner, bytes32 deviceId, uint64 windowStart) public pure returns (bytes32) {
        return keccak256(abi.encode(owner, deviceId, windowStart));
    }

    /// @notice Anchors the Merkle root of one recording window.
    /// @param devicePubkey Current ML-DSA-87 key of the device (2,592 bytes).
    /// @param signature ML-DSA-87 signature by the device key over signingMessage.
    function anchor(
        bytes32 deviceId,
        uint64 windowStart,
        uint32 windowSeconds,
        uint32 leafCount,
        bytes32 root,
        bytes calldata devicePubkey,
        bytes calldata signature
    ) external returns (bytes32 anchorId) {
        _checkWindow(deviceId, windowStart, windowSeconds, leafCount);
        Device storage d = _activeDeviceKey(msg.sender, deviceId, devicePubkey);
        if (!QorePqc.verify(
                devicePubkey,
                signature,
                signingMessage(msg.sender, deviceId, windowStart, windowSeconds, leafCount, root)
            )) revert BadSignature();

        anchorId = anchorIdOf(msg.sender, deviceId, windowStart);
        bytes32 sigHash = keccak256(signature);
        Anchor storage a = _anchors[anchorId];
        a.root = root;
        a.sigHash = sigHash;
        a.deviceKeyHash = d.keyHash;
        a.owner = msg.sender;
        a.deviceKeyVersion = d.keyVersion;
        a.windowStart = windowStart;
        a.windowSeconds = windowSeconds;
        a.leafCount = leafCount;
        a.anchoredAt = uint64(block.timestamp);
        a.blockNumber = uint64(block.number);
        nextWindowStart[msg.sender][deviceId] = windowStart + windowSeconds;
        anchorCount[msg.sender][deviceId] += 1;
        emit Anchored(anchorId, msg.sender, deviceId, windowStart, windowSeconds, leafCount, root, sigHash);
    }

    /// @dev Window rules: not empty, at most 1 day long, not in the future, after the previous window of the device.
    function _checkWindow(bytes32 deviceId, uint64 windowStart, uint32 windowSeconds, uint32 leafCount)
        private
        view
    {
        if (windowSeconds == 0 || leafCount == 0) revert EmptyWindow();
        if (windowSeconds > MAX_WINDOW_SECONDS) revert WindowTooLong(windowSeconds, MAX_WINDOW_SECONDS);
        uint64 windowEnd = windowStart + windowSeconds;
        if (windowEnd > uint64(block.timestamp) + MAX_FUTURE_SKEW) {
            revert WindowInFuture(windowEnd, uint64(block.timestamp));
        }
        uint64 nextAllowed = nextWindowStart[msg.sender][deviceId];
        if (windowStart < nextAllowed) revert WindowOverlap(windowStart, nextAllowed);
    }

    /// @notice Returns a stored anchor. Reverts for an unknown id.
    function getAnchor(bytes32 anchorId) external view returns (Anchor memory a) {
        a = _anchors[anchorId];
        if (a.anchoredAt == 0) revert UnknownAnchor(anchorId);
    }

    /// @notice Checks that a segment hash is part of an anchored window.
    /// @param segmentHash SHA-256 of the segment file.
    /// @param index Position of the segment in the window (0-based).
    /// @param proof Sibling hashes from leaf to root.
    function verifySegment(bytes32 anchorId, bytes32 segmentHash, uint256 index, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        Anchor storage a = _anchors[anchorId];
        if (a.anchoredAt == 0) revert UnknownAnchor(anchorId);
        return MerkleSha256.verify(a.root, MerkleSha256.leaf(segmentHash), index, a.leafCount, proof);
    }

    /// @notice One call for third parties: is this segment in the anchored window of
    ///         (owner, device, windowStart), when was it anchored, by which device key,
    ///         and what is the device status now. Never reverts.
    function verifyAnchor(
        address owner,
        bytes32 deviceId,
        uint64 windowStart,
        bytes32 segmentHash,
        uint256 index,
        bytes32[] calldata proof
    ) external view returns (Verification memory v) {
        v.anchorId = anchorIdOf(owner, deviceId, windowStart);
        Anchor storage a = _anchors[v.anchorId];
        Device memory d = getDevice(owner, deviceId);
        v.deviceStatus = d.status;
        v.deviceRevokedAt = d.revokedAt;
        if (a.anchoredAt == 0) return v;
        v.found = true;
        v.included = MerkleSha256.verify(a.root, MerkleSha256.leaf(segmentHash), index, a.leafCount, proof);
        v.root = a.root;
        v.windowStart = a.windowStart;
        v.windowSeconds = a.windowSeconds;
        v.leafCount = a.leafCount;
        v.anchoredAt = a.anchoredAt;
        v.blockNumber = a.blockNumber;
        v.deviceKeyHash = a.deviceKeyHash;
        v.deviceKeyVersion = a.deviceKeyVersion;
    }
}
