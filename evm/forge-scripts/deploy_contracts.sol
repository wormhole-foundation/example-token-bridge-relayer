// SPDX-License-Identifier: Apache 2

pragma solidity ^0.8.17;

import "forge-std/Script.sol";
import "forge-std/console.sol";

import {IWormhole} from "../src/interfaces/IWormhole.sol";
import {ITokenBridge} from "../src/interfaces/ITokenBridge.sol";
import {ITokenBridgeRelayer} from "../src/interfaces/ITokenBridgeRelayer.sol";

import {TokenBridgeRelayer} from "../src/token-bridge-relayer/TokenBridgeRelayer.sol";

contract ContractScript is Script {
    // Wormhole Interface
    IWormhole wormhole;

    // TokenBridgeRelayer instance (post deployment)
    ITokenBridgeRelayer relayer;

    function setUp() public {
        wormhole = IWormhole(vm.envAddress("RELEASE_WORMHOLE_ADDRESS"));
    }

    function deployTokenBridgeRelayer() public {
        // read environment variables
        address tokenBridgeAddress = vm.envAddress("RELEASE_BRIDGE_ADDRESS");
        address wethAddress = vm.envAddress("RELEASE_WETH_ADDRESS");
        bool shouldUnwrapWeth = vm.envBool("RELEASE_UNWRAP_WETH");
        uint256 swapRatePrecision = vm.envUint("RELEASE_SWAP_RATE_PRECISION");
        uint256 relayerFeePrecision = vm.envUint("RELEASE_RELAYER_FEE_PRECISION");

        // deploy the contract and set up the contract
        TokenBridgeRelayer deployedRelayer = new TokenBridgeRelayer(
            wormhole.chainId(),
            address(wormhole),
            tokenBridgeAddress,
            wethAddress,
            shouldUnwrapWeth,
            swapRatePrecision,
            relayerFeePrecision
        );

        // check the contract getters
        relayer = ITokenBridgeRelayer(address(deployedRelayer));

        // verify getters
        require(relayer.chainId() == wormhole.chainId());
        require(address(relayer.wormhole()) == address(wormhole));
        require(address(relayer.tokenBridge()) == tokenBridgeAddress);
        require(relayer.swapRatePrecision() == swapRatePrecision);
        require(relayer.relayerFeePrecision() == relayerFeePrecision);
        require(address(relayer.WETH()) == wethAddress);
        require(relayer.unwrapWeth() == shouldUnwrapWeth);
    }

    function run() public {
        // begin sending transactions
        vm.startBroadcast();

        // TokenBridgeRelayer.sol
        console.log("Deploying relayer contracts");
        deployTokenBridgeRelayer();

        // finished
        vm.stopBroadcast();
    }
}
