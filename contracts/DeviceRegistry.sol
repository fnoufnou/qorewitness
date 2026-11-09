// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {QorePqc} from "./QorePqc.sol";

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
