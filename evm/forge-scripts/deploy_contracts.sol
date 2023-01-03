// SPDX-License-Identifier: Apache 2

pragma solidity ^0.8.13;

import "forge-std/Script.sol";
import "forge-std/console.sol";

import {IWormhole} from "../src/interfaces/IWormhole.sol";
import {ITokenBridge} from "../src/interfaces/ITokenBridge.sol";
import {ITokenBridgeRelayer} from "../src/interfaces/ITokenBridgeRelayer.sol";

import {TokenBridgeRelayerSetup} from "../src/token-bridge-relayer/TokenBridgeRelayerSetup.sol";
import {TokenBridgeRelayerProxy} from "../src/token-bridge-relayer/TokenBridgeRelayerProxy.sol";
import {TokenBridgeRelayerImplementation} from "../src/token-bridge-relayer/TokenBridgeRelayerImplementation.sol";

contract ContractScript is Script {
    IWormhole wormhole;
    ITokenBridgeRelayer tokenBridgeRelayerImplementation;

    // TokenBridgeRelayer contracts
    TokenBridgeRelayerSetup setup;
    TokenBridgeRelayerImplementation implementation;
    TokenBridgeRelayerProxy proxy;

    // TokenBridgeRelayer instance (post deployment)
    ITokenBridgeRelayer relayer;

    function setUp() public {
        wormhole = IWormhole(vm.envAddress("RELEASE_WORMHOLE_ADDRESS"));
    }

    function deployTokenBridgeRelayer() public {
        // first Setup
        setup = new TokenBridgeRelayerSetup();

        // next Implementation
        implementation = new TokenBridgeRelayerImplementation();

        // setup Proxy using Implementation
        proxy = new TokenBridgeRelayerProxy(
            address(setup),
            abi.encodeWithSelector(
                bytes4(keccak256("setup(address,uint16,address,address,uint256)")),
                address(implementation),
                wormhole.chainId(),
                address(wormhole),
                vm.envAddress("RELEASE_BRIDGE_ADDRESS"),
                vm.envUint("RELEASE_SWAP_RATE_PRECISION")
            )
        );

        relayer = ITokenBridgeRelayer(address(proxy));
    }

    function run() public {
        // begin sending transactions
        vm.startBroadcast();

        // CircleRelayer.sol
        console.log("Deploying relayer contracts");
        deployTokenBridgeRelayer();

        // finished
        vm.stopBroadcast();
    }
}
