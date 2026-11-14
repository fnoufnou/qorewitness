// Sources flattened with hardhat v3.21.2 https://hardhat.org

// SPDX-License-Identifier: Apache-2.0

// File contracts/QorePqc.sol

// Original license: SPDX_License_Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title QorePqc
/// @notice Safe wrappers around the QoreChain PQC precompiles.
/// @dev The precompiles exist on the qorechain-diana testnet only (Nov 2026).
///      A call to an inactive precompile succeeds with empty return data, so
///      every call checks the return length and fails closed.
library QorePqc {
    address internal constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address internal constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;

    uint8 internal constant ALG_ML_DSA_87 = 1;
    uint256 internal constant ML_DSA_87_PUBKEY_LEN = 2592;
    uint256 internal constant ML_DSA_87_SIG_LEN = 4627;

    error PqcPrecompileInactive();

    /// @notice Verifies an ML-DSA-87 signature with an empty context string.
    /// @return valid False for any bad signature or malformed input.
    function verify(bytes memory pubkey, bytes memory signature, bytes memory message)
        internal
        view
        returns (bool valid)
    {
        (bool ok, bytes memory ret) = PQC_VERIFY.staticcall(
            abi.encodeWithSignature("pqcVerify(bytes,bytes,bytes)", pubkey, signature, message)
        );
        if (!ok) return false;
        if (ret.length < 32) revert PqcPrecompileInactive();
        valid = abi.decode(ret, (bool));
    }

    /// @notice Reads the ML-DSA key that the chain has registered for `account`.
    /// @dev Accepts the documented 3-value return and the 4-value return of
    ///      chain v3.2.4+ that adds `possessionProven`. In the 3-value form
    ///      `possessionProven` is reported as false.
    function keyStatus(address account)
        internal
        view
        returns (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven)
    {
        (bool ok, bytes memory ret) =
            PQC_KEY_STATUS.staticcall(abi.encodeWithSignature("pqcKeyStatus(address)", account));
        if (!ok) return (false, 0, "", false);
        if (ret.length < 96) revert PqcPrecompileInactive();
        // Head word 2 is the offset of the dynamic `bytes`: 0x60 for 3 values, 0x80 for 4.
        uint256 offset;
        assembly {
            offset := mload(add(ret, 0x60))
        }
        if (offset == 0x80) {
            (registered, algorithmId, pubkey, possessionProven) = abi.decode(ret, (bool, uint8, bytes, bool));
        } else {
            (registered, algorithmId, pubkey) = abi.decode(ret, (bool, uint8, bytes));
        }
    }
}


// File contracts/DeviceRegistry.sol

// Original license: SPDX_License_Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title DeviceRegistry
/// @notice Camera devices per owner. Each device has its own ML-DSA-87 key.
///         Every change needs fresh ML-DSA-87 signatures that the contract checks
///         on chain with the pqcVerify precompile:
///         - register: owner key (the PQC key the chain has for the owner) and device key
///         - revoke:   owner key
///         - rotate:   old device key and new device key
///         An ECDSA key alone, even inside an open EVM window, cannot change a device.
/// @dev The contract stores only keccak256 of a device public key (2,592 bytes).
///      Callers pass the full key in calldata. This is much cheaper than storage.
abstract contract DeviceRegistry {
    bytes32 public constant REGISTER_TAG = keccak256("QoreWitness/DeviceRegistry/register/v1");
    bytes32 public constant REVOKE_TAG = keccak256("QoreWitness/DeviceRegistry/revoke/v1");
    bytes32 public constant ROTATE_TAG = keccak256("QoreWitness/DeviceRegistry/rotate/v1");

    enum DeviceStatus {
        None,
        Active,
        Revoked
    }

    struct Device {
        bytes32 keyHash; // keccak256 of the current ML-DSA-87 public key
        uint32 keyVersion; // 1 after register, +1 per rotation
        DeviceStatus status;
        uint64 registeredAt;
        uint64 revokedAt; // 0 while active
    }

    /// @notice If true, the owner's chain PQC key must have a proof of possession.
    bool public immutable requirePossessionProof;

    mapping(address owner => mapping(bytes32 deviceId => Device)) private _devices;

    /// @notice Replay protection for owner actions and rotations. One counter per owner.
    mapping(address owner => uint256) public nonces;

    event DeviceRegistered(address indexed owner, bytes32 indexed deviceId, bytes32 keyHash);
    event DeviceRevoked(address indexed owner, bytes32 indexed deviceId, uint32 keyVersion);
    event DeviceKeyRotated(
        address indexed owner, bytes32 indexed deviceId, bytes32 oldKeyHash, bytes32 newKeyHash, uint32 keyVersion
    );

    error NoPqcKey(address account);
    error PossessionNotProven(address account);
    error BadOwnerSignature();
    error BadDeviceSignature();
    error BadOldKeySignature();
    error BadNewKeySignature();
    error BadDeviceKey();
    error DeviceExists(bytes32 deviceId);
    error DeviceNotActive(bytes32 deviceId);
    error DeviceKeyMismatch(bytes32 deviceId);
    error SameKey();

    constructor(bool requirePossessionProof_) {
        requirePossessionProof = requirePossessionProof_;
    }

    // ---------------------------------------------------------------- messages

    /// @notice Bytes that the owner key and the new device key sign to register a device.
    function registerMessage(address owner, bytes32 deviceId, bytes32 keyHash, uint256 nonce)
        public
        view
        returns (bytes memory)
    {
        return abi.encodePacked(REGISTER_TAG, block.chainid, address(this), owner, deviceId, keyHash, nonce);
    }

    /// @notice Bytes that the owner key signs to revoke a device.
    function revokeMessage(address owner, bytes32 deviceId, uint256 nonce) public view returns (bytes memory) {
        return abi.encodePacked(REVOKE_TAG, block.chainid, address(this), owner, deviceId, nonce);
    }

    /// @notice Bytes that the old and the new device key sign to rotate the key.
    function rotateMessage(address owner, bytes32 deviceId, bytes32 oldKeyHash, bytes32 newKeyHash, uint256 nonce)
        public
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            ROTATE_TAG, block.chainid, address(this), owner, deviceId, oldKeyHash, newKeyHash, nonce
        );
    }

    // ---------------------------------------------------------------- actions

    /// @notice Registers a new device for the sender. A revoked device id cannot come back.
    /// @param devicePubkey ML-DSA-87 public key of the device (2,592 bytes).
    /// @param ownerSignature ML-DSA-87 signature by the sender's chain PQC key over registerMessage.
    /// @param deviceSignature ML-DSA-87 signature by the device key over the same message (proof of possession).
    function registerDevice(
        bytes32 deviceId,
        bytes calldata devicePubkey,
        bytes calldata ownerSignature,
        bytes calldata deviceSignature
    ) external {
        if (devicePubkey.length != QorePqc.ML_DSA_87_PUBKEY_LEN) revert BadDeviceKey();
        Device storage d = _devices[msg.sender][deviceId];
        if (d.status != DeviceStatus.None) revert DeviceExists(deviceId);

        bytes32 keyHash = keccak256(devicePubkey);
        bytes memory message = registerMessage(msg.sender, deviceId, keyHash, nonces[msg.sender]);
        if (!QorePqc.verify(_ownerKey(msg.sender), ownerSignature, message)) revert BadOwnerSignature();
        if (!QorePqc.verify(devicePubkey, deviceSignature, message)) revert BadDeviceSignature();

        nonces[msg.sender] += 1;
        d.keyHash = keyHash;
        d.keyVersion = 1;
        d.status = DeviceStatus.Active;
        d.registeredAt = uint64(block.timestamp);
        emit DeviceRegistered(msg.sender, deviceId, keyHash);
    }

    /// @notice Revokes a device of the sender. After this, the device cannot anchor. Final.
    /// @param ownerSignature ML-DSA-87 signature by the sender's chain PQC key over revokeMessage.
    function revokeDevice(bytes32 deviceId, bytes calldata ownerSignature) external {
        Device storage d = _devices[msg.sender][deviceId];
        if (d.status != DeviceStatus.Active) revert DeviceNotActive(deviceId);

        bytes memory message = revokeMessage(msg.sender, deviceId, nonces[msg.sender]);
        if (!QorePqc.verify(_ownerKey(msg.sender), ownerSignature, message)) revert BadOwnerSignature();

        nonces[msg.sender] += 1;
        d.status = DeviceStatus.Revoked;
        d.revokedAt = uint64(block.timestamp);
        emit DeviceRevoked(msg.sender, deviceId, d.keyVersion);
    }

    /// @notice Replaces the device key. Both the old and the new key must sign.
    function rotateDeviceKey(
        bytes32 deviceId,
        bytes calldata oldPubkey,
        bytes calldata newPubkey,
        bytes calldata oldSignature,
        bytes calldata newSignature
    ) external {
        if (newPubkey.length != QorePqc.ML_DSA_87_PUBKEY_LEN) revert BadDeviceKey();
        Device storage d = _devices[msg.sender][deviceId];
        if (d.status != DeviceStatus.Active) revert DeviceNotActive(deviceId);
        bytes32 oldKeyHash = keccak256(oldPubkey);
        if (oldKeyHash != d.keyHash) revert DeviceKeyMismatch(deviceId);
        bytes32 newKeyHash = keccak256(newPubkey);
        if (newKeyHash == oldKeyHash) revert SameKey();

        bytes memory message = rotateMessage(msg.sender, deviceId, oldKeyHash, newKeyHash, nonces[msg.sender]);
        if (!QorePqc.verify(oldPubkey, oldSignature, message)) revert BadOldKeySignature();
        if (!QorePqc.verify(newPubkey, newSignature, message)) revert BadNewKeySignature();

        nonces[msg.sender] += 1;
        d.keyHash = newKeyHash;
        d.keyVersion += 1;
        emit DeviceKeyRotated(msg.sender, deviceId, oldKeyHash, newKeyHash, d.keyVersion);
    }

    // ---------------------------------------------------------------- views

    function getDevice(address owner, bytes32 deviceId) public view returns (Device memory) {
        return _devices[owner][deviceId];
    }

    // ---------------------------------------------------------------- internal

    /// @dev Reverts unless the device is active and `devicePubkey` is its current key.
    function _activeDeviceKey(address owner, bytes32 deviceId, bytes calldata devicePubkey)
        internal
        view
        returns (Device storage d)
    {
        d = _devices[owner][deviceId];
        if (d.status != DeviceStatus.Active) revert DeviceNotActive(deviceId);
        if (keccak256(devicePubkey) != d.keyHash) revert DeviceKeyMismatch(deviceId);
    }

    /// @dev The ML-DSA-87 key the chain has registered for `account`. Fails closed.
    function _ownerKey(address account) internal view returns (bytes memory pubkey) {
        bool registered;
        uint8 alg;
        bool pop;
        (registered, alg, pubkey, pop) = QorePqc.keyStatus(account);
        if (!registered || alg != QorePqc.ALG_ML_DSA_87 || pubkey.length != QorePqc.ML_DSA_87_PUBKEY_LEN) {
            revert NoPqcKey(account);
        }
        if (requirePossessionProof && !pop) revert PossessionNotProven(account);
    }
}


// File contracts/MerkleSha256.sol

// Original license: SPDX_License_Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title MerkleSha256
/// @notice SHA-256 Merkle tree with RFC 6962 style domain separation.
///         leaf = sha256(0x00 || segmentHash), node = sha256(0x01 || left || right).
///         An odd last node moves up one level without hashing (no duplication).
/// @dev Must match src/core/merkle.ts byte for byte.
library MerkleSha256 {
    /// @notice Max proof length. A uint32 leaf count gives at most 32 tree levels. Audit QCAI ETH-004.
    uint256 internal constant MAX_PROOF_LENGTH = 32;

    function leaf(bytes32 segmentHash) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(bytes1(0x00), segmentHash));
    }

    function node(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(bytes1(0x01), left, right));
    }

    function verify(bytes32 root, bytes32 leafHash, uint256 index, uint256 size, bytes32[] calldata proof)
        internal
        pure
        returns (bool)
    {
        if (index >= size || proof.length > MAX_PROOF_LENGTH) return false;
        bytes32 h = leafHash;
        uint256 p = 0;
        while (size > 1) {
            if (index % 2 == 1) {
                if (p >= proof.length) return false;
                h = node(proof[p++], h);
            } else if (index + 1 < size) {
                if (p >= proof.length) return false;
                h = node(h, proof[p++]);
            }
            index /= 2;
            size = (size + 1) / 2;
        }
        return p == proof.length && h == root;
    }
}


// File contracts/AnchorRegistry.sol

// Original license: SPDX_License_Identifier: Apache-2.0
pragma solidity ^0.8.28;



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

