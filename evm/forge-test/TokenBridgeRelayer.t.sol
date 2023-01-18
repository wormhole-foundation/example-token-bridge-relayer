// SPDX-License-Identifier: Apache 2
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "forge-std/console.sol";

import {IWETH} from "../src/interfaces/IWETH.sol";
import {IWormhole} from "../src/interfaces/IWormhole.sol";
import {ITokenBridge} from "../src/interfaces/ITokenBridge.sol";
import {ITokenBridgeRelayer} from "../src/interfaces/ITokenBridgeRelayer.sol";

import {WormholeSimulator} from "wormhole-solidity/WormholeSimulator.sol";
import {ForgeHelpers} from "wormhole-solidity/ForgeHelpers.sol";
import {Helpers} from "./Helpers.sol";

import {TokenBridgeRelayer} from "../src/token-bridge-relayer/TokenBridgeRelayer.sol";
import {WormUSD} from "../src/token/WormUSD.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title A Test Suite for the EVM Token Bridge Relayer Contracts
 * @dev Tests that use the wavax token do not need to register wavax
 * or set the swap rate for wavax. Both actions are completed in the
 * test setup.
 */
contract TokenBridgeRelayerTest is Helpers, ForgeHelpers, Test {
    // guardian private key for simulated signing of Wormhole messages
    uint256 guardianSigner;

    // relayer fee precision
    uint32 relayerFeePrecision;

    // ethereum test info
    uint16 ethereumChainId = uint16(vm.envUint("TESTING_ETH_WORMHOLE_CHAINID"));
    address ethereumTokenBridge = vm.envAddress("TESTING_ETH_BRIDGE_ADDRESS");
    address weth = vm.envAddress("TESTING_WRAPPED_ETH_ADDRESS");
    address ethereumRecipient = vm.envAddress("TESTING_ETH_RECIPIENT");
    address ethUsdc = vm.envAddress("TESTING_ETH_USDC_ADDRESS");

    // avax contract and test info
    IWETH wavax = IWETH(vm.envAddress("TESTING_WRAPPED_AVAX_ADDRESS"));
    address avaxRecipient = vm.envAddress("TESTING_AVAX_RECIPIENT");
    address avaxRelayerWallet = vm.envAddress("TESTING_AVAX_RELAYER");
    address avaxUsdc = vm.envAddress("TESTING_AVAX_USDC_ADDRESS");

    // contract instances
    ITokenBridge bridge = ITokenBridge(vm.envAddress("TESTING_AVAX_BRIDGE_ADDRESS"));
    IWormhole wormhole;
    WormholeSimulator wormholeSimulator;
    ITokenBridgeRelayer avaxRelayer;

    // used to compute balance changes before/after redeeming token transfers
    struct Balances {
        uint256 recipientBefore;
        uint256 recipientAfter;
        uint256 relayerBefore;
        uint256 relayerAfter;
    }

    struct NormalizedAmounts {
        uint8 tokenDecimals;
        uint256 transferAmount;
        uint256 relayerFee;
        uint256 toNative;
    }

    function setupWormhole() internal {
        // verify that we're using the correct fork (AVAX mainnet in this case)
        require(block.chainid == vm.envUint("TESTING_AVAX_FORK_CHAINID"), "wrong evm");

        // set up this chain's Wormhole
        wormholeSimulator = new WormholeSimulator(
            vm.envAddress("TESTING_AVAX_WORMHOLE_ADDRESS"),
            uint256(vm.envBytes32("GUARDIAN_KEY")));
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
    }

    function setupTokenBridgeRelayer() internal {
        // deploy the relayer contract
        TokenBridgeRelayer deployedRelayer = new TokenBridgeRelayer(
            uint16(wormhole.chainId()),
            address(wormhole),
            vm.envAddress("TESTING_AVAX_BRIDGE_ADDRESS"),
            address(wavax),
            true, // should unwrap flag
            1e8, // initial swap rate precision
            1e8 // initial relayer fee precision
        );
        avaxRelayer = ITokenBridgeRelayer(address(deployedRelayer));

        // register and set the native token swap rate (wavax)
        avaxRelayer.registerToken(avaxRelayer.chainId(), address(wavax));
        avaxRelayer.updateSwapRate(
            avaxRelayer.chainId(),
            address(wavax),
            69e4 * avaxRelayer.swapRatePrecision() // swap rate
        );

        // verify initial state
        assertEq(avaxRelayer.chainId(), wormhole.chainId());
        assertEq(address(avaxRelayer.wormhole()), address(wormhole));
        assertEq(
            address(avaxRelayer.tokenBridge()),
            vm.envAddress("TESTING_AVAX_BRIDGE_ADDRESS")
        );
        assertEq(avaxRelayer.swapRatePrecision(), 1e8);
        assertEq(avaxRelayer.relayerFeePrecision(), 1e8);
        assertEq(
            avaxRelayer.swapRate(address(wavax)),
            69e4 * avaxRelayer.swapRatePrecision()
        );
        assertEq(avaxRelayer.isAcceptedToken(address(wavax)), true);
    }

    /**
     * @notice Sets up the wormholeSimulator contracts and deploys TokenBridgeRelayer
     * contracts before each test is executed.
     */
    function setUp() public {
        setupWormhole();
        setupTokenBridgeRelayer();
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

    /**
     * @notice This tests confirms that the native swap amount calculation does not
     * revert when the toNativeTokenAmount is zero.
     */
    function testCalculateNativeSwapAmountZeroAmount(uint256 tokenSwapRate) public {
        vm.assume(tokenSwapRate > avaxRelayer.swapRatePrecision());
        vm.assume(
            tokenSwapRate <=
            avaxRelayer.swapRate(address(wavax)) * avaxRelayer.swapRatePrecision()
        );

        address token = avaxUsdc;
        uint256 toNativeAmount = 0;

        // register the token
        avaxRelayer.registerToken(avaxRelayer.chainId(), token);

        // set the swap rate for the token
        avaxRelayer.updateSwapRate(avaxRelayer.chainId(), token, tokenSwapRate);

        // compute the native amount
        uint256 nativeAmount = avaxRelayer.calculateNativeSwapAmountOut(
            token,
            toNativeAmount
        );

        assertEq(nativeAmount, 0);
    }

    /**
     * @notice This tests confirms that the native swap amount calculation does not
     * revert when tested for a large range of toNativeTokenAmount values.
     */
    function testCalculateNativeSwapAmountArithmeticError(
        uint256 tokenSwapRate,
        uint256 toNativeTokenAmount
    ) public {
        vm.assume(tokenSwapRate > avaxRelayer.swapRatePrecision());
        vm.assume(
            tokenSwapRate <=
            avaxRelayer.swapRate(address(wavax)) * avaxRelayer.swapRatePrecision()
        );
        vm.assume(toNativeTokenAmount < type(uint128).max);

        address token = avaxUsdc;

        // register the token
        avaxRelayer.registerToken(avaxRelayer.chainId(), token);

        // set the swap rate for the token
        avaxRelayer.updateSwapRate(avaxRelayer.chainId(), token, tokenSwapRate);

        // compute the native amount
        avaxRelayer.calculateNativeSwapAmountOut(
            token,
            toNativeTokenAmount
        );
    }

    /**
     * @notice This tests confirms that the native swap amount calculation does not
     * revert when tested for a large range of toNativeTokenAmount values.
     */
    function testCalculateNativeSwapAmountZeroAmountWrappedNative() public {
        address token = address(wavax);
        uint256 toNativeTokenAmount = 0;

        // compute the native amount
        uint256 nativeAmount = avaxRelayer.calculateNativeSwapAmountOut(
            token,
            toNativeTokenAmount
        );

        assertEq(nativeAmount, 0);
    }

    /**
     * @notice This tests confirms that the native swap amount calculation does not
     * revert when the toNativeTokenAmount is zero.
     */
    function testCalculateNativeSwapAmountArithmeticErrorCheckWrappedNative(
        uint256 toNativeTokenAmount
    ) public view {
        vm.assume(toNativeTokenAmount < type(uint128).max);
        address token = address(wavax);

        // compute the native amount
        avaxRelayer.calculateNativeSwapAmountOut(
            token,
            toNativeTokenAmount
        );
    }

    /**
     * @notice This tests confirms that the native swap amount calculation reverts
     * when one of the components of the native swap rate is not set.
     */
    function testCalculateNativeSwapAmountSwapRateNotSet(
        uint256 toNativeTokenAmount
    ) public {
        vm.assume(toNativeTokenAmount > 0 && toNativeTokenAmount < type(uint128).max);

        // register the token
        avaxRelayer.registerToken(avaxRelayer.chainId(), avaxUsdc);

        // call should revert
        vm.expectRevert("swap rate not set");
        avaxRelayer.calculateNativeSwapAmountOut(
            avaxUsdc,
            toNativeTokenAmount
        );
    }

    /**
     * @notice This tests confirms that the max swap amount calculation does not
     * revert when tested against a large range of input values.
     */
    function testCalculateMaxSwapAmountInArithmeticErrorCheck(
        uint256 tokenSwapRate,
        uint256 maxNativeSwapAmount
    ) public {
        vm.assume(tokenSwapRate > avaxRelayer.swapRatePrecision());
        vm.assume(
            tokenSwapRate <=
            avaxRelayer.swapRate(address(wavax)) * avaxRelayer.swapRatePrecision()
        );
        vm.assume(maxNativeSwapAmount < type(uint128).max);

        address token = avaxUsdc;

        // register the token
        avaxRelayer.registerToken(avaxRelayer.chainId(), token);

        // set the swap rate for the token
        avaxRelayer.updateSwapRate(avaxRelayer.chainId(), token, tokenSwapRate);

        // set the maxNativeSwapAmount
        avaxRelayer.updateMaxNativeSwapAmount(
            avaxRelayer.chainId(),
            token,
            maxNativeSwapAmount
        );

        // compute the native amount
        avaxRelayer.calculateMaxSwapAmountIn(
            token
        );
    }

    /**
     * @notice This tests confirms that the max swap amount calculation does not
     * revert when the maxNativeSwapAmount is zero.
     */
    function testCalculateMaxSwapAmountInZeroAmount(uint256 tokenSwapRate) public {
        vm.assume(tokenSwapRate > avaxRelayer.swapRatePrecision());
        vm.assume(
            tokenSwapRate <=
            avaxRelayer.swapRate(address(wavax)) * avaxRelayer.swapRatePrecision()
        );

        address token = avaxUsdc;
        uint256 maxNativeSwapAmount = 0;

        // register the token
        avaxRelayer.registerToken(avaxRelayer.chainId(), token);

        // set the swap rate for the token
        avaxRelayer.updateSwapRate(avaxRelayer.chainId(), token, tokenSwapRate);

        // set the maxNativeSwapAmount
        avaxRelayer.updateMaxNativeSwapAmount(
            avaxRelayer.chainId(),
            token,
            maxNativeSwapAmount
        );

        // compute the native amount
        uint256 maxAllowed = avaxRelayer.calculateMaxSwapAmountIn(
            token
        );

        assertEq(maxAllowed, 0);
    }

    /**
     * @notice This test confirms that the max swap amount calculation reverts
     * when one of the components of the native swap rate is not set.
     */
    function testCalculateMaxSwapAmountSwapRateNotSet(
        uint256 toNativeTokenAmount
    ) public {
        vm.assume(toNativeTokenAmount > 0);

        // register the token
        avaxRelayer.registerToken(avaxRelayer.chainId(), avaxUsdc);

        // call should revert
        vm.expectRevert("swap rate not set");
        avaxRelayer.calculateMaxSwapAmountIn(
            avaxUsdc
        );
    }

    /**
     * @notice This tests confirms that the relayer fee calculation does not
     * revert when tested against a large range of input values.
     */
    function testCalculateRelayerFeeArithmeticErrorCheck(
        uint256 tokenSwapRate,
        uint256 relayerFeeUsd
    ) public {
        vm.assume(
            relayerFeeUsd < type(uint128).max &&
            relayerFeeUsd > avaxRelayer.relayerFeePrecision()
        );
        vm.assume(tokenSwapRate > avaxRelayer.swapRatePrecision());
        vm.assume(
            tokenSwapRate <=
            avaxRelayer.swapRate(address(wavax)) * avaxRelayer.swapRatePrecision()
        );

        uint16 chainId_ = ethereumChainId;
        address token = avaxUsdc;
        uint8 decimals = getDecimals(token);

        // register the token
        avaxRelayer.registerToken(avaxRelayer.chainId(), token);

        // set the swap rate for the token
        avaxRelayer.updateSwapRate(avaxRelayer.chainId(), token, tokenSwapRate);

        // register the target contract
        avaxRelayer.registerContract(chainId_, addressToBytes32(address(this)));

        // set the relayer fee to zero
        avaxRelayer.updateRelayerFee(chainId_, relayerFeeUsd);

        // call should not revert
        avaxRelayer.calculateRelayerFee(
            chainId_,
            token,
            decimals
        );
    }

    /**
     * @notice This test confirms that the relayer fee calculation does not
     * revert when the USD relayer fee is 0.
     */
    function testCalculateRelayerFeeZeroAmount(
        uint256 tokenSwapRate
    ) public {
        vm.assume(tokenSwapRate > avaxRelayer.swapRatePrecision());
        vm.assume(
            tokenSwapRate <=
            avaxRelayer.swapRate(address(wavax)) * avaxRelayer.swapRatePrecision()
        );

        uint16 chainId_ = ethereumChainId;
        address token = avaxUsdc;
        uint8 decimals = getDecimals(token);

        // register the token
        avaxRelayer.registerToken(avaxRelayer.chainId(), token);

        // set the swap rate for the token
        avaxRelayer.updateSwapRate(avaxRelayer.chainId(), token, tokenSwapRate);

        // register the target contract
        avaxRelayer.registerContract(chainId_, addressToBytes32(address(this)));

        // set the relayer fee to zero
        avaxRelayer.updateRelayerFee(chainId_, 0);

        // call should not revert
        uint256 tokenFee = avaxRelayer.calculateRelayerFee(
            chainId_,
            token,
            decimals
        );

        assertEq(tokenFee, 0);
    }

    /**
     * @notice This test confirms that the relayer fee calculation reverts
     * when the token swap rate is not set.
     */
    function testCalculateRelayerFeeSwapRateNotSet() public {
        uint16 chainId_ = ethereumChainId;
        address token = avaxUsdc;
        uint8 decimals = getDecimals(token);

        // call should revert
        vm.expectRevert("swap rate not set");
        avaxRelayer.calculateRelayerFee(
            chainId_,
            token,
            decimals
        );
    }

    /**
     * @notice This test confirms that the `TransferTokensWithRelay` method
     * correctly sends an ERC20 token with the `TransferWithRelayer` payload.
     */
    function testTransferTokensWithRelay(
        uint256 amount,
        uint256 toNativeTokenAmount
    ) public {
        // target contract info
        bytes32 targetContract = addressToBytes32(address(this));

        // contract setup
        avaxRelayer.registerContract(
            ethereumChainId,
            targetContract
        );

        // set relayer fee to 5 USD
        avaxRelayer.updateRelayerFee(
            ethereumChainId,
            5 * avaxRelayer.relayerFeePrecision()
        );

        // compute the relayer fee in token terms (this is encoded in the payload)
        uint256 relayerFeeToken = avaxRelayer.calculateRelayerFee(
            ethereumChainId,
            address(wavax),
            18
        );

        // make some assumptions about the fuzz test values
        {
            uint256 normalizedAmount = normalizeAmount(amount, 18);
            uint256 normalizedToNative = normalizeAmount(toNativeTokenAmount, 18);
            uint256 normalizedFee = normalizeAmount(relayerFeeToken, 18);

            vm.assume(normalizedAmount > 0 && amount < type(uint96).max);
            vm.assume(
                normalizedToNative > 0 &&
                toNativeTokenAmount < type(uint96).max &&
                normalizedAmount > normalizedToNative + normalizedFee
            );
        }

        // wrap some avax
        wrap(address(wavax), amount);

        // grab balance before and after to confirm dust is not transferred
        Balances memory tokenBalance;
        tokenBalance.recipientBefore = getBalance(
            address(wavax),
            address(this)
        );

        // start listening to events
        vm.recordLogs();

        // approve the relayer contract to spend wavax
        SafeERC20.safeApprove(
            IERC20(address(wavax)),
            address(avaxRelayer),
            amount
        );

        // call the source relayer contract to transfer tokens to ethereum
        uint64 sequence = avaxRelayer.transferTokensWithRelay(
            address(wavax),
            amount,
            toNativeTokenAmount,
            ethereumChainId,
            addressToBytes32(ethereumRecipient),
            0 // opt out of batching
        );

        // Fetch token balance after the transfer and make sure
        // dust was not transferred to the contract.
        tokenBalance.recipientAfter = getBalance(
            address(wavax),
            address(this)
        );
        assertEq(
            tokenBalance.recipientBefore - tokenBalance.recipientAfter,
            denormalizeAmount(normalizeAmount(amount, 18), 18)
        );

        // record the emitted Wormhole message
        Vm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length > 0, "no events recorded");

        // find published wormhole messages from log
        Vm.Log[] memory publishedMessages =
            wormholeSimulator.fetchWormholeMessageFromLog(logs, 1);

        // simulate signing the Wormhole message
        // NOTE: in the wormhole-sdk, signed Wormhole messages are referred to as signed VAAs
        bytes memory encodedMessage = wormholeSimulator.fetchSignedMessageFromLogs(
            publishedMessages[0],
            avaxRelayer.chainId(),
            address(avaxRelayer)
        );

        // parse and verify the message
        (IWormhole.VM memory wormholeMessage, bool valid, ) =
            wormhole.parseAndVerifyVM(encodedMessage);
        require(valid, "failed to verify VAA");

        // call the token bridge to parse the TransferWithPayload message
        ITokenBridge.TransferWithPayload memory transfer =
            bridge.parseTransferWithPayload(wormholeMessage.payload);

        /**
         * The token bridge normalizes the transfer amount to support
         * blockchains that don't support type uint256. We need to normalize the
         * amount we passed to the contract to compare the value against what
         * is encoded in the payload.
         */
        assertEq(
            transfer.amount,
            normalizeAmount(amount, 18)
        );

        // verify the remaining TransferWithPayload values
        assertEq(transfer.tokenAddress, addressToBytes32(address(wavax)));
        assertEq(transfer.tokenChain, avaxRelayer.chainId());
        assertEq(transfer.to, targetContract);
        assertEq(transfer.toChain, ethereumChainId);
        assertEq(transfer.fromAddress, addressToBytes32(address(avaxRelayer)));
        assertEq(transfer.amount > 0, true);

        // verify VAA values
        assertEq(wormholeMessage.sequence, sequence);
        assertEq(wormholeMessage.nonce, 0); // batchID

        // parse additional payload and verify the values
        ITokenBridgeRelayer.TransferWithRelay memory message =
            avaxRelayer.decodeTransferWithRelay(transfer.payload);

        assertEq(message.payloadId, 1);
        assertEq(
            message.targetRelayerFee,
            normalizeAmount(relayerFeeToken, 18)
        );
        assertEq(
            message.toNativeTokenAmount,
            normalizeAmount(toNativeTokenAmount, 18)
        );
        assertEq(message.targetRecipient, addressToBytes32(ethereumRecipient));
    }

    /**
     * @notice This test confirms that the `transferTokensWithRelay` method reverts
     * when the token is not registered.
     * @dev this test does not register any tokens on purpose
     */
    function testTransferTokensWithRelayUnregisteredToken() public {
        uint256 amount = 1e18;
        uint256 toNativeTokenAmount = 0;
        bytes32 targetContract = addressToBytes32(address(this));

        // deploy erc ERC20 token
        WormUSD token = new WormUSD(
            address(this),
            6, // token decimals
            amount // token supply
        );

        // register the target contract
        avaxRelayer.registerContract(
            ethereumChainId,
            targetContract
        );

        // approve the relayer to spend tokens
        SafeERC20.safeApprove(
            IERC20(address(token)),
            address(avaxRelayer),
            amount
        );

        // the transferTokensWithRelay call should revert
        vm.expectRevert("token not accepted");
        avaxRelayer.transferTokensWithRelay(
            address(token),
            amount,
            toNativeTokenAmount,
            ethereumChainId,
            targetContract,
            0 // batchId
        );
    }

    /**
     * @notice This test confirms that the `transferTokensWithRelay` method reverts
     * when the token is the zero address.
     */
    function testFailTransferTokensWithRelayInvalidToken() public {
        address token = address(0);
        uint256 amount = 1e18;
        uint256 toNativeTokenAmount = 1e6;
        bytes32 targetContract = addressToBytes32(address(this));

        // register the target contract
        avaxRelayer.registerContract(
            ethereumChainId,
            targetContract
        );

        // the transferTokensWithRelay call should revert
        avaxRelayer.transferTokensWithRelay(
            token,
            amount,
            toNativeTokenAmount,
            ethereumChainId,
            targetContract,
            0 // batchId
        );
    }

    /**
     * @notice This test confirms that the `transferTokensWithRelay` method reverts
     * when the target recipient is the zero address.
     */
    function testTransferTokensWithRelayInvalidRecipient() public {
        address token = address(wavax);
        uint256 amount = 1e18;
        uint256 toNativeTokenAmount = 1e6;
        bytes32 targetContract = addressToBytes32(address(this));

        // wrap some wavax
        wrap(token, amount);

        // register the target contract
        avaxRelayer.registerContract(
            ethereumChainId,
            targetContract
        );

        // approve the relayer to spend tokens
        SafeERC20.safeApprove(
            IERC20(token),
            address(avaxRelayer),
            amount
        );

        // the transferTokensWithRelay call should revert
        vm.expectRevert("targetRecipient cannot be bytes32(0)");
        avaxRelayer.transferTokensWithRelay(
            token,
            amount,
            toNativeTokenAmount,
            ethereumChainId,
            bytes32(0),
            0 // batchId
        );
    }

    /**
     * @notice This test confirms that the `transferTokensWithRelay` method reverts
     * when the target contract is not registered.
     * @dev this test does not register a target contract on purpose
     */
    function testTransferTokensWithRelayInvalidTargetContract() public {
        address token = address(wavax);
        uint256 amount = 1e18;
        uint256 toNativeTokenAmount = 1e11;

        // wrap some wavax
        wrap(token, amount);

        // approve the relayer to spend tokens
        SafeERC20.safeApprove(
            IERC20(token),
            address(avaxRelayer),
            amount
        );

        // the transferTokensWithRelay call should revert
        vm.expectRevert("target not registered");
        avaxRelayer.transferTokensWithRelay(
            token,
            amount,
            toNativeTokenAmount,
            ethereumChainId,
            addressToBytes32(address(this)),
            0 // batchId
        );
    }

    /**
     * @notice This test confirms that the `transferTokensWithRelay` method reverts
     * when the normalized transfer amount is not greater than zero.
     */
    function testTransferTokensWithRelayInsufficientNormalizedAmount(
        uint256 amount
    ) public {
        vm.assume(
            amount > 0 &&
            normalizeAmount(amount, 18) == 0
        );

        address token = address(wavax);
        uint256 toNativeTokenAmount = 0;
        bytes32 targetContract = addressToBytes32(address(this));

        // wrap some wavax
        wrap(token, amount);

        // register the target contract
        avaxRelayer.registerContract(
            ethereumChainId,
            targetContract
        );

        // approve the relayer to spend tokens
        SafeERC20.safeApprove(
            IERC20(token),
            address(avaxRelayer),
            amount
        );

        // the transferTokensWithRelay call should revert
        vm.expectRevert("normalized amount must be > 0");
        avaxRelayer.transferTokensWithRelay(
            token,
            amount,
            toNativeTokenAmount,
            ethereumChainId,
            addressToBytes32(address(this)),
            0 // batchId
        );
    }

     /**
     * @notice This test confirms that the `transferTokensWithRelay` method reverts
     * when the normalized toNativeTokenAmount is not greater than zero.
     */
    function testTransferTokensWithRelayInsufficientToNativeNormalizedAmount() public {
        address token = address(wavax);
        uint256 amount = 6.9e18;
        uint256 toNativeTokenAmount = 1e6; // normalized amount should be zero
        bytes32 targetContract = addressToBytes32(address(this));

        require(normalizeAmount(toNativeTokenAmount, 18) == 0, "bad test setup");

        // wrap some wavax
        wrap(token, amount);

        // register the target contract
        avaxRelayer.registerContract(
            ethereumChainId,
            targetContract
        );

        // approve the relayer to spend tokens
        SafeERC20.safeApprove(
            IERC20(token),
            address(avaxRelayer),
            amount
        );

        // the transferTokensWithRelay call should revert
        vm.expectRevert("invalid toNativeTokenAmount");
        avaxRelayer.transferTokensWithRelay(
            token,
            amount,
            toNativeTokenAmount,
            ethereumChainId,
            addressToBytes32(address(this)),
            0 // batchId
        );
    }

    /**
     * @notice This test confirms that the `transferTokensWithRelay` method reverts
     * when the transfer amount isn't large enough to cover the relayer fee.
     */
    function testTransferTokensWithRelayInsufficientAmount(
        uint256 amount,
        uint256 relayerFeeUsd
    ) public {
        vm.assume(relayerFeeUsd < type(uint96).max);

        address token = address(wavax);
        bytes32 targetContract = addressToBytes32(address(this));
        uint256 toNativeTokenAmount = 0;

        // register the target contract
        avaxRelayer.registerContract(
            ethereumChainId,
            targetContract
        );

        // update the relayer fee
        avaxRelayer.updateRelayerFee(
            ethereumChainId,
            relayerFeeUsd
        );

        // calculate the relayer fee in token terms
        uint256 relayerFeeToken = avaxRelayer.calculateRelayerFee(
            ethereumChainId,
            token,
            18
        );

        // make some assumptions about the test
        vm.assume(
            normalizeAmount(amount, 18) > 0
            && amount < relayerFeeToken &&
            amount < type(uint96).max
        );

        // wrap some wavax
        wrap(token, amount);

        // approve the relayer to spend tokens
        SafeERC20.safeApprove(
            IERC20(token),
            address(avaxRelayer),
            amount
        );

        // the transferTokensWithRelay call should revert
        vm.expectRevert("insufficient amount");
        avaxRelayer.transferTokensWithRelay(
            token,
            amount,
            toNativeTokenAmount,
            ethereumChainId,
            addressToBytes32(address(this)),
            0 // batchId
        );
    }

    /**
     * @notice This test confirms that the `wrapAndTransferEthWithRelay` method
     * correctly sends native assets with the `TransferWithRelay` payload.
     */
    function testWrapAndTransferEthWithRelay(
        uint256 amount,
        uint256 toNativeTokenAmount
    ) public {
        // target contract info
        bytes32 targetContract = addressToBytes32(address(this));

        // contract setup
        avaxRelayer.registerContract(
            ethereumChainId,
            targetContract
        );

        // set relayer fee to 5 USD
        avaxRelayer.updateRelayerFee(
            ethereumChainId,
            5 * avaxRelayer.relayerFeePrecision()
        );

        // compute the relayer fee in token terms (this is encoded in the payload)
        uint256 relayerFeeToken = avaxRelayer.calculateRelayerFee(
            ethereumChainId,
            address(wavax),
            18
        );

        // make some assumptions about the fuzz test values
        {
            uint256 normalizedAmount = normalizeAmount(amount, 18);
            uint256 normalizedToNative = normalizeAmount(toNativeTokenAmount, 18);
            uint256 normalizedFee = normalizeAmount(relayerFeeToken, 18);

            vm.assume(normalizedAmount > 0 && amount < type(uint96).max);
            vm.assume(
                normalizedToNative > 0 &&
                toNativeTokenAmount < type(uint96).max &&
                normalizedAmount > normalizedToNative + normalizedFee
            );
        }

        // start listening to events
        vm.recordLogs();

        // hoax the recipient and balance check before
        hoax(avaxRecipient, amount);
        uint256 balanceBefore = avaxRecipient.balance;

        // call the source relayer contract to transfer ETH
        uint64 sequence = avaxRelayer.wrapAndTransferEthWithRelay{value: amount}(
            toNativeTokenAmount,
            ethereumChainId,
            addressToBytes32(ethereumRecipient),
            0 // opt out of batching
        );

        /**
         * Balance check the recipient's wallet. Denormalizing the amount
         * accounts for the "dust" refund the contract sends after normalizing
         * the transfer amount.
         */
        assertEq(
            balanceBefore - avaxRecipient.balance,
            denormalizeAmount(
                normalizeAmount(amount, 18),
                18
            )
        );

        // record the emitted Wormhole message
        Vm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length > 0, "no events recorded");

        // find published wormhole messages from log
        Vm.Log[] memory publishedMessages =
            wormholeSimulator.fetchWormholeMessageFromLog(logs, 1);

        // simulate signing the Wormhole message
        // NOTE: in the wormhole-sdk, signed Wormhole messages are referred to as signed VAAs
        bytes memory encodedMessage = wormholeSimulator.fetchSignedMessageFromLogs(
            publishedMessages[0],
            avaxRelayer.chainId(),
            address(avaxRelayer)
        );

        // parse and verify the message
        (IWormhole.VM memory wormholeMessage, bool valid, ) =
            wormhole.parseAndVerifyVM(encodedMessage);
        require(valid, "failed to verify VAA");

        // call the token bridge to parse the TransferWithPayload message
        ITokenBridge.TransferWithPayload memory transfer =
            bridge.parseTransferWithPayload(wormholeMessage.payload);

        /**
         * The token bridge normalizes the transfer amount to support
         * blockchains that don't support type uint256. We need to normalize the
         * amount we passed to the contract to compare the value against what
         * is encoded in the payload.
         */
        assertEq(
            transfer.amount,
            normalizeAmount(amount, 18)
        );

        // verify the remaining TransferWithPayload values
        assertEq(transfer.tokenAddress, addressToBytes32(address(wavax)));
        assertEq(transfer.tokenChain, avaxRelayer.chainId());
        assertEq(transfer.to, targetContract);
        assertEq(transfer.toChain, ethereumChainId);
        assertEq(transfer.fromAddress, addressToBytes32(address(avaxRelayer)));
        assertEq(transfer.amount > 0, true);

        // verify VAA values
        assertEq(wormholeMessage.sequence, sequence);
        assertEq(wormholeMessage.nonce, 0); // batchID

        // parse additional payload and verify the values
        ITokenBridgeRelayer.TransferWithRelay memory message =
            avaxRelayer.decodeTransferWithRelay(transfer.payload);

        assertEq(message.payloadId, 1);
        assertEq(
            message.targetRelayerFee,
            normalizeAmount(relayerFeeToken, 18)
        );
        assertEq(
            message.toNativeTokenAmount,
            normalizeAmount(toNativeTokenAmount, 18)
        );
        assertEq(message.targetRecipient, addressToBytes32(ethereumRecipient));
    }

    /**
     * @notice This test confirms that relayer contract correctly redeems wrapped
     * native tokens to the encoded recipient and handles relayer payments correctly.
     * @dev The minimum amount value has to be greater than 1e10. The token bridge
     * will truncate the value to zero if it's less than 1e10.
     */
    function testCompleteTransferWithRelayWrappedNative(
        uint256 amount,
        uint256 toNativeTokenAmount
    ) public {
        // Fetch the wrapped weth contract on avalanche, since the token
        // address encoded in the signedMessage is weth from Ethereum.
        address wrappedAsset = bridge.wrappedAsset(
            ethereumChainId,
            addressToBytes32(weth)
        );

        // store normalized transfer amounts to reduce local variable count
        NormalizedAmounts memory normAmounts;
        normAmounts.tokenDecimals = getDecimals(wrappedAsset);
        normAmounts.transferAmount = normalizeAmount(
            amount,
            normAmounts.tokenDecimals
        );
        normAmounts.toNative = normalizeAmount(
            toNativeTokenAmount,
            normAmounts.tokenDecimals
        );

        // test setup
        {
            // target contract setup
            avaxRelayer.registerToken(avaxRelayer.chainId(), wrappedAsset);

            // register this contract as the foreign emitter
            avaxRelayer.registerContract(
                ethereumChainId,
                addressToBytes32(address(this))
            );

            // set the native swap rate
            avaxRelayer.updateSwapRate(
                avaxRelayer.chainId(),
                wrappedAsset,
                6.9e2 * avaxRelayer.swapRatePrecision() // swap rate
            );

            // set the max to native amount
            avaxRelayer.updateMaxNativeSwapAmount(
                avaxRelayer.chainId(),
                wrappedAsset,
                6.9e18 // max native swap amount
            );

            /**
             * NOTE: The relayer fee is calculated on the source chain, and the
             * target relayer contract will pay the relayer the encoded value. We
             * need to simulate calculating the value based on information stored
             * in the target chain.
             */

            // set relayer fee to 20 USD
            avaxRelayer.updateRelayerFee(
                ethereumChainId,
                20 * avaxRelayer.relayerFeePrecision()
            );

            normAmounts.relayerFee = normalizeAmount(
                avaxRelayer.calculateRelayerFee(
                    ethereumChainId,
                    wrappedAsset,
                    normAmounts.tokenDecimals
                ),
                normAmounts.tokenDecimals
            );

            // make some assumptions about the fuzz test values
            vm.assume(
                normAmounts.transferAmount > 0 &&
                amount < type(uint96).max
            );
            vm.assume(
                normAmounts.toNative > 0 &&
                toNativeTokenAmount < type(uint96).max &&
                normAmounts.transferAmount > normAmounts.toNative + normAmounts.relayerFee
            );
        }

        // encode the message by calling the encodeTransferWithRelay method
        bytes memory encodedTransferWithRelay = avaxRelayer.encodeTransferWithRelay(
            ITokenBridgeRelayer.TransferWithRelay({
                payloadId: 1,
                targetRelayerFee: normAmounts.relayerFee,
                toNativeTokenAmount: normAmounts.toNative,
                targetRecipient: addressToBytes32(avaxRecipient)
            })
        );

        // Create a simulated version of the wormhole message that the
        // relayer contract will emit.
        ITokenBridge.TransferWithPayload memory transfer =
            ITokenBridge.TransferWithPayload({
                payloadID: uint8(3), // payload3 transfer
                amount: normAmounts.transferAmount,
                tokenAddress: addressToBytes32(weth),
                tokenChain: ethereumChainId,
                to: addressToBytes32(address(avaxRelayer)),
                toChain: avaxRelayer.chainId(),
                fromAddress: addressToBytes32(address(this)),
                payload: encodedTransferWithRelay
            });

        // Encode the TransferWithPayload struct and simulate signing
        // the message with the devnet guardian key.
        bytes memory signedMessage = getTransferWithPayloadMessage(
            transfer,
            ethereumChainId,
            addressToBytes32(ethereumTokenBridge)
        );

        // fetch token balances
        Balances memory tokenBalances;
        tokenBalances.recipientBefore = getBalance(
            wrappedAsset,
            avaxRecipient
        );
        tokenBalances.relayerBefore = getBalance(
            wrappedAsset,
            avaxRelayerWallet
        );

        // check the native balance of the recipient
        Balances memory ethBalances;
        ethBalances.recipientBefore = avaxRecipient.balance;

        // Get a quote from the contract for the native gas swap. Denormalize
        // the amount to get a more accurate quote, and reduce gas costs.
        uint256 nativeGasQuote = avaxRelayer.calculateNativeSwapAmountOut(
            wrappedAsset,
            denormalizeAmount(normAmounts.toNative, normAmounts.tokenDecimals)
        );

        // hoax relayer and balance check
        hoax(avaxRelayerWallet, nativeGasQuote);
        ethBalances.relayerBefore = avaxRelayerWallet.balance;

        // call redeemTokens from relayer wallet
        avaxRelayer.completeTransferWithRelay{value: nativeGasQuote}(signedMessage);

        // check token balance of the recipient and relayer
        tokenBalances.recipientAfter = getBalance(
            wrappedAsset,
            avaxRecipient
        );
        tokenBalances.relayerAfter = getBalance(
            wrappedAsset,
            avaxRelayerWallet
        );

        // check the native balance of the recipient and relayer
        ethBalances.recipientAfter = avaxRecipient.balance;
        ethBalances.relayerAfter = avaxRelayerWallet.balance;

        // validate results
        {
            /**
             * Overwrite the toNativeTokenAmount if the value is larger than
             * the max swap amount. The contract executes the same instruction.
             */
            uint256 maxToNative = avaxRelayer.calculateMaxSwapAmountIn(wrappedAsset);
            uint256 denormToNativeAmount = denormalizeAmount(
                normAmounts.toNative,
                normAmounts.tokenDecimals
            );
            if (denormToNativeAmount > maxToNative) {
                denormToNativeAmount = maxToNative;
            }

            /**
             * Set the toNativeTokenAmount to zero if the nativeGasQuote is zero.
             * The nativeGasQuote can be zero if the toNativeTokenAmount is too little
             * to convert to native assets (solidity rounds towards zero).
             */
            if (nativeGasQuote == 0) {
                denormToNativeAmount = 0;
            }

            // calculate the denormalized amount and relayer fee
            uint256 denormAmount = denormalizeAmount(
                normAmounts.transferAmount,
                normAmounts.tokenDecimals
            );
            uint256 denormRelayerFee = denormalizeAmount(
                normAmounts.relayerFee,
                normAmounts.tokenDecimals
            );

            // validate token balances
            assertEq(
                tokenBalances.recipientAfter - tokenBalances.recipientBefore,
                denormAmount - denormRelayerFee - denormToNativeAmount
            );
            assertEq(
                tokenBalances.relayerAfter - tokenBalances.relayerBefore,
                denormRelayerFee + denormToNativeAmount
            );

            // validate eth balances
            uint256 maxNativeSwapAmount = avaxRelayer.maxNativeSwapAmount(wrappedAsset);
            assertEq(
                ethBalances.recipientAfter - ethBalances.recipientBefore,
                nativeGasQuote > maxNativeSwapAmount ? maxNativeSwapAmount : nativeGasQuote
            );
            assertEq(
                ethBalances.relayerBefore - ethBalances.relayerAfter,
                nativeGasQuote > maxNativeSwapAmount ? maxNativeSwapAmount : nativeGasQuote
            );
        }
    }

    /**
     * @notice This test confirms that the relayer contract correctly redeems wrapped
     * native tokens to the encoded recipient. This test explicitly sets the
     * relayerFee and toNativeTokenAmount to zero.
     * @dev The minimum amount value has to be greater than 1e10. The token bridge
     * will truncate the value to zero if it's less than 1e10.
     */
    function testCompleteTransferWithRelayWrappedNativeNoFeesOrSwap(
        uint256 amount
    ) public {
        // set the relayerFee and toNativeTokenAmount to zero
        uint256 encodedRelayerFee = 0;
        uint256 toNativeTokenAmount = 0;

        // Fetch the wrapped weth contract on avalanche, since the token
        // address encoded in the signedMessage is weth from Ethereum.
        address wrappedAsset = bridge.wrappedAsset(
            ethereumChainId,
            addressToBytes32(weth)
        );

        // store normalized transfer amounts to reduce local variable count
        NormalizedAmounts memory normAmounts;
        normAmounts.tokenDecimals = getDecimals(wrappedAsset);
        normAmounts.transferAmount = normalizeAmount(
            amount,
            normAmounts.tokenDecimals
        );

        // test setup
        {
            // make some assumptions about the fuzz test values
            vm.assume(
                normAmounts.transferAmount > 0 &&
                amount < type(uint96).max
            );

            // target contract setup
            avaxRelayer.registerToken(avaxRelayer.chainId(), wrappedAsset);

            // register this contract as the foreign emitter
            avaxRelayer.registerContract(
                ethereumChainId,
                addressToBytes32(address(this))
            );

            // set the native swap rate
            avaxRelayer.updateSwapRate(
                avaxRelayer.chainId(),
                wrappedAsset,
                6.9e3 * avaxRelayer.swapRatePrecision() // swap rate
            );
        }

        // encode the message by calling the encodeTransferWithRelay method
        bytes memory encodedTransferWithRelay = avaxRelayer.encodeTransferWithRelay(
            ITokenBridgeRelayer.TransferWithRelay({
                payloadId: 1,
                targetRelayerFee: encodedRelayerFee,
                toNativeTokenAmount: toNativeTokenAmount,
                targetRecipient: addressToBytes32(avaxRecipient)
            })
        );

        // Create a simulated version of the wormhole message that the
        // relayer contract will emit.
        ITokenBridge.TransferWithPayload memory transfer =
            ITokenBridge.TransferWithPayload({
                payloadID: uint8(3), // payload3 transfer
                amount: normAmounts.transferAmount,
                tokenAddress: addressToBytes32(weth),
                tokenChain: ethereumChainId,
                to: addressToBytes32(address(avaxRelayer)),
                toChain: avaxRelayer.chainId(),
                fromAddress: addressToBytes32(address(this)),
                payload: encodedTransferWithRelay
            });

        // Encode the TransferWithPayload struct and simulate signing
        // the message with the devnet guardian key.
        bytes memory signedMessage = getTransferWithPayloadMessage(
            transfer,
            ethereumChainId,
            addressToBytes32(ethereumTokenBridge)
        );

        // fetch token balances
        Balances memory tokenBalances;
        tokenBalances.recipientBefore = getBalance(
            wrappedAsset,
            avaxRecipient
        );
        tokenBalances.relayerBefore = getBalance(
            wrappedAsset,
            avaxRelayerWallet
        );

        // check the native balance of the recipient
        Balances memory ethBalances;
        ethBalances.recipientBefore = avaxRecipient.balance;

        // get a quote from the contract for the native gas swap
        uint256 nativeGasQuote = avaxRelayer.calculateNativeSwapAmountOut(
            wrappedAsset,
            toNativeTokenAmount // zero, so don't need to denormalize
        );
        require(nativeGasQuote == 0, "oops");

        // hoax relayer and balance check
        vm.prank(avaxRelayerWallet);
        ethBalances.relayerBefore = avaxRelayerWallet.balance;

        // call redeemTokens from relayer wallet
        avaxRelayer.completeTransferWithRelay(signedMessage);

        // check token balance of the recipient and relayer
        tokenBalances.recipientAfter = getBalance(
            wrappedAsset,
            avaxRecipient
        );
        tokenBalances.relayerAfter = getBalance(
            wrappedAsset,
            avaxRelayerWallet
        );

        // check the native balance of the recipient and relayer
        ethBalances.recipientAfter = avaxRecipient.balance;
        ethBalances.relayerAfter = avaxRelayerWallet.balance;

        // validate results
        {
            // calculate the denormalized amount and relayer fee
            uint256 denormAmount = denormalizeAmount(
                normAmounts.transferAmount,
                normAmounts.tokenDecimals
            );

            // validate token balances
            assertEq(
                tokenBalances.recipientAfter - tokenBalances.recipientBefore,
                denormAmount
            );
            assertEq(tokenBalances.relayerAfter, tokenBalances.relayerBefore);

            // validate eth balances
            assertEq(ethBalances.recipientAfter, ethBalances.recipientBefore);
            assertEq(ethBalances.relayerBefore, ethBalances.relayerAfter);
        }
    }

    /**
     * @notice This test confirms that the relayer contract correctly redeems wrapped
     * native tokens to the encoded recipient and handles relayer payments correctly.
     * It also confirms that the contract refunds the relayer any excess native gas
     * that it passed to the contract.
     * @dev The minimum amount value has to be greater than 1e10. The token bridge
     * will truncate the value to zero if it's less than 1e10.
     */
    function testCompleteTransferWithRelayWrappedNativeRelayerRefund(
        uint256 additionalGas
    ) public {
        // Fetch the wrapped weth contract on avalanche, since the token
        // address encoded in the signedMessage is weth from Ethereum.
        address wrappedAsset = bridge.wrappedAsset(
            ethereumChainId,
            addressToBytes32(weth)
        );

        // set the toNativetTokenAmount
        uint256 toNativeTokenAmount = 6.9e16;

        // store normalized transfer amounts to reduce local variable count
        NormalizedAmounts memory normAmounts;
        normAmounts.tokenDecimals = getDecimals(wrappedAsset);
        normAmounts.transferAmount = normalizeAmount(
            4.2e18, // transfer amount
            normAmounts.tokenDecimals
        );
        normAmounts.toNative = normalizeAmount(
            toNativeTokenAmount,
            normAmounts.tokenDecimals
        );

        // test setup
        {
            // target contract setup
            avaxRelayer.registerToken(avaxRelayer.chainId(), wrappedAsset);

            // register this contract as the foreign emitter
            avaxRelayer.registerContract(
                ethereumChainId,
                addressToBytes32(address(this))
            );

            // set the native swap rate
            avaxRelayer.updateSwapRate(
                avaxRelayer.chainId(),
                wrappedAsset,
                6.9e3 * avaxRelayer.swapRatePrecision() // swap rate
            );

            // set the max native swap amount to the toNativeTokenAmount
            avaxRelayer.updateMaxNativeSwapAmount(
                avaxRelayer.chainId(),
                wrappedAsset,
                toNativeTokenAmount
            );

            /**
             * Another NOTE: The relayer fee is calculated on the source chain, and the
             * target relayer contract will pay the relayer the encoded value. We
             * need to simulate calculating the value based on information stored
             * in the target chain.
             *
             * set relayer fee to 20 USD
             */
            avaxRelayer.updateRelayerFee(
                ethereumChainId,
                20 * avaxRelayer.relayerFeePrecision()
            );

            normAmounts.relayerFee = normalizeAmount(
                avaxRelayer.calculateRelayerFee(
                    ethereumChainId,
                    wrappedAsset,
                    normAmounts.tokenDecimals
                ),
                normAmounts.tokenDecimals
            );


            vm.assume(additionalGas > 0 && additionalGas < type(uint64).max);
        }

        // encode the message by calling the encodeTransferWithRelay method
        bytes memory encodedTransferWithRelay = avaxRelayer.encodeTransferWithRelay(
            ITokenBridgeRelayer.TransferWithRelay({
                payloadId: 1,
                targetRelayerFee: normAmounts.relayerFee,
                toNativeTokenAmount: normAmounts.toNative,
                targetRecipient: addressToBytes32(avaxRecipient)
            })
        );

        // Create a simulated version of the wormhole message that the
        // relayer contract will emit.
        ITokenBridge.TransferWithPayload memory transfer =
            ITokenBridge.TransferWithPayload({
                payloadID: uint8(3), // payload3 transfer
                amount: normAmounts.transferAmount,
                tokenAddress: addressToBytes32(weth),
                tokenChain: ethereumChainId,
                to: addressToBytes32(address(avaxRelayer)),
                toChain: avaxRelayer.chainId(),
                fromAddress: addressToBytes32(address(this)),
                payload: encodedTransferWithRelay
            });

        // Encode the TransferWithPayload struct and simulate signing
        // the message with the devnet guardian key.
        bytes memory signedMessage = getTransferWithPayloadMessage(
            transfer,
            ethereumChainId,
            addressToBytes32(ethereumTokenBridge)
        );

        // fetch token balances
        Balances memory tokenBalances;
        tokenBalances.recipientBefore = getBalance(
            wrappedAsset,
            avaxRecipient
        );
        tokenBalances.relayerBefore = getBalance(
            wrappedAsset,
            avaxRelayerWallet
        );

        // check the native balance of the recipient
        Balances memory ethBalances;
        ethBalances.recipientBefore = avaxRecipient.balance;

        // Get a quote from the contract for the native gas swap. Denormalize
        // the amount to get a more accurate quote, and reduce gas costs.
        uint256 nativeGasQuote = avaxRelayer.calculateNativeSwapAmountOut(
            wrappedAsset,
            denormalizeAmount(normAmounts.toNative, normAmounts.tokenDecimals)
        );

        // hoax relayer and balance check
        hoax(avaxRelayerWallet, nativeGasQuote + additionalGas);
        ethBalances.relayerBefore = avaxRelayerWallet.balance;

        // NOTE: Pass additional gas to the relayer contract to confirm that
        // it correctly refunds the relayer.
        avaxRelayer.completeTransferWithRelay{
            value: nativeGasQuote + additionalGas
        }(signedMessage);

        // check token balance of the recipient and relayer
        tokenBalances.recipientAfter = getBalance(
            wrappedAsset,
            avaxRecipient
        );
        tokenBalances.relayerAfter = getBalance(
            wrappedAsset,
            avaxRelayerWallet
        );

        // check the native balance of the recipient and relayer
        ethBalances.recipientAfter = avaxRecipient.balance;
        ethBalances.relayerAfter = avaxRelayerWallet.balance;

        // validate results
        {
            /**
            * Overwrite the toNativeTokenAmount if the value is larger than
            * the max swap amount. The contract executes the same instruction.
            */
            uint256 maxToNative = avaxRelayer.calculateMaxSwapAmountIn(wrappedAsset);
            uint256 denormToNativeAmount = denormalizeAmount(
                normAmounts.toNative,
                normAmounts.tokenDecimals
            );
            if (denormToNativeAmount > maxToNative) {
                denormToNativeAmount = maxToNative;
            }

            // calculate the denormalized amount and relayer fee
            uint256 denormAmount = denormalizeAmount(
                normAmounts.transferAmount,
                normAmounts.tokenDecimals
            );
            uint256 denormRelayerFee = denormalizeAmount(
                normAmounts.relayerFee,
                normAmounts.tokenDecimals
            );

            // validate token balances
            assertEq(
                tokenBalances.recipientAfter - tokenBalances.recipientBefore,
                denormAmount - denormRelayerFee - denormToNativeAmount
            );
            assertEq(
                tokenBalances.relayerAfter - tokenBalances.relayerBefore,
                denormRelayerFee + denormToNativeAmount
            );

            // validate eth balances
            uint256 maxNativeSwapAmount = avaxRelayer.maxNativeSwapAmount(wrappedAsset);
            assertEq(
                ethBalances.recipientAfter - ethBalances.recipientBefore,
                nativeGasQuote > maxNativeSwapAmount ? maxNativeSwapAmount : nativeGasQuote
            );

            // NOTE: Verify that the relayer was refunded. If it wasn't than the
            // require statement would trigger.
            require(nativeGasQuote + additionalGas > nativeGasQuote, "oops");
            assertEq(
                ethBalances.relayerBefore - ethBalances.relayerAfter,
                nativeGasQuote > maxNativeSwapAmount ? maxNativeSwapAmount : nativeGasQuote
            );
        }
    }

    /**
     * @notice This test confirms that relayer contract correctly redeems wrapped
     * native tokens to the self redeeming recipient. The contract should not pay a
     * relayer fee or allow any token swaps.
     */
    function testCompleteTransferWithRelaySelfRedeemWrappedToken(
        uint256 amount,
        uint256 toNativeTokenAmount
    ) public {
        // Fetch the wrapped weth contract on avalanche, since the token
        // address encoded in the signedMessage is weth from Ethereum.
        address wrappedAsset = bridge.wrappedAsset(
            ethereumChainId,
            addressToBytes32(weth)
        );

        // store normalized transfer amounts to reduce local variable count
        NormalizedAmounts memory normAmounts;
        normAmounts.tokenDecimals = getDecimals(wrappedAsset);
        normAmounts.transferAmount = normalizeAmount(
            4.2e18, // transfer amount
            normAmounts.tokenDecimals
        );
        normAmounts.toNative = normalizeAmount(
            6.9e16, // toNativeTokenAmount
            normAmounts.tokenDecimals
        );

        // test setup
        {
            // target contract setup
            avaxRelayer.registerToken(avaxRelayer.chainId(), wrappedAsset);

            // register this contract as the foreign emitter
            avaxRelayer.registerContract(
                ethereumChainId,
                addressToBytes32(address(this))
            );

            // set the native swap rate
            avaxRelayer.updateSwapRate(
                avaxRelayer.chainId(),
                wrappedAsset,
                6.9e3 * avaxRelayer.swapRatePrecision() // swap rate
            );

            /**
             * NOTE: The relayer fee is calculated on the source chain, and the
             * target relayer contract will pay the relayer the encoded value. We
             * need to simulate calculating the value based on information stored
             * in the target chain.
             *
             * set relayer fee to 69 USD
             */
            avaxRelayer.updateRelayerFee(
                ethereumChainId,
                69 * avaxRelayer.relayerFeePrecision()
            );

            normAmounts.relayerFee = normalizeAmount(
                avaxRelayer.calculateRelayerFee(
                    ethereumChainId,
                    wrappedAsset,
                    normAmounts.tokenDecimals
                ),
                normAmounts.tokenDecimals
            );

            // make some assumptions about the fuzz test values
            vm.assume(
                normAmounts.transferAmount > 0 &&
                amount < type(uint96).max
            );
            vm.assume(
                normAmounts.toNative > 0 &&
                toNativeTokenAmount < type(uint96).max &&
                normAmounts.transferAmount > normAmounts.toNative + normAmounts.relayerFee
            );
        }

        // encode the message by calling the encodeTransferWithRelay method
        bytes memory encodedTransferWithRelay = avaxRelayer.encodeTransferWithRelay(
            ITokenBridgeRelayer.TransferWithRelay({
                payloadId: 1,
                targetRelayerFee: normAmounts.relayerFee,
                toNativeTokenAmount: normAmounts.toNative,
                targetRecipient: addressToBytes32(avaxRecipient)
            })
        );

        // Create a simulated version of the wormhole message that the
        // relayer contract will emit.
        ITokenBridge.TransferWithPayload memory transfer =
            ITokenBridge.TransferWithPayload({
                payloadID: uint8(3), // payload3 transfer
                amount: normAmounts.transferAmount,
                tokenAddress: addressToBytes32(weth),
                tokenChain: ethereumChainId,
                to: addressToBytes32(address(avaxRelayer)),
                toChain: avaxRelayer.chainId(),
                fromAddress: addressToBytes32(address(this)),
                payload: encodedTransferWithRelay
            });

        // Encode the TransferWithPayload struct and simulate signing
        // the message with the devnet guardian key.
        bytes memory signedMessage = getTransferWithPayloadMessage(
            transfer,
            ethereumChainId,
            addressToBytes32(ethereumTokenBridge)
        );

        // fetch token balances
        Balances memory tokenBalances;
        tokenBalances.recipientBefore = getBalance(
            wrappedAsset,
            avaxRecipient
        );

        // check the native balance of the recipient
        Balances memory ethBalances;
        ethBalances.recipientBefore = avaxRecipient.balance;

        // call complete transfer from the recipients wallet
        vm.prank(avaxRecipient);
        avaxRelayer.completeTransferWithRelay(signedMessage);

        // check token balance of the recipient
        tokenBalances.recipientAfter = getBalance(
            wrappedAsset,
            avaxRecipient
        );

        // check the native balance of the recipient
        ethBalances.recipientAfter = avaxRecipient.balance;

        // validate results
        {
            // calculate the denormalized amount and relayer fee
            uint256 denormAmount = denormalizeAmount(
                normAmounts.transferAmount,
                normAmounts.tokenDecimals
            );

            // validate token balances
            assertEq(
                tokenBalances.recipientAfter - tokenBalances.recipientBefore,
                denormAmount
            );

            // validate eth balances
            assertEq(ethBalances.recipientAfter, ethBalances.recipientBefore);
        }
    }

    /**
     * @notice This test confirms that the relayer contract correctly redeems wrapped
     * native tokens, unwraps them, and sends them to the encoded recipient.
     */
    function testCompleteTransferWithRelayAndUnwrapNative(
        uint256 amount
    ) public {
        // test variables
        uint256 toNativeTokenAmount = 0;

        // store normalized transfer amounts to reduce local variable count
        NormalizedAmounts memory normAmounts;
        normAmounts.tokenDecimals = getDecimals(address(wavax));
        normAmounts.transferAmount = normalizeAmount(
            amount,
            normAmounts.tokenDecimals
        );

        // test setup
        {
            // register this contract as the foreign emitter
            avaxRelayer.registerContract(
                ethereumChainId,
                addressToBytes32(address(this))
            );

            // set the max to native amount
            avaxRelayer.updateMaxNativeSwapAmount(
                avaxRelayer.chainId(),
                address(wavax),
                6.9e18 // max native swap amount
            );

            /**
             * Another NOTE: The relayer fee is calculated on the source chain, and the
             * target relayer contract will pay the relayer the encoded value. We
             * need to simulate calculating the value based on information stored
             * in the target chain.
             *
             * set relayer fee to 1 USD
             */
            avaxRelayer.updateRelayerFee(
                ethereumChainId,
                1 * avaxRelayer.relayerFeePrecision()
            );

            normAmounts.relayerFee = normalizeAmount(
                avaxRelayer.calculateRelayerFee(
                    ethereumChainId,
                    address(wavax),
                    normAmounts.tokenDecimals
                ),
                normAmounts.tokenDecimals
            );

            // make some assumptions about the fuzz test values
            vm.assume(
                normAmounts.transferAmount > 0 &&
                amount < bridge.outstandingBridged(address(wavax))
            );
            vm.assume(
                normAmounts.transferAmount > normAmounts.relayerFee
            );
        }

        // encode the message by calling the encodeTransferWithRelay method
        bytes memory encodedTransferWithRelay = avaxRelayer.encodeTransferWithRelay(
            ITokenBridgeRelayer.TransferWithRelay({
                payloadId: 1,
                targetRelayerFee: normAmounts.relayerFee,
                toNativeTokenAmount: toNativeTokenAmount,
                targetRecipient: addressToBytes32(avaxRecipient)
            })
        );

        // Create a simulated version of the wormhole message that the
        // relayer contract will emit.
        ITokenBridge.TransferWithPayload memory transfer =
            ITokenBridge.TransferWithPayload({
                payloadID: uint8(3), // payload3 transfer
                amount: normAmounts.transferAmount,
                tokenAddress: addressToBytes32(address(wavax)),
                tokenChain: avaxRelayer.chainId(),
                to: addressToBytes32(address(avaxRelayer)),
                toChain: avaxRelayer.chainId(),
                fromAddress: addressToBytes32(address(this)),
                payload: encodedTransferWithRelay
            });

        // Encode the TransferWithPayload struct and simulate signing
        // the message with the devnet guardian key.
        bytes memory signedMessage = getTransferWithPayloadMessage(
            transfer,
            ethereumChainId,
            addressToBytes32(ethereumTokenBridge)
        );

        // check the native balance of the recipient
        Balances memory ethBalances;
        ethBalances.recipientBefore = avaxRecipient.balance;
        ethBalances.relayerBefore = avaxRelayerWallet.balance;

        hoax(address(avaxRelayer), amount);
        wavax.deposit{value: amount}();

        // call redeemTokens from relayer wallet
        vm.prank(avaxRelayerWallet);
        avaxRelayer.completeTransferWithRelay(signedMessage);

        // check the native balance of the recipient and relayer
        ethBalances.recipientAfter = avaxRecipient.balance;
        ethBalances.relayerAfter = avaxRelayerWallet.balance;

        // validate results
        {
            // calculate the denormalized amount and relayer fee
            uint256 denormAmount = denormalizeAmount(
                normAmounts.transferAmount,
                normAmounts.tokenDecimals
            );
            uint256 denormRelayerFee = denormalizeAmount(
                normAmounts.relayerFee,
                normAmounts.tokenDecimals
            );

            // validate eth balances (token balances shouldn't change)
            assertEq(
                ethBalances.recipientAfter - ethBalances.recipientBefore,
                denormAmount - denormRelayerFee
            );
            assertEq(
                ethBalances.relayerAfter - ethBalances.relayerBefore,
                denormRelayerFee
            );
        }
    }

    /**
     * @notice This test confirms that the relayer contract correctly redeems wrapped
     * native tokens, unwraps them, and sends them to the encoded recipient. This test
     * explicitly does not pay the relayer a fee.
     */
    function testCompleteTransferWithRelayAndUnwrapNoFees(
        uint256 amount
    ) public {
        // test variables
        uint256 encodedRelayerFee = 0;
        uint256 toNativeTokenAmount = 0;

        // store normalized transfer amounts to reduce local variable count
        NormalizedAmounts memory normAmounts;
        normAmounts.tokenDecimals = getDecimals(address(wavax));
        normAmounts.transferAmount = normalizeAmount(
            amount,
            normAmounts.tokenDecimals
        );
        normAmounts.relayerFee = encodedRelayerFee;
        normAmounts.toNative = toNativeTokenAmount;

        // test setup
        {
            // make some assumptions about the fuzz test values
            vm.assume(
                normAmounts.transferAmount > 0 &&
                amount < bridge.outstandingBridged(address(wavax))
            );
            vm.assume(
                normAmounts.transferAmount > normAmounts.relayerFee
            );

            // register this contract as the foreign emitter
            avaxRelayer.registerContract(
                ethereumChainId,
                addressToBytes32(address(this))
            );

            // set the max to native amount
            avaxRelayer.updateMaxNativeSwapAmount(
                avaxRelayer.chainId(),
                address(wavax),
                6.9e18 // max native swap amount
            );
        }

        // encode the message by calling the encodeTransferWithRelay method
        bytes memory encodedTransferWithRelay = avaxRelayer.encodeTransferWithRelay(
            ITokenBridgeRelayer.TransferWithRelay({
                payloadId: 1,
                targetRelayerFee: normAmounts.relayerFee,
                toNativeTokenAmount: normAmounts.toNative,
                targetRecipient: addressToBytes32(avaxRecipient)
            })
        );

        // Create a simulated version of the wormhole message that the
        // relayer contract will emit.
        ITokenBridge.TransferWithPayload memory transfer =
            ITokenBridge.TransferWithPayload({
                payloadID: uint8(3), // payload3 transfer
                amount: normAmounts.transferAmount,
                tokenAddress: addressToBytes32(address(wavax)),
                tokenChain: avaxRelayer.chainId(),
                to: addressToBytes32(address(avaxRelayer)),
                toChain: avaxRelayer.chainId(),
                fromAddress: addressToBytes32(address(this)),
                payload: encodedTransferWithRelay
            });

        // Encode the TransferWithPayload struct and simulate signing
        // the message with the devnet guardian key.
        bytes memory signedMessage = getTransferWithPayloadMessage(
            transfer,
            ethereumChainId,
            addressToBytes32(ethereumTokenBridge)
        );

        // check the native balance of the recipient
        Balances memory ethBalances;
        ethBalances.recipientBefore = avaxRecipient.balance;
        ethBalances.relayerBefore = avaxRelayerWallet.balance;

        // deposit avax into the wavax contract on behalf of the relayer
        hoax(address(avaxRelayer), amount);
        wavax.deposit{value: amount}();

        // call redeemTokens from relayer wallet
        vm.prank(avaxRelayerWallet);
        avaxRelayer.completeTransferWithRelay(signedMessage);

        // check the native balance of the recipient and relayer
        ethBalances.recipientAfter = avaxRecipient.balance;
        ethBalances.relayerAfter = avaxRelayerWallet.balance;

        // validate results
        {
            // validate eth balances (token balances shouldn't change)
            assertEq(
                ethBalances.recipientAfter - ethBalances.recipientBefore,
                denormalizeAmount(
                    normAmounts.transferAmount,
                    normAmounts.tokenDecimals
                )
            );
            assertEq(ethBalances.relayerAfter, ethBalances.relayerBefore);
        }
    }

    /**
     * @notice This test confirms that the relayer contract correctly redeems and
     * unwraps WETH on the target contract. The contract will not pay a relayer
     * fee or allow any token swaps.
     */
    function testCompleteTransferWithRelaySelfRedeemAndUnwrap(
        uint256 amount
    ) public {
        // Set the realyer fee to a nonzero number to confirm that the
        // contract does not pay out relayer fees for a self redemption.
        uint256 encodedRelayerFee = 1.1e11;

        // store normalized transfer amounts to reduce local variable count
        NormalizedAmounts memory normAmounts;
        normAmounts.tokenDecimals = getDecimals(address(wavax));
        normAmounts.transferAmount = normalizeAmount(
            amount,
            normAmounts.tokenDecimals
        );
        normAmounts.relayerFee = normalizeAmount(
            encodedRelayerFee,
            normAmounts.tokenDecimals
        );
        normAmounts.toNative = 0;

        // test setup
        {
            // make some assumptions about the fuzz test values
            vm.assume(
                amount > encodedRelayerFee &&
                amount < bridge.outstandingBridged(address(wavax))
            );

            // register this contract as the foreign emitter
            avaxRelayer.registerContract(
                ethereumChainId,
                addressToBytes32(address(this))
            );
        }

        // encode the message by calling the encodeTransferWithRelay method
        bytes memory encodedTransferWithRelay = avaxRelayer.encodeTransferWithRelay(
            ITokenBridgeRelayer.TransferWithRelay({
                payloadId: 1,
                targetRelayerFee: normAmounts.relayerFee,
                toNativeTokenAmount: normAmounts.toNative,
                targetRecipient: addressToBytes32(avaxRecipient)
            })
        );

        // Create a simulated version of the wormhole message that the
        // relayer contract will emit.
        ITokenBridge.TransferWithPayload memory transfer =
            ITokenBridge.TransferWithPayload({
                payloadID: uint8(3), // payload3 transfer
                amount: normAmounts.transferAmount,
                tokenAddress: addressToBytes32(address(wavax)),
                tokenChain: avaxRelayer.chainId(),
                to: addressToBytes32(address(avaxRelayer)),
                toChain: avaxRelayer.chainId(),
                fromAddress: addressToBytes32(address(this)),
                payload: encodedTransferWithRelay
            });

        // Encode the TransferWithPayload struct and simulate signing
        // the message with the devnet guardian key.
        bytes memory signedMessage = getTransferWithPayloadMessage(
            transfer,
            ethereumChainId,
            addressToBytes32(ethereumTokenBridge)
        );

        // fetch token balances
        Balances memory tokenBalances;
        tokenBalances.recipientBefore = getBalance(
            address(wavax),
            avaxRecipient
        );

        // check the native balance of the recipient
        Balances memory ethBalances;
        ethBalances.recipientBefore = avaxRecipient.balance;

        // NOTE: For this test to work, we need to deposit ETH
        // into the WETH contract on behalf of the relayer contract.
        hoax(address(avaxRelayer), amount);
        wavax.deposit{value: amount}();

        // call complete transfer from the recipients wallet
        vm.prank(avaxRecipient);
        avaxRelayer.completeTransferWithRelay(signedMessage);

        // check token balance of the recipient
        tokenBalances.recipientAfter = getBalance(
            address(wavax),
            avaxRecipient
        );

        // check the native balance of the recipient
        ethBalances.recipientAfter = avaxRecipient.balance;

        // validate results
        {
            // calculate the denormalized amount and relayer fee
            uint256 denormAmount = denormalizeAmount(
                normAmounts.transferAmount,
                normAmounts.tokenDecimals
            );

            // validate token balances (token balance shouldn't change)
            assertEq(tokenBalances.recipientAfter, tokenBalances.recipientBefore);

            // validate eth balances
            assertEq(
                ethBalances.recipientAfter - ethBalances.recipientBefore,
                denormAmount
            );
        }
    }

    /**
     * @notice This test confirms that the relayer contract correctly redeems wrapped
     * stablecoins to the encoded recipient and handles relayer payments correctly.
     * @dev The contract behavior changes slightly when transferring stablecoins
     * since the contracts will not normalize the quantities (decimals < 8).
     */
    function testCompleteTransferWithRelayWrappedStable(
        uint256 amount,
        uint256 toNativeTokenAmount
    ) public {
        // Fetch the wrapped usdc contract on avalanche, since the token
        // address encoded in the signedMessage is usdc from Ethereum.
        address wrappedAsset = bridge.wrappedAsset(
            ethereumChainId,
            addressToBytes32(ethUsdc)
        );

        // test setup
        uint256 encodedRelayerFee;
        {
            // target contract setup
            avaxRelayer.registerToken(avaxRelayer.chainId(), wrappedAsset);

            // register this contract as the foreign emitter
            avaxRelayer.registerContract(
                ethereumChainId,
                addressToBytes32(address(this))
            );

            // set the max to native amount
            avaxRelayer.updateMaxNativeSwapAmount(
                avaxRelayer.chainId(),
                wrappedAsset,
                1e18 // max native swap amount
            );

            // set the native swap rate
            avaxRelayer.updateSwapRate(
                avaxRelayer.chainId(),
                wrappedAsset,
                1 * avaxRelayer.swapRatePrecision() // swap rate
            );

            /**
             * NOTE: The relayer fee is calculated on the source chain, and the
             * target relayer contract will pay the relayer the encoded value. We
             * need to simulate calculating the value based on information stored
             * in the target chain.
             *
             * set relayer fee to 20 USD
             */
            avaxRelayer.updateRelayerFee(
                ethereumChainId,
                20 * avaxRelayer.relayerFeePrecision()
            );

            encodedRelayerFee = avaxRelayer.calculateRelayerFee(
                ethereumChainId,
                wrappedAsset,
                getDecimals(wrappedAsset)
            );

            // make some assumptions about the fuzz test values
            vm.assume(
                amount > 0 &&
                amount < type(uint96).max
            );
            vm.assume(
                toNativeTokenAmount > 0 &&
                toNativeTokenAmount < type(uint96).max &&
                amount > toNativeTokenAmount + encodedRelayerFee
            );
        }

        // encode the message by calling the encodeTransferWithRelay method
        bytes memory encodedTransferWithRelay = avaxRelayer.encodeTransferWithRelay(
            ITokenBridgeRelayer.TransferWithRelay({
                payloadId: 1,
                targetRelayerFee: encodedRelayerFee,
                toNativeTokenAmount: toNativeTokenAmount,
                targetRecipient: addressToBytes32(avaxRecipient)
            })
        );

        // Create a simulated version of the wormhole message that the
        // relayer contract will emit.
        ITokenBridge.TransferWithPayload memory transfer =
            ITokenBridge.TransferWithPayload({
                payloadID: uint8(3), // payload3 transfer
                amount: amount,
                tokenAddress: addressToBytes32(ethUsdc),
                tokenChain: ethereumChainId,
                to: addressToBytes32(address(avaxRelayer)),
                toChain: avaxRelayer.chainId(),
                fromAddress: addressToBytes32(address(this)),
                payload: encodedTransferWithRelay
            });

        // Encode the TransferWithPayload struct and simulate signing
        // the message with the devnet guardian key.
        bytes memory signedMessage = getTransferWithPayloadMessage(
            transfer,
            ethereumChainId,
            addressToBytes32(ethereumTokenBridge)
        );

        // fetch token balances
        Balances memory tokenBalances;
        tokenBalances.recipientBefore = getBalance(
            wrappedAsset,
            avaxRecipient
        );
        tokenBalances.relayerBefore = getBalance(
            wrappedAsset,
            avaxRelayerWallet
        );

        // check the native balance of the recipient
        Balances memory ethBalances;
        ethBalances.recipientBefore = avaxRecipient.balance;

        // get a quote from the contract for the native gas swap
        uint256 nativeGasQuote = avaxRelayer.calculateNativeSwapAmountOut(
            wrappedAsset,
            toNativeTokenAmount
        );

        // hoax relayer and balance check
        hoax(avaxRelayerWallet, nativeGasQuote);
        ethBalances.relayerBefore = avaxRelayerWallet.balance;

        // call redeemTokens from relayer wallet
        avaxRelayer.completeTransferWithRelay{value: nativeGasQuote}(signedMessage);

        // check token balance of the recipient and relayer
        tokenBalances.recipientAfter = getBalance(
            wrappedAsset,
            avaxRecipient
        );
        tokenBalances.relayerAfter = getBalance(
            wrappedAsset,
            avaxRelayerWallet
        );

        // check the native balance of the recipient and relayer
        ethBalances.recipientAfter = avaxRecipient.balance;
        ethBalances.relayerAfter = avaxRelayerWallet.balance;

        // validate results
        {
            /**
            * Overwrite the toNativeTokenAmount if the value is larger than
            * the max swap amount. The contract executes the same instruction.
            */
            uint256 maxToNative = avaxRelayer.calculateMaxSwapAmountIn(wrappedAsset);
            if (toNativeTokenAmount > maxToNative) {
                toNativeTokenAmount = maxToNative;
            }

            /**
            * Set the toNativeTokenAmount to zero if the nativeGasQuote is zero.
            * The nativeGasQuote can be zero if the toNativeTokenAmount is too little
            * to convert to native assets (solidity rounds towards zero).
            */
            if (nativeGasQuote == 0) {
                toNativeTokenAmount = 0;
            }

            // validate token balances
            assertEq(
                tokenBalances.recipientAfter - tokenBalances.recipientBefore,
                amount - toNativeTokenAmount - encodedRelayerFee
            );
            assertEq(
                tokenBalances.relayerAfter - tokenBalances.relayerBefore,
                encodedRelayerFee + toNativeTokenAmount
            );

            // validate eth balances
            uint256 maxNativeSwapAmount = avaxRelayer.maxNativeSwapAmount(wrappedAsset);
            assertEq(
                ethBalances.recipientAfter - ethBalances.recipientBefore,
                nativeGasQuote > maxNativeSwapAmount ? maxNativeSwapAmount : nativeGasQuote
            );
            assertEq(
                ethBalances.relayerBefore - ethBalances.relayerAfter,
                nativeGasQuote > maxNativeSwapAmount ? maxNativeSwapAmount : nativeGasQuote
            );
        }
    }

    /**
     * @notice This test confirms that the relayer contract reverts when receiving
     * a transfer for an unregistered token.
     */
    function testCompleteTransferWithRelayUnregisteredToken() public {
        uint256 relayerFee = 1.1e11;
        uint256 amount = 1e19;
        uint256 toNativeTokenAmount = 1e10;

        // Fetch the wrapped weth contract on avalanche, since the token
        // address encoded in the signedMessage is weth from Ethereum.
        address wrappedAsset = bridge.wrappedAsset(
            ethereumChainId,
            addressToBytes32(weth)
        );
        uint8 tokenDecimals = getDecimals(wrappedAsset);

        // encode the message by calling the encodeTransferWithRelay method
        bytes memory encodedTransferWithRelay = avaxRelayer.encodeTransferWithRelay(
            ITokenBridgeRelayer.TransferWithRelay({
                payloadId: 1,
                targetRelayerFee: normalizeAmount(relayerFee, tokenDecimals),
                toNativeTokenAmount: normalizeAmount(
                    toNativeTokenAmount,
                    tokenDecimals
                ),
                targetRecipient: addressToBytes32(avaxRecipient)
            })
        );

        // Create a simulated version of the wormhole message that the
        // relayer contract will emit.
        ITokenBridge.TransferWithPayload memory transfer =
            ITokenBridge.TransferWithPayload({
                payloadID: uint8(3), // payload3 transfer
                amount: normalizeAmount(amount, tokenDecimals),
                tokenAddress: addressToBytes32(weth),
                tokenChain: ethereumChainId,
                to: addressToBytes32(address(avaxRelayer)),
                toChain: avaxRelayer.chainId(),
                fromAddress: addressToBytes32(address(this)),
                payload: encodedTransferWithRelay
            });

        // Encode the TransferWithPayload struct and simulate signing
        // the message with the devnet guardian key.
        bytes memory signedMessage = getTransferWithPayloadMessage(
            transfer,
            ethereumChainId,
            addressToBytes32(ethereumTokenBridge)
        );

        // the completeTransferWithRelay call should revert
        vm.expectRevert("token not registered");
        avaxRelayer.completeTransferWithRelay(signedMessage);
    }

    /**
     * @notice This test confirms that the relayer contract reverts when receiving
     * a transfer from an unregistered contract.
     */
    function testCompleteTransferWithRelayUnregisteredContract() public {
        uint256 relayerFee = 1.1e11;
        uint256 amount = 1e19;
        uint256 toNativeTokenAmount = 1e10;

        // Fetch the wrapped weth contract on avalanche, since the token
        // address encoded in the signedMessage is weth from Ethereum.
        address wrappedAsset = bridge.wrappedAsset(
            ethereumChainId,
            addressToBytes32(weth)
        );
        uint8 tokenDecimals = getDecimals(wrappedAsset);

        // encode the message by calling the encodeTransferWithRelay method
        bytes memory encodedTransferWithRelay = avaxRelayer.encodeTransferWithRelay(
            ITokenBridgeRelayer.TransferWithRelay({
                payloadId: 1,
                targetRelayerFee: normalizeAmount(relayerFee, tokenDecimals),
                toNativeTokenAmount: normalizeAmount(
                    toNativeTokenAmount,
                    tokenDecimals
                ),
                targetRecipient: addressToBytes32(avaxRecipient)
            })
        );

        // Create a simulated version of the wormhole message that the
        // relayer contract will emit.
        ITokenBridge.TransferWithPayload memory transfer =
            ITokenBridge.TransferWithPayload({
                payloadID: uint8(3), // payload3 transfer
                amount: normalizeAmount(amount, tokenDecimals),
                tokenAddress: addressToBytes32(weth),
                tokenChain: ethereumChainId,
                to: addressToBytes32(address(avaxRelayer)),
                toChain: avaxRelayer.chainId(),
                fromAddress: addressToBytes32(address(this)),
                payload: encodedTransferWithRelay
            });

        // Encode the TransferWithPayload struct and simulate signing
        // the message with the devnet guardian key.
        bytes memory signedMessage = getTransferWithPayloadMessage(
            transfer,
            ethereumChainId,
            addressToBytes32(ethereumTokenBridge)
        );

        // register weth from Ethereum
        avaxRelayer.registerToken(avaxRelayer.chainId(), wrappedAsset);

        // the completeTransferWithRelay call should revert
        vm.expectRevert("contract not registered");
        avaxRelayer.completeTransferWithRelay(signedMessage);
    }

    /**
     * @notice This test confirms that the relayer contract reverts when the recipient
     * tries to redeem their transfer and swap native assets.
     */
    function testCompleteTransferWithRelayInvalidSelfRedeem() public {
        uint256 relayerFee = 1.1e11;
        uint256 amount = 1e19;
        uint256 toNativeTokenAmount = 1e10;

        // Fetch the wrapped weth contract on avalanche, since the token
        // address encoded in the signedMessage is weth from Ethereum.
        address wrappedAsset = bridge.wrappedAsset(
            ethereumChainId,
            addressToBytes32(weth)
        );
        uint8 tokenDecimals = getDecimals(wrappedAsset);

        // encode the message by calling the encodeTransferWithRelay method
        bytes memory encodedTransferWithRelay = avaxRelayer.encodeTransferWithRelay(
            ITokenBridgeRelayer.TransferWithRelay({
                payloadId: 1,
                targetRelayerFee: normalizeAmount(relayerFee, tokenDecimals),
                toNativeTokenAmount: normalizeAmount(
                    toNativeTokenAmount,
                    tokenDecimals
                ),
                targetRecipient: addressToBytes32(avaxRecipient)
            })
        );

        // Create a simulated version of the wormhole message that the
        // relayer contract will emit.
        ITokenBridge.TransferWithPayload memory transfer =
            ITokenBridge.TransferWithPayload({
                payloadID: uint8(3), // payload3 transfer
                amount: normalizeAmount(amount, tokenDecimals),
                tokenAddress: addressToBytes32(weth),
                tokenChain: ethereumChainId,
                to: addressToBytes32(address(avaxRelayer)),
                toChain: avaxRelayer.chainId(),
                fromAddress: addressToBytes32(address(this)),
                payload: encodedTransferWithRelay
            });

        // Encode the TransferWithPayload struct and simulate signing
        // the message with the devnet guardian key.
        bytes memory signedMessage = getTransferWithPayloadMessage(
            transfer,
            ethereumChainId,
            addressToBytes32(ethereumTokenBridge)
        );

        // register the token
        avaxRelayer.registerToken(avaxRelayer.chainId(), wrappedAsset);

        // register this contract as the foreign emitter
        avaxRelayer.registerContract(
            ethereumChainId,
            addressToBytes32(address(this))
        );

        // set the native swap rate (so the native gas query works)
        avaxRelayer.updateSwapRate(
            avaxRelayer.chainId(),
            wrappedAsset,
            1 * avaxRelayer.swapRatePrecision() // swap rate
        );

        // get a quote from the contract for the native gas swap
        uint256 nativeGasQuote = avaxRelayer.calculateNativeSwapAmountOut(
            wrappedAsset,
            denormalizeAmount(
                normalizeAmount(toNativeTokenAmount, tokenDecimals),
                tokenDecimals
            )
        );

        // NOTE: hoax the recipient wallet to test self redemption
        hoax(avaxRecipient, nativeGasQuote);

        // expect the completeTransferWithRelay call to fail
        vm.expectRevert("recipient cannot swap native assets");
        avaxRelayer.completeTransferWithRelay{value: nativeGasQuote}(signedMessage);
    }

    /**
     * @notice This test confirms that the relayer contract reverts when the
     * off-chain relayer fails to provide enough native assets to facilitate
     * the swap requested by the recipient.
     * @dev this test explicitly sets value to 0 when completing the transfer
     */
    function testCompleteTransferWithRelayInsufficientSwapAmount() public {
        uint256 relayerFee = 1.1e11;
        uint256 amount = 1e19;
        uint256 toNativeTokenAmount = 1e17;

        // Fetch the wrapped weth contract on avalanche, since the token
        // address encoded in the signedMessage is weth from Ethereum.
        address wrappedAsset = bridge.wrappedAsset(
            ethereumChainId,
            addressToBytes32(weth)
        );
        uint8 tokenDecimals = getDecimals(wrappedAsset);

        // encode the message by calling the encodeTransferWithRelay method
        bytes memory encodedTransferWithRelay = avaxRelayer.encodeTransferWithRelay(
            ITokenBridgeRelayer.TransferWithRelay({
                payloadId: 1,
                targetRelayerFee: normalizeAmount(relayerFee, tokenDecimals),
                toNativeTokenAmount: normalizeAmount(
                    toNativeTokenAmount,
                    tokenDecimals
                ),
                targetRecipient: addressToBytes32(avaxRecipient)
            })
        );

        // Create a simulated version of the wormhole message that the
        // relayer contract will emit.
        ITokenBridge.TransferWithPayload memory transfer =
            ITokenBridge.TransferWithPayload({
                payloadID: uint8(3), // payload3 transfer
                amount: normalizeAmount(amount, tokenDecimals),
                tokenAddress: addressToBytes32(weth),
                tokenChain: ethereumChainId,
                to: addressToBytes32(address(avaxRelayer)),
                toChain: avaxRelayer.chainId(),
                fromAddress: addressToBytes32(address(this)),
                payload: encodedTransferWithRelay
            });

        // Encode the TransferWithPayload struct and simulate signing
        // the message with the devnet guardian key.
        bytes memory signedMessage = getTransferWithPayloadMessage(
            transfer,
            ethereumChainId,
            addressToBytes32(ethereumTokenBridge)
        );

        // register the token
        avaxRelayer.registerToken(avaxRelayer.chainId(), wrappedAsset);

        // register this contract as the foreign emitter
        avaxRelayer.registerContract(
            ethereumChainId,
            addressToBytes32(address(this))
        );

        // set the native swap rate (so the native gas query works)
        avaxRelayer.updateSwapRate(
            avaxRelayer.chainId(),
            wrappedAsset,
            1 * avaxRelayer.swapRatePrecision() // swap rate
        );

        // set the max to native amount
        avaxRelayer.updateMaxNativeSwapAmount(
            avaxRelayer.chainId(),
            wrappedAsset,
            6.9e18 // max native swap amount
        );

        // expect the completeTransferWithRelay call to fail
        vm.expectRevert("insufficient native asset amount");
        avaxRelayer.completeTransferWithRelay{value: 0}(signedMessage);
    }

    /**
     * @notice This test confirms that the relayer contract correctly reverts
     * when completing (and unwrapping) a native transfer when the relayer
     * sends a nonzero amount of value to the contract.
     */
    function testCompleteTransferWithRelayAndUnwrapNativePositiveValue() public {
        // set the toNativeTokenAmount to positive value
        uint256 amount = 2e18;
        uint256 toNativeTokenAmount = 1e18;

        // store normalized transfer amounts to reduce local variable count
        NormalizedAmounts memory normAmounts;
        normAmounts.tokenDecimals = getDecimals(address(wavax));
        normAmounts.transferAmount = normalizeAmount(
            amount,
            normAmounts.tokenDecimals
        );
        normAmounts.toNative = normalizeAmount(
            toNativeTokenAmount,
            normAmounts.tokenDecimals
        );

        // test setup
        {
            // register this contract as the foreign emitter
            avaxRelayer.registerContract(
                ethereumChainId,
                addressToBytes32(address(this))
            );

            // set the max to native amount
            avaxRelayer.updateMaxNativeSwapAmount(
                avaxRelayer.chainId(),
                address(wavax),
                6.9e18 // max native swap amount
            );

            /**
             * NOTE: The relayer fee is calculated on the source chain, and the
             * target relayer contract will pay the relayer the encoded value. We
             * need to simulate calculating the value based on information stored
             * in the target chain.
             *
             * set relayer fee to 1 USD
             */
            avaxRelayer.updateRelayerFee(
                ethereumChainId,
                1 * avaxRelayer.relayerFeePrecision()
            );

            normAmounts.relayerFee = normalizeAmount(
                avaxRelayer.calculateRelayerFee(
                    ethereumChainId,
                    address(wavax),
                    normAmounts.tokenDecimals
                ),
                normAmounts.tokenDecimals
            );
        }

        // encode the message by calling the encodeTransferWithRelay method
        bytes memory encodedTransferWithRelay = avaxRelayer.encodeTransferWithRelay(
            ITokenBridgeRelayer.TransferWithRelay({
                payloadId: 1,
                targetRelayerFee: normAmounts.relayerFee,
                toNativeTokenAmount: toNativeTokenAmount,
                targetRecipient: addressToBytes32(avaxRecipient)
            })
        );

        // Create a simulated version of the wormhole message that the
        // relayer contract will emit.
        ITokenBridge.TransferWithPayload memory transfer =
            ITokenBridge.TransferWithPayload({
                payloadID: uint8(3), // payload3 transfer
                amount: normAmounts.transferAmount,
                tokenAddress: addressToBytes32(address(wavax)),
                tokenChain: avaxRelayer.chainId(),
                to: addressToBytes32(address(avaxRelayer)),
                toChain: avaxRelayer.chainId(),
                fromAddress: addressToBytes32(address(this)),
                payload: encodedTransferWithRelay
            });

        // Encode the TransferWithPayload struct and simulate signing
        // the message with the devnet guardian key.
        bytes memory signedMessage = getTransferWithPayloadMessage(
            transfer,
            ethereumChainId,
            addressToBytes32(ethereumTokenBridge)
        );

        // check the native balance of the recipient
        Balances memory ethBalances;
        ethBalances.recipientBefore = avaxRecipient.balance;
        ethBalances.relayerBefore = avaxRelayerWallet.balance;

        hoax(address(avaxRelayer), amount);
        wavax.deposit{value: amount}();

        // Get a quote from the contract for the native gas swap. Denormalize
        // the amount to get a more accurate quote, and reduce gas costs.
        uint256 nativeGasQuote = avaxRelayer.calculateNativeSwapAmountOut(
            address(wavax),
            denormalizeAmount(normAmounts.toNative, normAmounts.tokenDecimals)
        );
        require(nativeGasQuote > 0, "swap quote must be > 0 for this test");

        // call redeemTokens from relayer wallet
        hoax(avaxRelayerWallet, nativeGasQuote);
        vm.expectRevert("value must be zero");
        avaxRelayer.completeTransferWithRelay{value: nativeGasQuote}(signedMessage);
    }
}
