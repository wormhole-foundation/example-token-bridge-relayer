// SPDX-License-Identifier: Apache 2
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "forge-std/console.sol";

import {IWETH} from "../src/interfaces/IWETH.sol";
import {IWormhole} from "../src/interfaces/IWormhole.sol";
import {ITokenBridge} from "../src/interfaces/ITokenBridge.sol";

import {WormholeSimulator} from "wormhole-solidity/WormholeSimulator.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";


/**
 * @title A Test Suite for the EVM HelloToken Contracts
 */
contract TokenBridgeRelayer is Test {
    // guardian private key for simulated signing of Wormhole messages
    uint256 guardianSigner;

    // relayer fee precision
    uint32 relayerFeePrecision;

    // ethereum test info
    uint16 ethereumChainId;
    address ethereumTokenBridge;
    address weth;

    // contract instances
    IWETH wavax;
    IWormhole wormhole;
    ITokenBridge bridge;
    WormholeSimulator wormholeSimulator;

    // used to compute balance changes before/after redeeming token transfers
    struct Balances {
        uint256 recipientBefore;
        uint256 recipientAfter;
        uint256 relayerBefore;
        uint256 relayerAfter;
    }

    /**
     * @notice Sets up the wormholeSimulator contracts and deploys HelloToken
     * contracts before each test is executed.
     */
    function setUp() public {
        // verify that we're using the correct fork (AVAX mainnet in this case)
        require(block.chainid == vm.envUint("TESTING_AVAX_FORK_CHAINID"), "wrong evm");

        // this will be used to sign Wormhole messages
        guardianSigner = uint256(vm.envBytes32("TESTING_DEVNET_GUARDIAN"));

        // set up Wormhole using Wormhole existing on AVAX mainnet
        wormholeSimulator = new WormholeSimulator(
            vm.envAddress("TESTING_AVAX_WORMHOLE_ADDRESS"),
            guardianSigner
        );

        // we may need to interact with Wormhole throughout the test
        wormhole = wormholeSimulator.wormhole();

        // verify Wormhole state from fork
        require(
            wormhole.chainId() == uint16(vm.envUint("TESTING_AVAX_WORMHOLE_CHAINID")),
            "wrong chainId"
        );
        require(
            wormhole.messageFee() == vm.envUint("TESTING_AVAX_WORMHOLE_MESSAGE_FEE"),
            "wrong messageFee"
        );
        require(
            wormhole.getCurrentGuardianSetIndex() == uint32(
                vm.envUint("TESTING_AVAX_WORMHOLE_GUARDIAN_SET_INDEX")
            ),
            "wrong guardian set index"
        );

        // instantiate wavax interface
        wavax = IWETH(vm.envAddress("TESTING_WRAPPED_AVAX_ADDRESS"));

        // instantiate TokenBridge interface
        bridge = ITokenBridge(vm.envAddress("TESTING_AVAX_BRIDGE_ADDRESS"));

        // set the ethereum token bridge, chainId and WETH addresses
        ethereumTokenBridge = vm.envAddress("TESTING_ETH_BRIDGE_ADDRESS");
        ethereumChainId = uint16(vm.envUint("TESTING_ETH_WORMHOLE_CHAINID"));
        weth = vm.envAddress("TESTING_WRAPPED_ETH_ADDRESS");
    }

    function wrapAvax(uint256 amount) internal {
        // wrap specified amount of WAVAX
        wavax.deposit{value: amount}();
    }

    function addressToBytes32(address address_) internal pure returns (bytes32) {
        // convert address to bytes32 (left-zero-padded if less than 20 bytes)
        return bytes32(uint256(uint160(address_)));
    }

    function normalizeAmount(
        uint256 amount,
        uint8 decimals
    ) internal pure returns(uint256) {
        // Truncate amount if decimals are greater than 8, this is to support
        // blockchains that can't handle uint256 type amounts.
        if (decimals > 8) {
            amount /= 10 ** (decimals - 8);
        }
        return amount;
    }

    function denormalizeAmount(
        uint256 amount,
        uint8 decimals
    ) internal pure returns(uint256) {
        // convert truncated amount back to original format
        if (decimals > 8) {
            amount *= 10 ** (decimals - 8);
        }
        return amount;
    }

    function getBalance(
        address token,
        address wallet
    ) internal view returns (uint256 balance) {
        (, bytes memory queriedBalance) =
            token.staticcall(
                abi.encodeWithSelector(IERC20.balanceOf.selector, wallet)
            );
        balance = abi.decode(queriedBalance, (uint256));
    }

    function getDecimals(
        address token
    ) internal view returns (uint8 decimals) {
        (,bytes memory queriedDecimals) = token.staticcall(
            abi.encodeWithSignature("decimals()")
        );
        decimals = abi.decode(queriedDecimals, (uint8));
    }

    function getTransferWithPayloadMessage(
        ITokenBridge.TransferWithPayload memory transfer,
        uint16 emitterChainId,
        bytes32 emitterAddress
    ) internal returns (bytes memory signedTransfer) {
        // construct `TransferWithPayload` Wormhole message
        IWormhole.VM memory vm;

        // set the vm values inline
        vm.version = uint8(1);
        vm.timestamp = uint32(block.timestamp);
        vm.emitterChainId = emitterChainId;
        vm.emitterAddress = emitterAddress;
        vm.sequence = wormhole.nextSequence(
            address(uint160(uint256(emitterAddress)))
        );
        vm.consistencyLevel = bridge.finality();
        vm.payload = bridge.encodeTransferWithPayload(transfer);

        // encode the bservation
        signedTransfer = wormholeSimulator.encodeAndSignMessage(vm);
    }
}
