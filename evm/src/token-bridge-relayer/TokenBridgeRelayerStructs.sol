// SPDX-License-Identifier: Apache 2
pragma solidity ^0.8.13;

contract TokenBridgeRelayerStructs {
    struct TransferWithRelay {
        uint8 payloadId; // == 1
        uint256 targetRelayerFee;
        uint256 toNativeTokenAmount;
        bytes32 targetRecipient;
        bool unwrap;
    }

    struct InternalTransferParams {
        address token;
        uint256 amount;
        uint256 toNativeTokenAmount;
        uint16 targetChain;
        bytes32 targetRecipient;
        bool unwrap;
    }
}
