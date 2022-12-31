// SPDX-License-Identifier: Apache 2
pragma solidity ^0.8.13;

import {IWormhole} from "../interfaces/IWormhole.sol";
import {ITokenBridge} from "../interfaces/ITokenBridge.sol";
import {IWETH} from "../interfaces/IWETH.sol";

import "./TokenBridgeRelayerSetters.sol";

contract TokenBridgeRelayerGetters is TokenBridgeRelayerSetters {
    function isInitialized(address impl) public view returns (bool) {
        return _state.initializedImplementations[impl];
    }

    function owner() public view returns (address) {
        return _state.owner;
    }

    function pendingOwner() public view returns (address) {
        return _state.pendingOwner;
    }

    function wormhole() public view returns (IWormhole) {
        return IWormhole(_state.wormhole);
    }

    function tokenBridge() public view returns (ITokenBridge) {
        return ITokenBridge(payable(_state.tokenBridge));
    }

    function WETH() public view returns (IWETH){
        return IWETH(_state.wethAddress);
    }

    function chainId() public view returns (uint16) {
        return _state.chainId;
    }

    function getRegisteredContract(uint16 emitterChainId) public view returns (bytes32) {
        return _state.registeredContracts[emitterChainId];
    }

    function nativeSwapRatePrecision() public view returns (uint256) {
        return _state.nativeSwapRatePrecision;
    }

    function isAcceptedToken(address token) public view returns (bool) {
        return _state.acceptedTokens[token];
    }

    function relayerFee(uint16 chainId_, address token) public view returns (uint256) {
        return _state.relayerFees[chainId_][token];
    }

    function nativeSwapRate(address token) public view returns (uint256) {
        return _state.nativeSwapRates[token];
    }

    function maxNativeSwapAmount(address token) public view returns (uint256) {
        return _state.maxNativeSwapAmount[token];
    }
}
