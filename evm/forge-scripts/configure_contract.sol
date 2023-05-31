// SPDX-License-Identifier: Apache 2

pragma solidity ^0.8.17;

import "forge-std/Script.sol";
import "forge-std/console.sol";

import {IWETH} from "../src/interfaces/IWETH.sol";
import {ITokenBridge} from "../src/interfaces/ITokenBridge.sol";
import {ITokenBridgeRelayer} from "../src/interfaces/ITokenBridgeRelayer.sol";

contract ContractScript is Script {
    // contracts
    ITokenBridgeRelayer relayer;
    ITokenBridge tokenBridge;

    function setUp() public {
        relayer = ITokenBridgeRelayer(vm.envAddress("RELAYER_CONTRACT_ADDRESS"));
        tokenBridge = ITokenBridge(vm.envAddress("RELEASE_BRIDGE_ADDRESS"));
    }

    function localTokenAddress(
        uint16 tokenChain,
        bytes32 token
    ) internal view returns (address localAddress) {
        if (tokenChain != tokenBridge.chainId()) {
            // identify wormhole token bridge wrapper
            localAddress = tokenBridge.wrappedAsset(tokenChain, token);
            require(localAddress != address(0), "token not attested");
        } else {
            // return the encoded address if the token is native to this chain
            localAddress = address(uint160(uint256((token))));
        }
    }

    function logAcceptedTokens() internal view {
        address[] memory acceptedTokens = relayer.getAcceptedTokensList();

        uint256 numTokens = acceptedTokens.length;
        for (uint256 i = 0; i < numTokens;) {
            console.log("Accepted token: %s", acceptedTokens[i]);
            unchecked {i += 1;}
        }
    }

    function _registerToken(address token) internal {
        // confirm that the token isn't already registered
        require(!relayer.isAcceptedToken(token), "already registered");

        // register the token
        relayer.registerToken(relayer.chainId(), token);

        // confirm state changes
        require(relayer.isAcceptedToken(token), "not registered");

        console.log("Token registered: %s", token);

        logAcceptedTokens();
    }

    function _deregisterToken(address token) internal {
        // confirm that the token is registered
        require(relayer.isAcceptedToken(token), "not registered");

        // deregister the token
        relayer.deregisterToken(relayer.chainId(), token);

        // confirm state changes
        require(
            !relayer.isAcceptedToken(token) &&
            relayer.swapRate(token) == 0 &&
            relayer.maxNativeSwapAmount(token) == 0,
            "still registered"
        );

        console.log("Token deregistered: %s", token);

        logAcceptedTokens();
    }

    function _setSwapRate(address token, uint256 swapRate) internal {
        // confirm that the token is registered
        require(relayer.isAcceptedToken(token), "not registered");

        ITokenBridgeRelayer.SwapRateUpdate[] memory update =
            new ITokenBridgeRelayer.SwapRateUpdate[](1);

        update[0] = ITokenBridgeRelayer.SwapRateUpdate({
            token: token,
            value: swapRate
        });

        // set the swap rate
        relayer.updateSwapRate(relayer.chainId(), update);

        // confirm state changes
        require(relayer.swapRate(token) == swapRate, "invalid swapRate");

        console.log("Swap rate set, token: %s, amount: %s", token, swapRate);
    }

    function _setMaxNativeSwapAmount(address token, uint256 maxAmount) internal {
        // confirm that the token is registered
        require(relayer.isAcceptedToken(token), "not registered");

        // set the swap rate
        relayer.updateMaxNativeSwapAmount(relayer.chainId(), token, maxAmount);

        // confirm state changes
        require(
            relayer.maxNativeSwapAmount(token) == maxAmount,
            "invalid max swap amount"
        );

        console.log(
            "Max native amount set, token: %s, amount: %s",
            token,
            maxAmount
        );
    }

    function _setRelayerFee(uint16 targetChain, uint256 relayerFee) internal {
        relayer.updateRelayerFee(targetChain, relayerFee);

        require(relayer.relayerFee(targetChain) == relayerFee, "invalid fee");

        console.log(
            "Relayer fee updated, chainId: %s, fee: %s",
            targetChain,
            relayerFee
        );
    }

    /**
     * @dev The token environment variables are read separately for each action
     * to bypass having to set all values in the environment file.
     */
    function run() public {
        // begin sending transactions
        vm.startBroadcast();

        // test transfer tokens
        bool register = vm.envBool("CONFIG_REGISTER");
        bool deregister = vm.envBool("CONFIG_DEREGISTER");
        bool setSwapRate = vm.envBool("CONFIG_SET_SWAP_RATE");
        bool setMaxNativeAmount = vm.envBool("CONFIG_SET_MAX_NATIVE");
        bool setRelayerFee = vm.envBool("CONFIG_SET_RELAYER_FEE");

        require(!(register && deregister), "cannot register and deregister");

        // register token
        if (register) {
            address localAddress = localTokenAddress(
                uint16(vm.envUint("CONFIG_TOKEN_CHAIN")),
                vm.envBytes32("CONFIG_TOKEN")
            );

            _registerToken(localAddress);
        }

        // deregister token
        if (deregister) {
            address localAddress = localTokenAddress(
                uint16(vm.envUint("CONFIG_TOKEN_CHAIN")),
                vm.envBytes32("CONFIG_TOKEN")
            );

            _deregisterToken(localAddress);
        }

        // set swap rate
        if (setSwapRate) {
            address localAddress = localTokenAddress(
                uint16(vm.envUint("CONFIG_TOKEN_CHAIN")),
                vm.envBytes32("CONFIG_TOKEN")
            );
            uint256 swapRate = vm.envUint("CONFIG_SWAP_RATE");
            require(swapRate > 0, "swapRate must be > 0");

            _setSwapRate(localAddress, swapRate);
        }

        // set max native swap amount
        if (setMaxNativeAmount) {
            address localAddress = localTokenAddress(
                uint16(vm.envUint("CONFIG_TOKEN_CHAIN")),
                vm.envBytes32("CONFIG_TOKEN")
            );
            uint256 maxAmount = vm.envUint("CONFIG_MAX_NATIVE");

            _setMaxNativeSwapAmount(localAddress, maxAmount);
        }

        // set the relayer fee the specified chain
        if (setRelayerFee) {
            uint16 targetChain = uint16(
                vm.envUint("CONFIG_RELAYER_FEE_TARGET_CHAIN")
            );
            uint256 relayerFee = vm.envUint("CONFIG_RELAYER_FEE");

            _setRelayerFee(targetChain, relayerFee);
        }

        // finished
        vm.stopBroadcast();
    }
}
