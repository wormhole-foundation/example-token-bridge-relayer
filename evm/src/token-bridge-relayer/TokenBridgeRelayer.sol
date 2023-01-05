// SPDX-License-Identifier: Apache 2
pragma solidity ^0.8.13;

import {IWormhole} from "../interfaces/IWormhole.sol";

import "../libraries/BytesLib.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./TokenBridgeRelayerGovernance.sol";
import "./TokenBridgeRelayerMessages.sol";

/**
 * @title Wormhole Token Bridge Relayer
 * @notice This contract composes on Wormhole's Token Bridge contracts to faciliate
 * one-click transfers of Token Bridge supported assets cross chain.
 */

contract TokenBridgeRelayer is TokenBridgeRelayerGovernance, TokenBridgeRelayerMessages, ReentrancyGuard {
    using BytesLib for bytes;

    /**
     * @notice Emitted when the transfer is completed by the Wormhole token bridge
     * @param emitterChainId Wormhole chain ID of emitter contract on source chain
     * @param emitterAddress Address (bytes32 zero-left-padded) of emitter on source chain
     * @param sequence Sequence of Wormhole message
     */
    event TransferCompleted(
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
        bool unwrapWeth,
        uint32 batchId
    ) public payable nonReentrant returns (uint64 messageSequence) {
        // Cache Wormhole fee value, and confirm that the caller has sent
        // enough value to pay for the Wormhole message fee.
        uint256 wormholeFee = wormhole().messageFee();
        require(msg.value == wormholeFee, "insufficient value");

        // Transfer tokens from user to the this contract, and
        // override amount with actual amount received.
        amount = custodyTokens(token, amount);

        // call the internal _transferTokensWithRelay function
        messageSequence = _transferTokensWithRelay(
            InternalTransferParams({
                token: token,
                amount: amount,
                toNativeTokenAmount: toNativeTokenAmount,
                targetChain: targetChain,
                targetRecipient: targetRecipient,
                unwrap: unwrapWeth
            }),
            batchId,
            wormholeFee
        );
    }

    function wrapAndTransferEthWithRelay(
        uint256 toNativeTokenAmount,
        uint16 targetChain,
        bytes32 targetRecipient,
        uint32 batchId
    ) public payable returns (uint64 messageSequence) {
        uint256 wormholeFee = wormhole().messageFee();
        require(msg.value > wormholeFee, "insufficient value");

        // remove the wormhole protocol fee from the amount
        uint256 amount = msg.value - wormholeFee;

        // refund dust
        uint256 dust = amount - denormalizeAmount(normalizeAmount(amount, 18), 18);
        if (dust > 0) {
            payable(msg.sender).transfer(dust);
        }

        // remove dust from amount and cache WETH
        uint256 amountLessDust = amount - dust;
        IWETH weth = WETH();

        // deposit into the WETH contract
        weth.deposit{
            value : amountLessDust
        }();

        // call the internal _transferTokensWithRelay function
        messageSequence = _transferTokensWithRelay(
            InternalTransferParams({
                token: address(weth),
                amount: amountLessDust,
                toNativeTokenAmount: toNativeTokenAmount,
                targetChain: targetChain,
                targetRecipient: targetRecipient,
                unwrap: false
            }),
            batchId,
            wormholeFee
        );
    }

    function _transferTokensWithRelay(
        InternalTransferParams memory params,
        uint32 batchId,
        uint256 wormholeFee
    ) internal returns (uint64 messageSequence) {
        // sanity check function arguments
        require(isAcceptedToken(params.token), "token not accepted");
        require(
            params.targetRecipient != bytes32(0),
            "targetRecipient cannot be bytes32(0)"
        );

        /**
         * Compute the normalized amount to verify that it's nonzero.
         * The token bridge peforms the same operation before encoding
         * the amount in the `TransferWithPayload` message.
         */
        uint8 tokenDecimals = getDecimals(params.token);
        require(
            normalizeAmount(params.amount, tokenDecimals) > 0,
            "normalized amount must be > 0"
        );

        // normalized toNativeTokenAmount should be nonzero
        uint256 normalizedToNativeTokenAmount = normalizeAmount(
            params.toNativeTokenAmount,
            tokenDecimals
        );
        require(
            params.toNativeTokenAmount == 0 || normalizedToNativeTokenAmount > 0,
            "normalized toNativeTokenAmount must be > 0"
        );

        // revert if unwrap is true and toNativeTokenAmount is > 0
        if (params.unwrap) {
            require(
                params.toNativeTokenAmount == 0,
                "cannot swap when unwrap is true"
            );
        }

        // Cache the target contract address and verify that there
        // is a registered emitter for the specified targetChain.
        bytes32 targetContract = getRegisteredContract(params.targetChain);
        require(targetContract != bytes32(0), "target not registered");

        // confirm that the user has sent enough tokens
        uint256 targetRelayerFee = relayerFee(params.targetChain, params.token);
        require(
            params.amount > targetRelayerFee + params.toNativeTokenAmount,
            "insufficient amount"
        );

        /**
         * Encode instructions (TransferWithRelay) to send with the token transfer.
         * The `targetRecipient` address is in bytes32 format (zero-left-padded) to
         * support non-evm smart contracts that have addresses that are longer
         * than 20 bytes.
         *
         * We normalize the targetRelayerFee and toNativeTokenAmount to support
         * non-evm smart contracts that can only handle uint64.max values.
         */
        bytes memory messagePayload = encodeTransferWithRelay(
            TransferWithRelay({
                payloadId: 1,
                targetRelayerFee: normalizeAmount(
                    targetRelayerFee,
                    tokenDecimals
                ),
                toNativeTokenAmount: normalizedToNativeTokenAmount,
                targetRecipient: params.targetRecipient,
                unwrap: params.unwrap
            })
        );

        // cache TokenBridge instance
        ITokenBridge bridge = tokenBridge();

        // approve the token bridge to spend the specified tokens
        SafeERC20.safeApprove(
            IERC20(params.token),
            address(bridge),
            params.amount
        );

        /**
         * Call `transferTokensWithPayload`method on the token bridge and pay
         * the Wormhole network fee. The token bridge will emit a Wormhole
         * message with an encoded `TransferWithPayload` struct (see the
         * ITokenBridge.sol interface file in this repo).
         */
        messageSequence = bridge.transferTokensWithPayload{value: wormholeFee}(
                params.token,
                params.amount,
                params.targetChain,
                targetContract,
                batchId,
                messagePayload
            );
    }

    function completeTransferWithRelay(bytes calldata encodedTransferMessage) public payable {
        // complete the transfer by calling the token bridge
        (bytes memory payload, uint256 amount, address token) =
             _completeTransfer(encodedTransferMessage);

        // parse the payload from the `TransferWithRelay` struct
        TransferWithRelay memory transferWithRelay = decodeTransferWithRelay(
            payload
        );

        // cache the recipient address
        address recipient = bytes32ToAddress(transferWithRelay.targetRecipient);

        // handle self redemptions
        if (msg.sender == recipient) {
            _completeSelfRedemption(
                token,
                recipient,
                amount,
                transferWithRelay.unwrap
            );

            // bail out
            return;
        }

        // cache token decimals
        uint8 tokenDecimals = getDecimals(token);

        // denormalize the encoded relayerFee
        transferWithRelay.targetRelayerFee = denormalizeAmount(
            transferWithRelay.targetRelayerFee,
            tokenDecimals
        );

        // unwrap and transfer ETH
        if (transferWithRelay.unwrap && token == address(WETH())) {
            _completeUnwrap(
                amount,
                recipient,
                transferWithRelay.targetRelayerFee
            );

            // bail out
            return;
        }

        // handle native asset payments and refunds
        if (transferWithRelay.toNativeTokenAmount > 0) {
            // denormalize the toNativeTokenAmount
            transferWithRelay.toNativeTokenAmount = denormalizeAmount(
                transferWithRelay.toNativeTokenAmount,
                tokenDecimals
            );

            /**
             * Compute the maximum amount of tokens that the user is allowed
             * to swap for native assets.
             *
             * Override the toNativeTokenAmount in transferWithRelay if the
             * toNativeTokenAmount is greater than the maxToNativeAllowed.
             *
             * Compute the amount of native assets to send the recipient.
             */
            uint256 nativeAmountForRecipient;
            uint256 maxToNativeAllowed = calculateMaxSwapAmountIn(token);
            if (transferWithRelay.toNativeTokenAmount > maxToNativeAllowed) {
                transferWithRelay.toNativeTokenAmount = maxToNativeAllowed;
                nativeAmountForRecipient = maxNativeSwapAmount(token);
            } else {
                // compute amount of native asset to pay the recipient
                nativeAmountForRecipient = calculateNativeSwapAmountOut(
                    token,
                    transferWithRelay.toNativeTokenAmount
                );
            }

            /**
             * The nativeAmountForRecipient can be zero if the user specifed
             * a toNativeTokenAmount that is too little to convert to native
             * asset. We need to override the toNativeTokenAmount to be zero
             * if that is the case, that way the user receives the full amount
             * of transfered tokens.
             */
            if (nativeAmountForRecipient > 0) {
                // check to see if the relayer sent enough value
                require(
                    msg.value >= nativeAmountForRecipient,
                    "insufficient native asset amount"
                );

                // refund excess native asset to relayer if applicable
                uint256 relayerRefund = msg.value - nativeAmountForRecipient;
                if (relayerRefund > 0) {
                    payable(msg.sender).transfer(relayerRefund);
                }

                // send requested native asset to target recipient
                payable(recipient).transfer(nativeAmountForRecipient);
            } else {
                // override the toNativeTokenAmount in transferWithRelay
                transferWithRelay.toNativeTokenAmount = 0;

                // refund the relayer any native asset sent to this contract
                if (msg.value > 0) {
                    payable(msg.sender).transfer(msg.value);
                }
            }
        }

        /**
         * Override the relayerFee if the encoded targetRelayerFee is less
         * than the relayer fee set on this chain. This should only happen
         * if relayer fees are not synchronized across all chains.
         */
        uint256 relayerFee = relayerFee(chainId(), token);
        if (relayerFee > transferWithRelay.targetRelayerFee) {
            relayerFee = transferWithRelay.targetRelayerFee;
        }

        // add the token swap amount to the relayer fee
        relayerFee = relayerFee + transferWithRelay.toNativeTokenAmount;

        // pay the relayer if relayerFee > 0 and the caller is not the recipient
        if (relayerFee > 0) {
            SafeERC20.safeTransfer(
                IERC20(token),
                msg.sender,
                relayerFee
            );
        }

        // pay the target recipient the remaining tokens
        SafeERC20.safeTransfer(
            IERC20(token),
            recipient,
            amount - relayerFee
        );
    }

    function _completeTransfer(
        bytes memory encodedTransferMessage
    ) internal returns (bytes memory, uint256, address) {
        /**
         * parse the encoded Wormhole message
         *
         * SECURITY: This message not been verified by the Wormhole core layer yet.
         * The encoded payload can only be trusted once the message has been verified
         * by the Wormhole core contract. In this case, the message will be verified
         * by a call to the token bridge contract in subsequent actions.
         */
        IWormhole.VM memory parsedMessage = wormhole().parseVM(
            encodedTransferMessage
        );

        /**
         * The amount encoded in the payload could be incorrect,
         * since fee-on-transfer tokens are supported by the token bridge.
         *
         * NOTE: The token bridge truncates the encoded amount for any token
         * with decimals greater than 8. This is to support blockchains that
         * cannot handle transfer amounts exceeding max(uint64).
         */
        address localTokenAddress = fetchLocalAddressFromTransferMessage(
            parsedMessage.payload
        );
        require(isAcceptedToken(localTokenAddress), "token not registered");

        // check balance before completing the transfer
        uint256 balanceBefore = getBalance(localTokenAddress);

        // cache the token bridge instance
        ITokenBridge bridge = tokenBridge();

        /**
         * Call `completeTransferWithPayload` on the token bridge. This
         * method acts as a reentrancy protection since it does not allow
         * transfers to be redeemed more than once.
         */
        bytes memory transferPayload = bridge.completeTransferWithPayload(
            encodedTransferMessage
        );

        // compute and save the balance difference after completing the transfer
        uint256 amountReceived = getBalance(localTokenAddress) - balanceBefore;

        // parse the wormhole message payload into the `TransferWithPayload` struct
        ITokenBridge.TransferWithPayload memory transfer =
            bridge.parseTransferWithPayload(transferPayload);

        // confirm that the message sender is a registered TokenBridgeRelayer contract
        require(
            transfer.fromAddress == getRegisteredContract(parsedMessage.emitterChainId),
            "contract not registered"
        );


        // Emit event with information about the TransferWithPayload message
        emit TransferCompleted(
            parsedMessage.emitterChainId,
            parsedMessage.emitterAddress,
            parsedMessage.sequence
        );

        return (
            transfer.payload,
            amountReceived,
            localTokenAddress
        );
    }

    function _completeSelfRedemption(
        address token,
        address recipient,
        uint256 amount,
        bool unwrap
    ) internal {
        // revert if the caller sends ether to this contract
        require(msg.value == 0, "recipient cannot swap native assets");

        // cache WETH instance
        IWETH weth = WETH();

        // transfer the full amount to the recipient
        if (unwrap && token == address(weth)) {
            // withdraw weth and send to the recipient
            weth.withdraw(amount);
            payable(recipient).transfer(amount);
        } else {
            SafeERC20.safeTransfer(
                IERC20(token),
                recipient,
                amount
            );
        }
    }

    function _completeUnwrap(
        uint256 amount,
        address recipient,
        uint256 encodedRelayerFee
    ) internal {
        // cache weth instance
        IWETH weth = WETH();

        /**
         * Override the relayerFee if the encoded targetRelayerFee is less
         * than the relayer fee set on this chain. This should only happen
         * if relayer fees are not synchronized across all chains.
         */
        uint256 relayerFee = relayerFee(chainId(), address(weth));
        if (relayerFee > encodedRelayerFee) {
            relayerFee = encodedRelayerFee;
        }

        // withdraw eth
        weth.withdraw(amount);

        // transfer eth to recipient
        payable(recipient).transfer(amount - relayerFee);

        // transfer relayer fee to the caller
        if (relayerFee > 0) {
            payable(msg.sender).transfer(relayerFee);
        }
    }

    /**
     * @notice Parses the encoded address and chainId from a `TransferWithPayload`
     * message. Finds the address of the wrapped token contract if the token is not
     * native to this chain.
     * @param payload Encoded `TransferWithPayload` message
     * @return localAddress Address of the encoded (bytes32 format) token address on
     * this chain.
     */
    function fetchLocalAddressFromTransferMessage(
        bytes memory payload
    ) public view returns (address localAddress) {
        // parse the source token address and chainId
        bytes32 sourceAddress = payload.toBytes32(33);
        uint16 tokenChain = payload.toUint16(65);

        // Fetch the wrapped address from the token bridge if the token
        // is not from this chain.
        if (tokenChain != chainId()) {
            // identify wormhole token bridge wrapper
            localAddress = tokenBridge().wrappedAsset(tokenChain, sourceAddress);
            require(localAddress != address(0), "token not attested");
        } else {
            // return the encoded address if the token is native to this chain
            localAddress = bytes32ToAddress(sourceAddress);
        }
    }

    /**
     * @notice Calculates the max amount of tokens the user can convert to
     * native assets on this chain.
     * @dev The max amount of native assets the contract will swap with the user
     * is governed by the `maxNativeSwapAmount` state variable.
     * @param token Address of token being transferred.
     * @return maxAllowed The maximum number of tokens the user is allowed to
     * swap for native assets.
     */
    function calculateMaxSwapAmountIn(
        address token
    ) public view returns (uint256 maxAllowed) {
        // cache swap rate
        uint256 swapRate = nativeSwapRate(token);
        require(swapRate > 0, "swap rate not set");
        maxAllowed =
            (maxNativeSwapAmount(token) * swapRate) /
            (10 ** (18 - getDecimals(token)) * nativeSwapRatePrecision());
    }

    /**
     * @notice Calculates the amount of native assets that a user will receive
     * when swapping transferred tokens for native assets.
     * @dev The swap rate is governed by the `nativeSwapRate` state variable.
     * @param token Address of token being transferred.
     * @param toNativeAmount Quantity of tokens to be converted to native assets.
     * @return nativeAmount The exchange rate between native assets and the `toNativeAmount`
     * of transferred tokens.
     */
    function calculateNativeSwapAmountOut(
        address token,
        uint256 toNativeAmount
    ) public view returns (uint256 nativeAmount) {
        // cache swap rate
        uint256 swapRate = nativeSwapRate(token);
        require(swapRate > 0, "swap rate not set");
        nativeAmount =
            nativeSwapRatePrecision() * toNativeAmount /
            swapRate * 10 ** (18 - getDecimals(token));
    }

    function custodyTokens(
        address token,
        uint256 amount
    ) internal returns (uint256) {
        // query own token balance before transfer
        uint256 balanceBefore = getBalance(token);

        // deposit tokens
        SafeERC20.safeTransferFrom(
            IERC20(token),
            msg.sender,
            address(this),
            amount
        );

        // return the balance difference
        return getBalance(token) - balanceBefore;
    }

    function bytes32ToAddress(bytes32 address_) internal pure returns (address) {
        require(bytes12(address_) == 0, "invalid EVM address");
        return address(uint160(uint256(address_)));
    }

    // necessary for receiving native assets
    receive() external payable {}
}
