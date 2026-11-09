// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title MerkleSha256
/// @notice SHA-256 Merkle tree with RFC 6962 style domain separation.
///         leaf = sha256(0x00 || segmentHash), node = sha256(0x01 || left || right).
///         An odd last node moves up one level without hashing (no duplication).
/// @dev Must match src/core/merkle.ts byte for byte.
library MerkleSha256 {
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
        if (index >= size) return false;
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
