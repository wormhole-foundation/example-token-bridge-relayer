// SPDX-License-Identifier: Apache 2
pragma solidity ^0.8.13;

import {IWormhole} from "../interfaces/IWormhole.sol";

contract TokenBridgeRelayerStorage {
    struct State {
        // Wormhole chain ID of this contract
        uint16 chainId;

        // owner of this contract
        address owner;

        // intermediate state when transfering contract ownership
        address pendingOwner;

        // address of the Wormhole contract on this chain
        address wormhole;

        // address of the Wormhole TokenBridge contract on this chain
        address tokenBridge;

        // precision of the nativeSwapRates, this value should NEVER be set to zero
        uint256 nativeSwapRatePrecision;

        // mapping of initialized implementation (logic) contracts
        mapping(address => bool) initializedImplementations;

        // Wormhole chain ID to known relayer contract address mapping
        mapping(uint16 => bytes32) registeredContracts;

        // allowed list of tokens
        mapping(address => bool) acceptedTokens;

        /**
         * Mapping of source token address to native asset swap rate
         * (nativePriceUSD/tokenPriceUSD).
         */
        mapping(address => uint256) nativeSwapRates;

        /**
         * Mapping of source token address to maximum native asset swap amount
         * allowed.
         */
        mapping(address => uint256) maxNativeSwapAmount;

        // mapping of chainId to token address to relayerFee
        mapping(uint16 => mapping(address => uint256)) relayerFees;
    }
}

contract TokenBridgeRelayerState {
    TokenBridgeRelayerStorage.State _state;
}

