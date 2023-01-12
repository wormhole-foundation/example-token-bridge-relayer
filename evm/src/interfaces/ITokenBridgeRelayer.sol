// SPDX-License-Identifier: Apache 2

pragma solidity ^0.8.13;

import {IWETH} from "./IWETH.sol";
import {IWormhole} from "./IWormhole.sol";
import {ITokenBridge} from "./ITokenBridge.sol";

interface ITokenBridgeRelayer {
    struct TransferWithRelay {
        uint8 payloadId; // == 1
        uint256 targetRelayerFee;
        uint256 toNativeTokenAmount;
        bytes32 targetRecipient;
    }

    event TransferRedeemed(
        uint16 indexed emitterChainId,
        bytes32 indexed emitterAddress,
        uint64 indexed sequence
    );

    function transferTokensWithRelay(
        address token,
        uint256 amount,
        uint256 toNativeTokenAmount,
        uint16 targetChain,
        bytes32 targetRecipient,
        uint32 batchId
    ) external payable returns (uint64 messageSequence);

    function wrapAndTransferEthWithRelay(
        uint256 toNativeTokenAmount,
        uint16 targetChain,
        bytes32 targetRecipient,
        uint32 batchId
    ) external payable returns (uint64 messageSequence);

    function completeTransferWithRelay(bytes calldata encodedTransferMessage) external payable;

    function encodeTransferWithRelay(TransferWithRelay memory transfer) external pure returns (bytes memory encoded);

    function decodeTransferWithRelay(bytes memory encoded) external pure returns (TransferWithRelay memory transfer);

    function calculateMaxSwapAmountIn(address token) external view returns (uint256);

    function calculateNativeSwapAmountOut(address token, uint256 toNativeAmount) external view returns (uint256);

    function bytes32ToAddress(bytes32 address_) external pure returns (address);

    function upgrade(uint16 chainId_, address newImplementation) external;

    function updateWormholeFinality(uint16 chainId_, uint8 newWormholeFinality) external;

    function submitOwnershipTransferRequest(uint16 chainId_, address newOwner) external;

    function confirmOwnershipTransferRequest() external;

    function registerContract(uint16 chainId_, bytes32 contractAddress) external;

    function registerToken(uint16 chainId_, address token) external;

    function deregisterToken(uint16 chainId_, address token) external;

    function updateRelayerFee(uint16 chainId_, uint256 amount) external;

    function updateRelayerFeePrecision(uint16 chainId_, uint256 relayerFeePrecision_) external;

    function updateSwapRate(uint16 chainId_, address token, uint256 swapRate) external;

    function updateSwapRatePrecision(uint16 chainId_, uint256 swapRatePrecision_) external;

    function updateMaxNativeSwapAmount(uint16 chainId_, address token, uint256 maxAmount) external;

    function owner() external view returns (address);

    function pendingOwner() external view returns (address);

    function isInitialized(address impl) external view returns (bool);

    function tokenBridge() external view returns (ITokenBridge);

    function wormhole() external view returns (IWormhole);

    function WETH() external view returns (IWETH);

    function chainId() external view returns (uint16);

    function relayerFeePrecision() external view returns (uint256);

    function relayerFee(uint16 chainId_) external view returns (uint256);

    function calculateRelayerFee(uint16 targetChainId, address token, uint8 decimals) external view returns (uint256 feeInTokenDenomination);

    function swapRatePrecision() external view returns (uint256);

    function swapRate(address token) external view returns (uint256);

    function nativeSwapRate(address token) external view returns (uint256);

    function maxNativeSwapAmount(address token) external view returns (uint256);

    function getRegisteredContract(uint16 emitterChainId) external view returns (bytes32);

    function isAcceptedToken(address token) external view returns (bool);

    function getAcceptedTokensList() external view returns (address[] memory);
}
