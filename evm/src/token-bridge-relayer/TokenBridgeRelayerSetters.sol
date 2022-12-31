// SPDX-License-Identifier: Apache 2
pragma solidity ^0.8.13;

import "./TokenBridgeRelayerState.sol";

contract TokenBridgeRelayerSetters is TokenBridgeRelayerState {
    function setInitialized(address implementatiom) internal {
        _state.initializedImplementations[implementatiom] = true;
    }

    function setOwner(address owner_) internal {
        _state.owner = owner_;
    }

    function setPendingOwner(address pendingOwner_) internal {
        _state.pendingOwner = pendingOwner_;
    }

    function setWormhole(address wormhole_) internal {
        _state.wormhole = payable(wormhole_);
    }

    function setTokenBridge(address tokenBridge_) internal {
        _state.tokenBridge = payable(tokenBridge_);
    }

    function setWethAddress(address weth_) internal {
        _state.wethAddress = weth_;
    }

    function setChainId(uint16 chainId_) internal {
        _state.chainId = chainId_;
    }

    function _registerContract(uint16 chainId_, bytes32 contract_) internal {
        _state.registeredContracts[chainId_] = contract_;
    }

    function setNativeSwapRatePrecision(uint256 precision) internal {
        _state.nativeSwapRatePrecision = precision;
    }

    function addAcceptedToken(address token) internal {
        _state.acceptedTokens[token] = true;
    }

    function setRelayerFee(uint16 chainId_, address token, uint256 fee) internal {
        _state.relayerFees[chainId_][token] = fee;
    }

    function setNativeSwapRate(address token, uint256 swapRate) internal {
        _state.nativeSwapRates[token] = swapRate;
    }

    function setMaxNativeSwapAmount(address token, uint256 maximum) internal {
        _state.maxNativeSwapAmount[token] = maximum;
    }
}
