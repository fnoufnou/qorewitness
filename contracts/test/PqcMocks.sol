// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @notice Test double for the pqcVerify precompile at 0x0A01.
/// @dev Real ML-DSA cannot run in the local simulator. This mock accepts a
///      "signature" equal to abi.encodePacked(keccak256(pubkey), keccak256(message)).
///      Real ML-DSA-87 verification is covered by scripts/probe-pqc.ts against testnet.
contract MockPqcVerify {
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external
        pure
        returns (bool)
    {
        return keccak256(signature) == keccak256(abi.encodePacked(keccak256(pubkey), keccak256(message)));
    }
}

/// @notice Test double for pqcKeyStatus at 0x0A02, chain v3.2.4+ form (4 values).
contract MockPqcKeyStatus4 {
    mapping(address => bytes) public keys;
    mapping(address => bool) public pop;

    function setKey(address account, bytes calldata pubkey, bool possessionProven) external {
        keys[account] = pubkey;
        pop[account] = possessionProven;
    }

    function pqcKeyStatus(address account) external view returns (bool, uint8, bytes memory, bool) {
        bytes memory k = keys[account];
        return (k.length > 0, k.length > 0 ? 1 : 0, k, pop[account]);
    }
}

/// @notice Test double for pqcKeyStatus at 0x0A02, documented form (3 values).
contract MockPqcKeyStatus3 {
    mapping(address => bytes) public keys;

    function setKey(address account, bytes calldata pubkey, bool) external {
        keys[account] = pubkey;
    }

    function pqcKeyStatus(address account) external view returns (bool, uint8, bytes memory) {
        bytes memory k = keys[account];
        return (k.length > 0, k.length > 0 ? 1 : 0, k);
    }
}
