// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MerkleSha256} from "../../contracts/MerkleSha256.sol";
import {MerkleReference} from "./utils/MerkleReference.sol";

/// @dev Exposes the library with a calldata proof, as the registry uses it.
contract MerkleHarness {
    function verify(bytes32 root, bytes32 leafHash, uint256 index, uint256 size, bytes32[] calldata proof)
        external
        pure
        returns (bool)
    {
        return MerkleSha256.verify(root, leafHash, index, size, proof);
    }

    function leaf(bytes32 x) external pure returns (bytes32) {
        return MerkleSha256.leaf(x);
    }

    function node(bytes32 l, bytes32 r) external pure returns (bytes32) {
        return MerkleSha256.node(l, r);
    }
}

/// @notice Differential tests of MerkleSha256 against an independent reference: the recursive
///         Merkle Tree Hash and audit path of RFC 6962 section 2.1 (split at the largest power
///         of two below n). The contract builds the tree level by level and moves an odd last
///         node up unchanged; both definitions give the same tree, which these tests check.
/// @dev Threat model A1 (changed, dropped or swapped segment) and audit ETH-004 (proof length).
contract MerkleSha256DifferentialTest is Test, MerkleReference {
    MerkleHarness internal m;
    uint256 internal constant MAX_SIZE = 300;

    function setUp() public {
        m = new MerkleHarness();
    }

    /// @dev Side of each proof element in the contract's walk (1 = sibling on the left), as bits,
    ///      plus the count. Two (index, size) pairs with the same shape hash a proof the same way.
    function _shape(uint256 index, uint256 size) internal pure returns (uint256 bits, uint256 count) {
        while (size > 1) {
            if (index % 2 == 1) {
                bits |= 1 << count;
                count++;
            } else if (index + 1 < size) {
                count++;
            }
            index /= 2;
            size = (size + 1) / 2;
        }
    }

    function _flip(bytes32 x, uint256 bit) internal pure returns (bytes32) {
        return x ^ bytes32(uint256(1) << (bit % 256));
    }

    // ------------------------------------------------ tests

    /// leaf() and node() use the RFC 6962 prefixes 0x00 and 0x01.
    function testFuzz_leafAndNodeEncoding(bytes32 x, bytes32 y) public view {
        assertEq(m.leaf(x), _refLeaf(x));
        assertEq(m.node(x, y), _refNode(x, y));
        assertTrue(m.leaf(x) != m.node(x, y));
    }

    /// A1: differential. For a random size 1..300 and random leaves, every index verifies with its
    /// reference proof, and the proof has the length the contract expects.
    function testFuzz_everyIndexVerifies(uint256 sizeSeed, bytes32 salt) public view {
        uint256 n = _bound(sizeSeed, 1, MAX_SIZE);
        Tree memory t = _tree(n, salt);
        for (uint256 i = 0; i < n; i++) {
            (, uint256 count) = _shape(i, n);
            assertEq(t.proofs[i].length, count, "reference and contract disagree on the proof length");
            assertTrue(m.verify(t.root, _refLeaf(t.segs[i]), i, n, t.proofs[i]), "valid proof refused");
        }
    }

    /// A1: every index of every size from 1 to 70, and 255, 256, 257 (power-of-two edges).
    function test_everyIndexVerifies_allSmallSizesAndEdges() public view {
        for (uint256 n = 1; n <= 70; n++) {
            Tree memory t = _tree(n, bytes32(n));
            for (uint256 i = 0; i < n; i++) assertTrue(m.verify(t.root, _refLeaf(t.segs[i]), i, n, t.proofs[i]));
        }
        uint256[3] memory edges = [uint256(255), 256, 257];
        for (uint256 e = 0; e < 3; e++) {
            Tree memory t = _tree(edges[e], bytes32(edges[e]));
            for (uint256 i = 0; i < edges[e]; i++) {
                assertTrue(m.verify(t.root, _refLeaf(t.segs[i]), i, edges[e], t.proofs[i]));
            }
        }
    }

    /// A1 (segment swapped or moved): with the true size, a proof never verifies at another index,
    /// nor at an index >= size.
    function testFuzz_wrongIndexFails(uint256 sizeSeed, bytes32 salt, uint256 idx, uint256 other) public view {
        uint256 n = _bound(sizeSeed, 1, MAX_SIZE);
        Tree memory t = _tree(n, salt);
        uint256 i = idx % n;
        bytes32 lf = _refLeaf(t.segs[i]);
        if (n > 1) {
            uint256 j = (i + 1 + other % (n - 1)) % n;
            assertFalse(m.verify(t.root, lf, j, n, t.proofs[i]), "proof verified at another index");
            // and every other index of a small tree
            if (n <= 40) {
                for (uint256 k = 0; k < n; k++) if (k != i) assertFalse(m.verify(t.root, lf, k, n, t.proofs[i]));
            }
        }
        assertFalse(m.verify(t.root, lf, n, n, t.proofs[i]), "index == size");
        assertFalse(m.verify(t.root, lf, n + other % 1_000, n, t.proofs[i]), "index >= size");
        assertFalse(m.verify(t.root, lf, type(uint256).max, n, t.proofs[i]), "index max");
    }

    /// A1: index == size never verifies, for every size 1..70 and every leaf's proof. For a
    /// one-leaf tree the root is the leaf hash and the proof is empty, the case an off-by-one
    /// bound check would accept.
    function test_indexEqualToSizeFails() public view {
        for (uint256 n = 1; n <= 70; n++) {
            Tree memory t = _tree(n, bytes32(n));
            for (uint256 i = 0; i < n; i++) assertFalse(m.verify(t.root, _refLeaf(t.segs[i]), n, n, t.proofs[i]));
        }
        bytes32 only = _refLeaf(keccak256("only"));
        assertTrue(m.verify(only, only, 0, 1, new bytes32[](0)), "control: one-leaf tree");
        assertFalse(m.verify(only, only, 1, 1, new bytes32[](0)), "index 1 of a one-leaf tree");
    }

    /// A1: a wrong size fails unless the contract walks the proof in exactly the same way for both
    /// sizes. An RFC 6962 root does not commit to the size; the registry takes the size from the
    /// signed, stored leafCount, so a caller cannot choose it (see AnchorWindows and Invariants).
    function testFuzz_wrongSize(uint256 sizeSeed, bytes32 salt, uint256 idx, uint256 otherSize) public view {
        uint256 n = _bound(sizeSeed, 1, MAX_SIZE);
        Tree memory t = _tree(n, salt);
        uint256 i = idx % n;
        uint256 n2 = _bound(otherSize, i + 1, 4 * MAX_SIZE);
        if (n2 == n) n2 = n + 1;
        (uint256 b1, uint256 c1) = _shape(i, n);
        (uint256 b2, uint256 c2) = _shape(i, n2);
        bool same = b1 == b2 && c1 == c2;
        assertEq(m.verify(t.root, _refLeaf(t.segs[i]), i, n2, t.proofs[i]), same, "size binding");
    }

    /// A1 (changed segment or changed proof): one flipped bit in the leaf or in any sibling fails.
    function testFuzz_flippedBitFails(uint256 sizeSeed, bytes32 salt, uint256 idx, uint256 which, uint256 bit)
        public
        view
    {
        uint256 n = _bound(sizeSeed, 1, MAX_SIZE);
        Tree memory t = _tree(n, salt);
        uint256 i = idx % n;
        assertFalse(m.verify(t.root, _refLeaf(_flip(t.segs[i], bit)), i, n, t.proofs[i]), "flipped segment");
        assertFalse(m.verify(t.root, _flip(_refLeaf(t.segs[i]), bit), i, n, t.proofs[i]), "flipped leaf hash");
        assertFalse(m.verify(_flip(t.root, bit), _refLeaf(t.segs[i]), i, n, t.proofs[i]), "flipped root");
        if (t.proofs[i].length > 0) {
            bytes32[] memory p = t.proofs[i];
            uint256 w = which % p.length;
            p[w] = _flip(p[w], bit);
            assertFalse(m.verify(t.root, _refLeaf(t.segs[i]), i, n, p), "flipped sibling");
        }
    }

    /// A1: a proof with one element missing, or one extra element anywhere, fails.
    function testFuzz_missingOrExtraElementFails(uint256 sizeSeed, bytes32 salt, uint256 idx, uint256 at, bytes32 extra)
        public
        view
    {
        uint256 n = _bound(sizeSeed, 1, MAX_SIZE);
        Tree memory t = _tree(n, salt);
        uint256 i = idx % n;
        bytes32 lf = _refLeaf(t.segs[i]);
        bytes32[] memory p = t.proofs[i];
        if (p.length > 0) {
            bytes32[] memory shortP = new bytes32[](p.length - 1);
            uint256 drop = at % p.length;
            for (uint256 k = 0; k < shortP.length; k++) shortP[k] = p[k < drop ? k : k + 1];
            assertFalse(m.verify(t.root, lf, i, n, shortP), "missing element");
        }
        bytes32[] memory longP = new bytes32[](p.length + 1);
        uint256 ins = at % (p.length + 1);
        for (uint256 k = 0; k < longP.length; k++) {
            longP[k] = k < ins ? p[k] : (k == ins ? extra : p[k - 1]);
        }
        assertFalse(m.verify(t.root, lf, i, n, longP), "extra element");
    }

    /// Audit ETH-004: a proof longer than 32 elements fails, even when it starts with the valid proof.
    function testFuzz_proofLongerThan32Fails(uint256 sizeSeed, bytes32 salt, uint256 idx, uint8 extraLen) public view {
        uint256 n = _bound(sizeSeed, 1, MAX_SIZE);
        Tree memory t = _tree(n, salt);
        uint256 i = idx % n;
        bytes32[] memory p = new bytes32[](33 + uint256(extraLen) % 64);
        for (uint256 k = 0; k < t.proofs[i].length; k++) p[k] = t.proofs[i][k];
        assertFalse(m.verify(t.root, _refLeaf(t.segs[i]), i, n, p));
        // a 2^32-leaf tree needs exactly 32 elements; 32 is still accepted as a length
        bytes32[] memory p32 = new bytes32[](32);
        bytes32 h = _refLeaf(t.segs[i]);
        for (uint256 k = 0; k < 32; k++) {
            p32[k] = keccak256(abi.encode(salt, k));
            h = _refNode(h, p32[k]);
        }
        assertTrue(m.verify(h, _refLeaf(t.segs[i]), 0, uint256(1) << 32, p32), "32-element proof refused");
        // A proof that is consistent for a tree of 2^33 or more leaves is still refused by the cap.
        // (In the registry the size is a uint32 leafCount, so such a tree cannot be anchored anyway.)
        uint256 levels = 33 + uint256(extraLen) % 8;
        bytes32[] memory deep = new bytes32[](levels);
        h = _refLeaf(t.segs[i]);
        for (uint256 k = 0; k < levels; k++) {
            deep[k] = keccak256(abi.encode(salt, k, "deep"));
            h = _refNode(h, deep[k]);
        }
        assertFalse(m.verify(h, _refLeaf(t.segs[i]), 0, uint256(1) << levels, deep), "proof longer than 32 accepted");
    }

    /// A1 (second preimage, RFC 6962 domain separation): an internal node presented as a segment
    /// never verifies one level up. Without the leaf prefix (raw hash input) it would; the 0x00
    /// prefix in leaf() is what stops it.
    function testFuzz_internalNodeAsLeafFails(uint256 sizeSeed, bytes32 salt, uint256 pairSeed) public view {
        uint256 n = _bound(sizeSeed, 2, MAX_SIZE);
        Tree memory t = _tree(n, salt);
        uint256 j = pairSeed % (n / 2); // pair (2j, 2j+1), both exist
        bytes32 inner = _refNode(_refLeaf(t.segs[2 * j]), _refLeaf(t.segs[2 * j + 1]));
        bytes32[] memory p = t.proofs[2 * j];
        bytes32[] memory upper = new bytes32[](p.length - 1);
        for (uint256 k = 0; k < upper.length; k++) upper[k] = p[k + 1];
        uint256 upperSize = (n + 1) / 2;
        assertTrue(m.verify(t.root, inner, j, upperSize, upper), "control: raw node verifies one level up");
        assertFalse(m.verify(t.root, m.leaf(inner), j, upperSize, upper), "internal node accepted as a segment");
        assertFalse(m.verify(t.root, m.leaf(inner), j, n, upper), "internal node accepted at full size");
    }
}
