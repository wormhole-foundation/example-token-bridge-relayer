// SPDX-License-Identifier: Apache 2

pragma solidity ^0.8.17;

import "forge-std/Script.sol";
import "forge-std/console.sol";

import {IWETH} from "../src/interfaces/IWETH.sol";
import {ITokenBridge} from "../src/interfaces/ITokenBridge.sol";
import {ITokenBridgeRelayer} from "../src/interfaces/ITokenBridgeRelayer.sol";

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function decimals() external returns (uint8);
}

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
    ) internal returns (address localAddress) {
        if (tokenChain != tokenBridge.chainId()) {
            // identify wormhole token bridge wrapper
            localAddress = tokenBridge.wrappedAsset(tokenChain, token);
            require(localAddress != address(0), "token not attested");
        } else {
            // return the encoded address if the token is native to this chain
            localAddress = address(uint160(uint256((token))));
        }

    }

    function wrap(
        uint256 amount
    ) internal {
        IWETH(address(relayer.WETH())).deposit{value: amount}();
    }

    function transferTokensWithRelay(
        bytes32 token,
        uint16 tokenChain,
        uint256 amount,
        uint256 toNativeTokenAmount,
        uint16 targetChain,
        bytes32 targetRecipient,
        uint32 batchId
    ) internal {
        address localAddress = localTokenAddress(tokenChain, token);

        console.log("Transferring token: %s to chain: %s", localAddress, targetChain);
        console.log("Amount: %s, toNative: %s", amount, toNativeTokenAmount);

        // fetch token decimals
        uint8 decimals = IERC20(localAddress).decimals();

        // fetch the relayerFee
        uint256 relayerFee = relayer.calculateRelayerFee(targetChain, localAddress, decimals);
        uint256 swapRate = relayer.swapRate(localAddress);
        uint256 nativeSwapRate = relayer.swapRate(address(relayer.WETH()));

        console.log(
            "SwapRate: %s, NativeSwapRate: %s, RelayerFee: %s",
            swapRate,
            nativeSwapRate,
            relayerFee
        );

        // approve relayer to spend tokens
        IERC20(localAddress).approve(address(relayer), amount);

        // test transfer tokens
        relayer.transferTokensWithRelay(
            localAddress,
            amount,
            toNativeTokenAmount,
            targetChain,
            targetRecipient,
            batchId
        );
    }

    function transferEthWithRelay(
        uint256 amount,
        uint256 toNativeTokenAmount,
        uint16 targetChain,
        bytes32 targetRecipient,
        uint32 batchId
    ) internal {
        address weth = address(relayer.WETH());

        console.log("Transferring Weth to chain: %s", targetChain);
        console.log("Amount: %s, toNative: %s", amount, toNativeTokenAmount);

        // fetch the relayerFee
        uint256 relayerFee = relayer.calculateRelayerFee(targetChain, weth, 18);
        uint256 swapRate = relayer.swapRate(weth);

        console.log(
            "SwapRate: %s, RelayerFee: %s",
            swapRate,
            relayerFee
        );

        relayer.wrapAndTransferEthWithRelay{value: amount}(
            toNativeTokenAmount,
            targetChain,
            targetRecipient,
            batchId
        );
    }

    function run() public {
        // begin sending transactions
        vm.startBroadcast();

        // test transfer tokens
        bool isNative = vm.envBool("TEST_IS_NATIVE");
        bool shouldWrap = vm.envBool("TEST_SHOULD_WRAP");
        bytes32 token = vm.envBytes32("TEST_TOKEN");
        uint16 tokenChain = uint16(vm.envUint("TEST_TOKEN_CHAIN"));
        uint256 amount = vm.envUint("TEST_AMOUNT");
        uint256 toNativeTokenAmount = vm.envUint("TEST_TO_NATIVE_AMOUNT");
        uint16 targetChain = uint16(vm.envUint("TEST_TARGET_CHAIN_ID"));
        bytes32 targetRecipient = bytes32(vm.envBytes32("TEST_TARGET_RECIPIENT"));

        // transfer tokens
        if (isNative) {
            transferEthWithRelay(
                amount,
                toNativeTokenAmount,
                targetChain,
                targetRecipient,
                0
            );
        } else {
            // wrap weth if specified
            if (shouldWrap) {
                console.log("Wrapping amount: %s", amount);
                wrap(amount);
            }

            transferTokensWithRelay(
                token,
                tokenChain,
                amount,
                toNativeTokenAmount,
                targetChain,
                targetRecipient,
                0
            );
        }

        // finished
        vm.stopBroadcast();
    }
}
