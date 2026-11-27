// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @notice Reference Merkle tree for the tests: the recursive Merkle Tree Hash and audit path of
///         RFC 6962 section 2.1 (split at the largest power of two below n), with the RFC 6962
///         prefixes 0x00 for a leaf and 0x01 for a node. Written apart from contracts/MerkleSha256.sol,
///         which builds the tree level by level.
abstract contract MerkleReference {
    function _refLeaf(bytes32 x) internal pure returns (bytes32) {
        return sha256(bytes.concat(bytes1(0x00), x));
    }

    function _refNode(bytes32 l, bytes32 r) internal pure returns (bytes32) {
        return sha256(bytes.concat(bytes1(0x01), l, r));
    }

    /// @dev MTH(D[lo:hi]); appends the sibling of each leaf to its path, leaf to root order.
    function _mth(bytes32[] memory lh, uint256 lo, uint256 hi, bytes32[][] memory paths, uint256[] memory plen)
        internal
        pure
        returns (bytes32)
    {
        uint256 n = hi - lo;
        if (n == 1) return lh[lo];
        uint256 k = 1;
        while (k * 2 < n) k *= 2; // largest power of two smaller than n
        bytes32 l = _mth(lh, lo, lo + k, paths, plen);
        bytes32 r = _mth(lh, lo + k, hi, paths, plen);
        for (uint256 i = lo; i < lo + k; i++) paths[i][plen[i]++] = r;
        for (uint256 i = lo + k; i < hi; i++) paths[i][plen[i]++] = l;
        return _refNode(l, r);
    }

    struct Tree {
        bytes32[] segs; // segment hashes (input of leaf())
        bytes32 root;
        bytes32[][] proofs;
    }

    function _tree(uint256 n, bytes32 salt) internal pure returns (Tree memory t) {
        t.segs = new bytes32[](n);
        bytes32[] memory lh = new bytes32[](n);
        bytes32[][] memory paths = new bytes32[][](n);
        uint256[] memory plen = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            t.segs[i] = keccak256(abi.encode(salt, i));
            lh[i] = _refLeaf(t.segs[i]);
            paths[i] = new bytes32[](32);
        }
        t.root = _mth(lh, 0, n, paths, plen);
        t.proofs = new bytes32[][](n);
        for (uint256 i = 0; i < n; i++) {
            t.proofs[i] = new bytes32[](plen[i]);
            for (uint256 j = 0; j < plen[i]; j++) t.proofs[i][j] = paths[i][j];
        }
    }

}
