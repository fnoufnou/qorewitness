// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {QorePqc} from "./QorePqc.sol";
import {MerkleSha256} from "./MerkleSha256.sol";

/// @title AnchorRegistry
/// @notice Stores Merkle roots of camera recording windows. Each root carries an
///         ML-DSA-87 signature that the contract checks against the post-quantum
///         key the chain has registered for the sender. The block time of the
///         anchor is the trusted "existed before" time.
/// @dev No owner and no upgrade path: an anchor can never be changed or removed.
///      Windows per (signer, device) must not overlap and must move forward, so a
///      verifier can show that no window was inserted later.
contract AnchorRegistry {
    /// @notice Domain tag of the signed message. Change it on any format change.
    bytes32 public constant DOMAIN = keccak256("QoreWitness/AnchorRegistry/v1");

    /// @notice Max allowed clock skew between the device and the chain, in seconds.
    uint64 public constant MAX_FUTURE_SKEW = 120;

    struct Anchor {
        bytes32 root; // Merkle root over the segment hashes of the window
        bytes32 sigHash; // keccak256 of the ML-DSA-87 signature (full signature is in the tx input)
        address signer; // account whose registered PQC key signed the root
        uint64 windowStart; // device claim: unix time of the window start
        uint32 windowSeconds; // device claim: window length
        uint32 leafCount; // number of segments in the window
        uint64 anchoredAt; // block.timestamp: the trusted time
        uint64 blockNumber;
    }

    /// @notice If true, the sender's PQC key must have a proof of possession on chain.
    bool public immutable requirePossessionProof;

    mapping(bytes32 anchorId => Anchor) private _anchors;
    mapping(address signer => mapping(bytes32 deviceId => uint64)) public nextWindowStart;
    mapping(address signer => mapping(bytes32 deviceId => uint256)) public anchorCount;

    event Anchored(
        bytes32 indexed anchorId,
        address indexed signer,
        bytes32 indexed deviceId,
        uint64 windowStart,
        uint32 windowSeconds,
        uint32 leafCount,
        bytes32 root,
        bytes32 sigHash
    );

    error EmptyWindow();
    error WindowInFuture(uint64 windowEnd, uint64 blockTime);
    error WindowOverlap(uint64 windowStart, uint64 nextAllowed);
    error NoPqcKey(address signer);
    error PossessionNotProven(address signer);
    error BadSignature();
    error UnknownAnchor(bytes32 anchorId);

    constructor(bool requirePossessionProof_) {
        requirePossessionProof = requirePossessionProof_;
    }

    /// @notice The exact bytes the device signs with ML-DSA-87 (empty context).
    function signingMessage(
        address signer,
        bytes32 deviceId,
        uint64 windowStart,
        uint32 windowSeconds,
        uint32 leafCount,
        bytes32 root
    ) public view returns (bytes memory) {
        return abi.encodePacked(
            DOMAIN, block.chainid, address(this), signer, deviceId, windowStart, windowSeconds, leafCount, root
        );
    }

    /// @notice Unique id of the anchor for one window of one device.
    function anchorIdOf(address signer, bytes32 deviceId, uint64 windowStart) public pure returns (bytes32) {
        return keccak256(abi.encode(signer, deviceId, windowStart));
    }

    /// @notice Anchors the Merkle root of one recording window.
    function anchor(
        bytes32 deviceId,
        uint64 windowStart,
        uint32 windowSeconds,
        uint32 leafCount,
        bytes32 root,
        bytes calldata signature
    ) external returns (bytes32 anchorId) {
        if (windowSeconds == 0 || leafCount == 0) revert EmptyWindow();
        uint64 windowEnd = windowStart + windowSeconds;
        if (windowEnd > uint64(block.timestamp) + MAX_FUTURE_SKEW) {
            revert WindowInFuture(windowEnd, uint64(block.timestamp));
        }
        uint64 nextAllowed = nextWindowStart[msg.sender][deviceId];
        if (windowStart < nextAllowed) revert WindowOverlap(windowStart, nextAllowed);

        _requireSignature(
            signingMessage(msg.sender, deviceId, windowStart, windowSeconds, leafCount, root), signature
        );

        anchorId = anchorIdOf(msg.sender, deviceId, windowStart);
        bytes32 sigHash = keccak256(signature);
        _anchors[anchorId] = Anchor({
            root: root,
            sigHash: sigHash,
            signer: msg.sender,
            windowStart: windowStart,
            windowSeconds: windowSeconds,
            leafCount: leafCount,
            anchoredAt: uint64(block.timestamp),
            blockNumber: uint64(block.number)
        });
        nextWindowStart[msg.sender][deviceId] = windowEnd;
        anchorCount[msg.sender][deviceId] += 1;
        emit Anchored(anchorId, msg.sender, deviceId, windowStart, windowSeconds, leafCount, root, sigHash);
    }

    /// @dev Checks `signature` against the PQC key the chain has registered for the sender.
    function _requireSignature(bytes memory message, bytes calldata signature) private view {
        (bool registered, uint8 alg, bytes memory pubkey, bool pop) = QorePqc.keyStatus(msg.sender);
        if (!registered || alg != QorePqc.ALG_ML_DSA_87 || pubkey.length != QorePqc.ML_DSA_87_PUBKEY_LEN) {
            revert NoPqcKey(msg.sender);
        }
        if (requirePossessionProof && !pop) revert PossessionNotProven(msg.sender);
        if (!QorePqc.verify(pubkey, signature, message)) revert BadSignature();
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
}
