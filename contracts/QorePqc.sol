// SPDX-License-Identifier: Apache-2.0
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
