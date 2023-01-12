// SPDX-License-Identifier: Apache 2
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "forge-std/console.sol";

import {IWETH} from "../src/interfaces/IWETH.sol";
import {IWormhole} from "../src/interfaces/IWormhole.sol";
import {ITokenBridge} from "../src/interfaces/ITokenBridge.sol";
import {ITokenBridgeRelayer} from "../src/interfaces/ITokenBridgeRelayer.sol";

import {ForgeHelpers} from "wormhole-solidity/ForgeHelpers.sol";
import {Helpers} from "./Helpers.sol";

import {TokenBridgeRelayerSetup} from "../src/token-bridge-relayer/TokenBridgeRelayerSetup.sol";
import {TokenBridgeRelayerProxy} from "../src/token-bridge-relayer/TokenBridgeRelayerProxy.sol";
import {TokenBridgeRelayerImplementation} from "../src/token-bridge-relayer/TokenBridgeRelayerImplementation.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../src/libraries/BytesLib.sol";

/**
 * @title A Test Suite for the EVM Token Bridge Relayer Messages module
 */
contract TestTokenBridgeRelayerMessages is Helpers, ForgeHelpers, Test {
    using BytesLib for bytes;

    // contract instances
    IWormhole wormhole;
    ITokenBridgeRelayer avaxRelayer;

    function setupTokenBridgeRelayer() internal {
        // deploy Setup
        TokenBridgeRelayerSetup setup = new TokenBridgeRelayerSetup();

        // deploy Implementation
        TokenBridgeRelayerImplementation implementation =
            new TokenBridgeRelayerImplementation();

        // cache avax chain ID
        uint16 avaxChainId = 6;

        // wormhole address
        address wormholeAddress = vm.envAddress("TESTING_AVAX_WORMHOLE_ADDRESS");

        // deploy Proxy
        TokenBridgeRelayerProxy proxy = new TokenBridgeRelayerProxy(
            address(setup),
            abi.encodeWithSelector(
                bytes4(
                    keccak256("setup(address,uint16,address,address,uint256,uint256)")
                ),
                address(implementation),
                avaxChainId,
                wormholeAddress,
                vm.envAddress("TESTING_AVAX_BRIDGE_ADDRESS"),
                1e8, // initial swap rate precision
                1e8 // initial relayer fee precision
            )
        );
        avaxRelayer = ITokenBridgeRelayer(address(proxy));

        // verify initial state
        assertEq(avaxRelayer.isInitialized(address(implementation)), true);
        assertEq(avaxRelayer.chainId(), avaxChainId);
        assertEq(address(avaxRelayer.wormhole()), wormholeAddress);
        assertEq(
            address(avaxRelayer.tokenBridge()),
            vm.envAddress("TESTING_AVAX_BRIDGE_ADDRESS")
        );
        assertEq(avaxRelayer.swapRatePrecision(), 1e8);
        assertEq(avaxRelayer.relayerFeePrecision(), 1e8);
    }

    /**
     * @notice sets up the Token Bridge Relayer contract before each test
     */
    function setUp() public {
        setupTokenBridgeRelayer();
    }

    /**
     * @notice This test confirms that the contract will not encode
     * TransferWithRelay messages when payloadId is not 1.
     */
    function testMessageSerializationWrongPayloadID(
        uint8 invalidPayloadId
    ) public {
        vm.assume(invalidPayloadId != 1);

        // expect call to encodeTransferWithRelay to revert
        ITokenBridgeRelayer.TransferWithRelay memory transferStruct =
            ITokenBridgeRelayer.TransferWithRelay({
                payloadId: invalidPayloadId,
                targetRelayerFee: 1e10,
                toNativeTokenAmount: 1e1,
                targetRecipient: addressToBytes32(address(this))
            });

        // expet the encodeTransferWithRelay call to revert
        vm.expectRevert("invalid payloadId");
        avaxRelayer.encodeTransferWithRelay(transferStruct);
    }

    /**
     * @notice This test confirms that the contract is able to serialize and
     * deserialize the TransferWithRelay message.
     */
    function testMessages(
        uint256 targetRelayerFee,
        uint256 toNativeAmount,
        bytes32 targetRecipientWallet
        ) public {
        vm.assume(targetRecipientWallet != bytes32(0));
        vm.assume(toNativeAmount < targetRelayerFee);

        // encode the message by calling encodeTransferWithRelay
        bytes memory encodedMessage = avaxRelayer.encodeTransferWithRelay(
            ITokenBridgeRelayer.TransferWithRelay({
                payloadId: 1,
                targetRelayerFee: targetRelayerFee,
                toNativeTokenAmount: toNativeAmount,
                targetRecipient: targetRecipientWallet
            })
        );

        // decode the message by calling decodeTransferWithRelay
        ITokenBridgeRelayer.TransferWithRelay memory parsed =
            avaxRelayer.decodeTransferWithRelay(encodedMessage);

        // verify the parsed output
        assertEq(parsed.payloadId, 1);
        assertEq(parsed.targetRelayerFee, targetRelayerFee);
        assertEq(parsed.toNativeTokenAmount, toNativeAmount);
        assertEq(parsed.targetRecipient, targetRecipientWallet);
    }

    /**
     * @notice This test confirms that decodeTransferWithRelay reverts
     * when a message has an unexpected payloadId.
     */
    function testIncorrectMessagePayloadId(
        uint256 targetRelayerFee,
        uint256 toNativeAmount,
        bytes32 targetRecipientWallet
        ) public {
        vm.assume(targetRecipientWallet != bytes32(0));
        vm.assume(toNativeAmount < targetRelayerFee);

        // encode the message by calling encodeTransferTokensWithRelay
        bytes memory encodedMessage = avaxRelayer.encodeTransferWithRelay(
            ITokenBridgeRelayer.TransferWithRelay({
                payloadId: 1,
                targetRelayerFee: targetRelayerFee,
                toNativeTokenAmount: toNativeAmount,
                targetRecipient: targetRecipientWallet
            })
        );

        // convert the first byte (payloadId) from 1 to 2
        bytes memory alteredEncodedMessage = abi.encodePacked(
            uint8(2),
            encodedMessage.slice(1, encodedMessage.length - 1)
        );

        // expect the decodeTransferWithRelay call to revert
        vm.expectRevert("invalid payloadId");
        avaxRelayer.decodeTransferWithRelay(alteredEncodedMessage);
    }

    /**
     * @notice This test confirms that decodeTransferWithRelay reverts
     * when a message has an unexpected payloadId.
     */
    function testInvalidMessageLength(
        uint256 targetRelayerFee,
        uint256 toNativeAmount,
        bytes32 targetRecipientWallet
        ) public {
        vm.assume(targetRecipientWallet != bytes32(0));
        vm.assume(toNativeAmount < targetRelayerFee);

        // encode the message by calling encodeTransferWithRelay
        bytes memory encodedMessage = avaxRelayer.encodeTransferWithRelay(
            ITokenBridgeRelayer.TransferWithRelay({
                payloadId: 1,
                targetRelayerFee: targetRelayerFee,
                toNativeTokenAmount: toNativeAmount,
                targetRecipient: targetRecipientWallet
            })
        );

        // add some additional bytes to the encoded message
        bytes memory alteredEncodedMessage = abi.encodePacked(
            encodedMessage,
            uint256(42069)
        );

        // expect the decodeTransferWithRelay call to revert
        vm.expectRevert("invalid message length");
        avaxRelayer.decodeTransferWithRelay(alteredEncodedMessage);
    }
}
