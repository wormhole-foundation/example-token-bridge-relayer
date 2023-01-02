// SPDX-License-Identifier: Apache 2
pragma solidity ^0.8.13;

import {IWormhole} from "../interfaces/IWormhole.sol";
import {ITokenBridge} from "../interfaces/ITokenBridge.sol";
import {IWETH} from "../interfaces/IWETH.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

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

    function getDecimals(address token) internal view returns (uint8) {
        (,bytes memory queriedDecimals) = token.staticcall(
            abi.encodeWithSignature("decimals()")
        );
        return abi.decode(queriedDecimals, (uint8));
    }

    function getBalance(address token) internal view returns (uint256 balance) {
        // fetch the specified token balance for this contract
        (, bytes memory queriedBalance) =
            token.staticcall(
                abi.encodeWithSelector(IERC20.balanceOf.selector, address(this))
            );
        balance = abi.decode(queriedBalance, (uint256));
    }

    function normalizeAmount(
        uint256 amount,
        uint8 decimals
    ) public pure returns(uint256) {
        if (decimals > 8) {
            amount /= 10 ** (decimals - 8);
        }
        return amount;
    }

    function denormalizeAmount(
        uint256 amount,
        uint8 decimals
    ) public pure returns(uint256){
        if (decimals > 8) {
            amount *= 10 ** (decimals - 8);
        }
        return amount;
    }
}
