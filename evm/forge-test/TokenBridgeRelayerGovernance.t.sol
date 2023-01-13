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

import {TokenBridgeRelayer} from "../src/token-bridge-relayer/TokenBridgeRelayer.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../src/libraries/BytesLib.sol";

/**
 * @title A Test Suite for the EVM Token Bridge Relayer Messages module
 */
contract TokenBridgeRelayerGovernanceTest is Helpers, ForgeHelpers, Test {
    using BytesLib for bytes;

    // contract instances
    ITokenBridgeRelayer avaxRelayer;

    // random wallet for pranks
    address wallet = vm.envAddress("TESTING_AVAX_RELAYER");

    // tokens
    address wavax = vm.envAddress("TESTING_WRAPPED_AVAX_ADDRESS");
    address ethUsdc = vm.envAddress("TESTING_ETH_USDC_ADDRESS");

    function setupTokenBridgeRelayer() internal {
        // cache avax chain ID and wormhole address
        uint16 avaxChainId = 6;
        address wormholeAddress = vm.envAddress("TESTING_AVAX_WORMHOLE_ADDRESS");

        // deploy the relayer contract
        TokenBridgeRelayer deployedRelayer = new TokenBridgeRelayer(
            avaxChainId,
            wormholeAddress,
            vm.envAddress("TESTING_AVAX_BRIDGE_ADDRESS"),
            1e8, // initial swap rate precision
            1e8 // initial relayer fee precision
        );
        avaxRelayer = ITokenBridgeRelayer(address(deployedRelayer));

        // verify initial state
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
     * @notice Sets up the Token Bridge avaxRelayer contract before each test
     */
    function setUp() public {
        setupTokenBridgeRelayer();
    }

    /**
     * @notice This test confirms that the owner can submit a request to
     * transfer ownership of the contract.
     */
    function testSubmitOwnershipTransferRequest(address newOwner) public {
        vm.assume(newOwner != address(0));

        // call submitOwnershipTransferRequest
        avaxRelayer.submitOwnershipTransferRequest(
            avaxRelayer.chainId(),
            newOwner
        );

        // confirm state changes
        assertEq(avaxRelayer.pendingOwner(), newOwner);
    }

    /**
     * @notice This test confirms that the owner cannot submit a request to
     * transfer ownership of the contract on the wrong chain.
     */
    function testSubmitOwnershipTransferRequestWrongChain(uint16 chainId_) public {
        vm.assume(chainId_ != avaxRelayer.chainId());

        // expect the submitOwnershipTransferRequest call to revert
        vm.expectRevert("wrong chain");
        avaxRelayer.submitOwnershipTransferRequest(chainId_, address(this));
    }

    /**
     * @notice This test confirms that the owner cannot submit a request to
     * transfer ownership of the contract to address(0).
     */
    function testSubmitOwnershipTransferRequestZeroAddress() public {
        address zeroAddress = address(0);

        // expect the submitOwnershipTransferRequest call to revert
        bytes memory encodedSignature = abi.encodeWithSignature(
            "submitOwnershipTransferRequest(uint16,address)",
            avaxRelayer.chainId(),
            zeroAddress
        );
        expectRevert(
            address(avaxRelayer),
            encodedSignature,
            "newOwner cannot equal address(0)"
        );
    }

    /**
     * @notice This test confirms that ONLY the owner can submit a request
     * to transfer ownership of the contract.
     */
    function testSubmitOwnershipTransferRequestOwnerOnly() public {
        address newOwner = address(this);

        // prank the caller address to something different than the owner's
        vm.startPrank(wallet);

        // expect the submitOwnershipTransferRequest call to revert
        bytes memory encodedSignature = abi.encodeWithSignature(
            "submitOwnershipTransferRequest(uint16,address)",
            avaxRelayer.chainId(),
            newOwner
        );
        expectRevert(
            address(avaxRelayer),
            encodedSignature,
            "caller not the owner"
        );

        vm.stopPrank();
    }

    /**
     * This test confirms that the pending owner can confirm an ownership
     * transfer request from their wallet.
     */
    function testConfirmOwnershipTransferRequest(address newOwner) public {
        vm.assume(newOwner != address(0));

        // verify pendingOwner and owner state variables
        assertEq(avaxRelayer.pendingOwner(), address(0));
        assertEq(avaxRelayer.owner(), address(this));

        // submit ownership transfer request
        avaxRelayer.submitOwnershipTransferRequest(
            avaxRelayer.chainId(),
            newOwner
        );

        // verify the pendingOwner state variable
        assertEq(avaxRelayer.pendingOwner(), newOwner);

        // Invoke the confirmOwnershipTransferRequest method from the
        // new owner's wallet.
        vm.prank(newOwner);
        avaxRelayer.confirmOwnershipTransferRequest();

        // Verify the ownership change, and that the pendingOwner
        // state variable has been set to address(0).
        assertEq(avaxRelayer.owner(), newOwner);
        assertEq(avaxRelayer.pendingOwner(), address(0));
    }

    /**
     * @notice This test confirms that only the pending owner can confirm an
     * ownership transfer request.
     */
     function testConfirmOwnershipTransferRequestNotPendingOwner(
        address pendingOwner
    ) public {
        vm.assume(
            pendingOwner != address(0) &&
            pendingOwner != address(this)
        );

        // set the pending owner and confirm the pending owner state variable
        avaxRelayer.submitOwnershipTransferRequest(
            avaxRelayer.chainId(),
            pendingOwner
        );
        assertEq(avaxRelayer.pendingOwner(), pendingOwner);

        // Attempt to confirm the ownership transfer request from a wallet that is
        // not the pending owner's.
        vm.startPrank(address(this));
        vm.expectRevert("caller must be pendingOwner");
        avaxRelayer.confirmOwnershipTransferRequest();

        vm.stopPrank();
    }

    /**
     * @notice This test confirms that the owner can correctly register a foreign
     * TokenBridgeRelayer contract.
     */
    function testRegisterContract(
        uint16 chainId_,
        bytes32 tokenBridgeRelayerContract
    ) public {
        vm.assume(tokenBridgeRelayerContract != bytes32(0));
        vm.assume(chainId_ != 0 && chainId_ != avaxRelayer.chainId());

        // register the contract
        avaxRelayer.registerContract(chainId_, tokenBridgeRelayerContract);

        // verify that the state was updated correctly
        bytes32 registeredContract = avaxRelayer.getRegisteredContract(
            chainId_
        );
        assertEq(registeredContract, tokenBridgeRelayerContract);
    }

    /// @notice This test confirms that the owner cannot register address(0).
    function testRegisterContractZeroAddress() public {
        uint16 chainId_ = 42;
        bytes32 zeroAddress = addressToBytes32(address(0));

        // expect the registerContract call to revert
        vm.expectRevert("contractAddress cannot equal bytes32(0)");
        avaxRelayer.registerContract(chainId_, zeroAddress);
    }

    /**
     * @notice This test confirms that the owner cannot register a foreign
     * TokenBridgeRelayer contract with the same chainId.
     */
    function testRegisterContractThisChainId() public {
        bytes32 tokenBridgeRelayerContract = addressToBytes32(address(this));

        // expect the registerContract call to fail
        bytes memory encodedSignature = abi.encodeWithSignature(
            "registerContract(uint16,bytes32)",
            avaxRelayer.chainId(),
            tokenBridgeRelayerContract
        );
        expectRevert(
            address(avaxRelayer),
            encodedSignature,
            "chainId_ cannot equal 0 or this chainId"
        );
    }

    /**
     * @notice This test confirms that the owner cannot register a foreign
     * TokenBridgeRelayer contract with a chainId of zero.
     */
    function testRegisterContractChainIdZero() public {
        uint16 chainId_ = 0;
        bytes32 tokenBridgeRelayerContract = addressToBytes32(address(this));

        // expect the registerContract call to revert
        vm.expectRevert("chainId_ cannot equal 0 or this chainId");
        avaxRelayer.registerContract(chainId_, tokenBridgeRelayerContract);
    }

    /**
     * @notice This test confirms that ONLY the owner can register a foreign
     * TokenBridgeRelayer contract.
     */
    function testRegisterContractOwnerOnly() public {
        uint16 chainId_ = 42;
        bytes32 tokenBridgeRelayerContract = addressToBytes32(address(this));

        // prank the caller address to something different than the owner's
        vm.startPrank(wallet);

        // expect the registerContract call to revert
        vm.expectRevert("caller not the owner");
        avaxRelayer.registerContract(chainId_, tokenBridgeRelayerContract);

        vm.stopPrank();
    }

    /**
     * @notice This test confirms that the owner can correctly register a token.
     */
    function testRegisterToken() public {
        // test variables
        address token = wavax;

        assertEq(avaxRelayer.isAcceptedToken(token), false);

        // register the contract
        avaxRelayer.registerToken(avaxRelayer.chainId(), token);

        // verify that the state was updated correctly
        assertEq(avaxRelayer.isAcceptedToken(token), true);

        // verify that the registered tokens list was updated
        address[] memory acceptedTokens = avaxRelayer.getAcceptedTokensList();
        assertEq(acceptedTokens[0], token);
    }

    /// @notice This test confirms that the contract cannot register address(0).
    function testRegisterTokenZeroAddress() public {
        // test variables
        address token = address(0);

        // expect the registerToken call to fail
        bytes memory encodedSignature = abi.encodeWithSignature(
            "registerToken(uint16,address)",
            avaxRelayer.chainId(),
            token
        );
        expectRevert(
            address(avaxRelayer),
            encodedSignature,
            "invalid token"
        );
    }

    /**
     * @notice This test confirms that the owner cannot register a token
     * with the wrong chainId.
     */
    function testRegisterTokenThisChainId(uint16 chainId_) public {
        vm.assume(chainId_ != avaxRelayer.chainId());

        // test variables
        address token = address(0);

        // expect the registerToken call to fail
        bytes memory encodedSignature = abi.encodeWithSignature(
            "registerToken(uint16,address)",
            chainId_,
            token
        );
        expectRevert(
            address(avaxRelayer),
            encodedSignature,
            "wrong chain"
        );
    }

    /**
     * @notice This test confirms that the owner cannot register the same
     * token twice.
     */
    function testRegisterTokenAlreadyRegistered() public {
        // test variables
        address token = wavax;

        assertEq(avaxRelayer.isAcceptedToken(token), false);

        // register the contract
        avaxRelayer.registerToken(avaxRelayer.chainId(), token);

        // verify that the state was updated correctly
        assertEq(avaxRelayer.isAcceptedToken(token), true);

        // expect the registerToken call to fail
        bytes memory encodedSignature = abi.encodeWithSignature(
            "registerToken(uint16,address)",
            avaxRelayer.chainId(),
            token
        );
        expectRevert(
            address(avaxRelayer),
            encodedSignature,
            "token already registered"
        );
    }

    ///@notice This test confirms that ONLY the owner can register a token.
    function testRegisterTokenOwnerOnly() public {
        // test variables
        address token = wavax;

        // prank the caller address to something different than the owner's
        vm.startPrank(wallet);

        // expect the registerToken call to fail
        bytes memory encodedSignature = abi.encodeWithSignature(
            "registerToken(uint16,address)",
            avaxRelayer.chainId(),
            token
        );
        expectRevert(
            address(avaxRelayer),
            encodedSignature,
            "caller not the owner"
        );

        vm.stopPrank();
    }

    /**
     * @notice This test confirms that the owner can correctly deregister a token
     * when it's the only token registered.
     */
    function testDeregisterToken(
        uint8 numTokens
    ) public {
        vm.assume(numTokens > 0);

        // create array of token "addresses"
        address[] memory tokens = new address[](numTokens);
        for (uint256 i = 0; i < numTokens; i++) {
            tokens[i] = bytes32ToAddress(
                keccak256(abi.encodePacked(block.number, i))
            );

            // register the token
            avaxRelayer.registerToken(avaxRelayer.chainId(), tokens[i]);
        }

        // confirm that all tokens were registered
        address[] memory tokenList = avaxRelayer.getAcceptedTokensList();
        assertEq(tokenList.length, numTokens);

        // deregister each token
        for (uint256 i = 0; i < numTokens; i++) {
            assertEq(avaxRelayer.isAcceptedToken(tokens[i]), true);
            avaxRelayer.deregisterToken(avaxRelayer.chainId(), tokens[i]);
            assertEq(avaxRelayer.isAcceptedToken(tokens[i]), false);
        }

        // confirm all tokens were removed
        tokenList = avaxRelayer.getAcceptedTokensList();
        assertEq(tokenList.length, 0);
    }

    /**
     * @notice This test confirms that the owner can correctly deregister a token
     * when it's the only token registered.
     */
    function testDeregisterTokenOnlyTokenRegistered() public {
        // test variables
        address token = wavax;

        // register the token
        avaxRelayer.registerToken(avaxRelayer.chainId(), token);

        // verify that the state was updated correctly
        address[] memory tokenList = avaxRelayer.getAcceptedTokensList();
        assertEq(tokenList[0], token);
        assertEq(avaxRelayer.isAcceptedToken(token), true);

        // deregister the token
        avaxRelayer.deregisterToken(avaxRelayer.chainId(), token);

        // verify that the token was removed from the contract's state
        tokenList = avaxRelayer.getAcceptedTokensList();
        assertEq(tokenList.length, 0);
        assertEq(avaxRelayer.isAcceptedToken(token), false);
    }

    /// @notice This test confirms that the contract cannot deregister address(0).
    function testDeregisterTokenZeroAddress() public {
        // test variables
        address token = address(0);

        // expect the registerToken call to fail
        bytes memory encodedSignature = abi.encodeWithSignature(
            "deregisterToken(uint16,address)",
            avaxRelayer.chainId(),
            token
        );
        expectRevert(
            address(avaxRelayer),
            encodedSignature,
            "invalid token"
        );
    }

    /**
     * @notice This test confirms that the owner cannot deregister a token
     * with the wrong chainId.
     */
    function testDeregisterTokenThisChainId(uint16 chainId_) public {
        vm.assume(chainId_ != avaxRelayer.chainId());

        // test variables
        address token = address(0);

        // expect the registerToken call to fail
        bytes memory encodedSignature = abi.encodeWithSignature(
            "deregisterToken(uint16,address)",
            chainId_,
            token
        );
        expectRevert(
            address(avaxRelayer),
            encodedSignature,
            "wrong chain"
        );
    }

    /**
     * @notice This test confirms that the owner cannot deregister a token
     * that is not registered.
     */
    function testDeregisterTokenNotRegistered() public {
        // test variables
        address token = wavax;

        assertEq(avaxRelayer.isAcceptedToken(token), false);

        // expect the registerToken call to fail
        bytes memory encodedSignature = abi.encodeWithSignature(
            "deregisterToken(uint16,address)",
            avaxRelayer.chainId(),
            token
        );
        expectRevert(
            address(avaxRelayer),
            encodedSignature,
            "token not registered"
        );
    }

    ///@notice This test confirms that ONLY the owner can register a token.
    function testDeregisterTokenOwnerOnly() public {
        // test variables
        address token = wavax;

        // prank the caller address to something different than the owner's
        vm.startPrank(wallet);

        // expect the registerToken call to fail
        bytes memory encodedSignature = abi.encodeWithSignature(
            "deregisterToken(uint16,address)",
            avaxRelayer.chainId(),
            token
        );
        expectRevert(
            address(avaxRelayer),
            encodedSignature,
            "caller not the owner"
        );

        vm.stopPrank();
    }

    /**
     * @notice This test confirms that the owner can update the relayer fee
     * for any registered relayer contract.
     */
    function testUpdateRelayerFee(uint16 chainId_, uint256 relayerFee) public {
        address token = address(avaxRelayer.WETH());

        // make some assumptions about the fuzz test values
        vm.assume(chainId_ != 0 && chainId_ != avaxRelayer.chainId());

        // register random target contract
        avaxRelayer.registerContract(chainId_, addressToBytes32(address(this)));

        // register the token
        avaxRelayer.registerToken(avaxRelayer.chainId(), token);

        // update the relayer fee
        avaxRelayer.updateRelayerFee(
            chainId_,
            relayerFee
        );

        // confirm state changes
        assertEq(avaxRelayer.relayerFee(chainId_), relayerFee);
    }

    /**
     * @notice This test confirms that the owner can only update the relayerFee
     * for a registered relayer contract.
     * @dev Explicitly don't register a target contract.
     */
    function testUpdateRelayerFeeContractNotRegistered(uint16 chainId_) public {
        vm.assume(chainId_ != avaxRelayer.chainId());

        // expect the updateRelayerFee method call to fail
        bytes memory encodedSignature = abi.encodeWithSignature(
            "updateRelayerFee(uint16,uint256)",
            chainId_,
            1e18
        );
        expectRevert(
            address(avaxRelayer),
            encodedSignature,
            "contract doesn't exist"
        );
    }

    /**
     * @notice This test confirms that the owner cannot update the relayer
     * fee for the source chain.
     */
    function testUpdateRelayerFeeContractNotRegistered() public {
        uint16 chainId_ = avaxRelayer.chainId();

        // expect the updateRelayerFee method call to fail
        bytes memory encodedSignature = abi.encodeWithSignature(
            "updateRelayerFee(uint16,uint256)",
            chainId_,
            1e18
        );
        expectRevert(
            address(avaxRelayer),
            encodedSignature,
            "invalid chain"
        );
    }

    /**
     * @notice This test confirms that ONLY the owner can update the relayer
     * fee for registered relayer contracts.
     */
    function testUpdateRelayerFeeOwnerOnly() public {
        uint16 chainId_ = 42069;
        uint256 relayerFee = 1e8;

        // register random target contract
        avaxRelayer.registerContract(chainId_, addressToBytes32(address(this)));

        // prank the caller address to something different than the owner's
        vm.startPrank(wallet);

        // expect the updateRelayerFee call to revert
        vm.expectRevert("caller not the owner");
        avaxRelayer.updateRelayerFee(
            chainId_,
            relayerFee
        );

        vm.stopPrank();
    }

    /**
     * @notice This test confirms that the owner can update the relayer fee
     * precision.
     */
    function testUpdateRelayerFeePrecision(
        uint256 relayerFeePrecision_
    ) public {
        vm.assume(relayerFeePrecision_ > 0);

        // update the relayer fee precision
        avaxRelayer.updateRelayerFeePrecision(
            avaxRelayer.chainId(),
            relayerFeePrecision_
        );

        // confirm state changes
        assertEq(
            avaxRelayer.relayerFeePrecision(),
            relayerFeePrecision_
        );
    }

    /**
     * @notice This test confirms that the owner cannot update the relayer
     * fee precision to zero.
     */
    function testUpdateRelayerFeePrecisionZeroAmount() public {
        uint256 relayerFeePrecision_ = 0;

        // expect the updateRelayerFeePrecision to revert
        bytes memory encodedSignature = abi.encodeWithSignature(
            "updateRelayerFeePrecision(uint16,uint256)",
            avaxRelayer.chainId(),
            relayerFeePrecision_
        );
        expectRevert(
            address(avaxRelayer),
            encodedSignature,
            "precision must be > 0"
        );
    }

    /**
     * @notice This test confirms that ONLY the owner can update the relayer fee
     * precision.
     */
    function testUpdateRelayerFeePrecisionOwnerOnly() public {
        uint256 relayerFeePrecision_ = 1e10;

        // prank the caller address to something different than the owner's
        vm.startPrank(wallet);

        // expect the updateRelayerFeePrecision call to revert
        bytes memory encodedSignature = abi.encodeWithSignature(
            "updateRelayerFeePrecision(uint16,uint256)",
            avaxRelayer.chainId(),
            relayerFeePrecision_
        );
        expectRevert(
            address(avaxRelayer),
            encodedSignature,
            "caller not the owner"
        );

        vm.stopPrank();
    }

    /**
     * @notice This test confirms that the owner cannot update the relayer fee
     * precision for the wrong chain.
     */
    function testUpdateRelayerFeePrecisionWrongChain(uint16 chainId_) public {
        vm.assume(chainId_ != avaxRelayer.chainId());

        uint256 relayerFeePrecision_ = 1e10;

        // expect the updateRelayerFeePrecision call to revert
        vm.expectRevert("wrong chain");
        avaxRelayer.updateRelayerFeePrecision(
            chainId_,
            relayerFeePrecision_
        );
    }

    /**
     * @notice This test confirms that the owner can update the swap
     * rate for accepted tokens.
     */
    function testUpdateSwapRate(address token, uint256 swapRate) public {
        vm.assume(swapRate > 0);
        vm.assume(token != address(0));

        // register the token
        avaxRelayer.registerToken(avaxRelayer.chainId(), token);

        // update the swap rate
        avaxRelayer.updateSwapRate(
            avaxRelayer.chainId(),
            token,
            swapRate
        );

        // confirm state changes
        assertEq(avaxRelayer.swapRate(token), swapRate);
    }

    /**
     * @notice This test confirms that the owner cannot update the swap rate
     * to zero.
     */
    function testUpdateSwapRateZeroRate() public {
        // cache token address
        address token = address(avaxRelayer.WETH());
        uint256 swapRate = 0;

        // register the token
        avaxRelayer.registerToken(avaxRelayer.chainId(), token);

        // expect the updateSwapRate call to revert
        bytes memory encodedSignature = abi.encodeWithSignature(
            "updateSwapRate(uint16,address,uint256)",
            avaxRelayer.chainId(),
            token,
            swapRate
        );
        expectRevert(
            address(avaxRelayer),
            encodedSignature,
            "swap rate must be nonzero"
        );
    }

    /**
     * @notice This test confirms that the owner cannot update the swap rate
     * for an unregistered token.
     */
    function testUpdateSwapRateInvalidToken() public {
        // cache token address
        address token = address(avaxRelayer.WETH());
        uint256 swapRate = 1e10;

        // expect the updateSwapRate call to revert
        bytes memory encodedSignature = abi.encodeWithSignature(
            "updateSwapRate(uint16,address,uint256)",
            avaxRelayer.chainId(),
            token,
            swapRate
        );
        expectRevert(
            address(avaxRelayer),
            encodedSignature,
            "token not accepted"
        );
    }

    /// @notice This test confirms that ONLY the owner can update the swap rarte
    function testUpdateSwapRateOwnerOnly() public {
        address token = address(avaxRelayer.WETH());
        uint256 swapRate = 1e10;

        // prank the caller address to something different than the owner's
        vm.startPrank(wallet);

        // expect the updateSwapRate call to revert
        bytes memory encodedSignature = abi.encodeWithSignature(
            "updateSwapRate(uint16,address,uint256)",
            avaxRelayer.chainId(),
            token,
            swapRate
        );
        expectRevert(
            address(avaxRelayer),
            encodedSignature,
            "caller not the owner"
        );

        vm.stopPrank();
    }

    /**
     * @notice This test confirms that the owner cannot update the swap rate
     * for the wrong chain.
     */
    function testUpdateSwapRateWrongChain(uint16 chainId_) public {
        vm.assume(chainId_ != avaxRelayer.chainId());

        address token = address(avaxRelayer.WETH());
        uint256 swapRate = 1e10;

        // expect the updateSwapRate call to revert
        vm.expectRevert("wrong chain");
        avaxRelayer.updateSwapRate(
            chainId_,
            token,
            swapRate
        );
    }

    /**
     * @notice This test confirms that the owner can update the swap rate
     * precision.
     */
    function testUpdateSwapRatePrecision(
        uint256 swapRatePrecision_
    ) public {
        vm.assume(swapRatePrecision_ > 0);

        // update the swap rate precision
        avaxRelayer.updateSwapRatePrecision(
            avaxRelayer.chainId(),
            swapRatePrecision_
        );

        // confirm state changes
        assertEq(
            avaxRelayer.swapRatePrecision(),
            swapRatePrecision_
        );
    }

    /**
     * @notice This test confirms that the owner cannot update the swap
     * rate precision to zero.
     */
    function testUpdateSwapRatePrecisionZeroAmount() public {
        uint256 swapRatePrecision_ = 0;

        // expect the updateSwapRatePrecision to revert
        bytes memory encodedSignature = abi.encodeWithSignature(
            "updateSwapRatePrecision(uint16,uint256)",
            avaxRelayer.chainId(),
            swapRatePrecision_
        );
        expectRevert(
            address(avaxRelayer),
            encodedSignature,
            "precision must be > 0"
        );
    }

    /**
     * @notice This test confirms that ONLY the owner can update the swap rate
     * precision.
     */
    function testUpdateSwapRatePrecisionOwnerOnly() public {
        uint256 swapRatePrecision_ = 1e10;

        // prank the caller address to something different than the owner's
        vm.startPrank(wallet);

        // expect the updateSwapRatePrecision call to revert
        bytes memory encodedSignature = abi.encodeWithSignature(
            "updateSwapRatePrecision(uint16,uint256)",
            avaxRelayer.chainId(),
            swapRatePrecision_
        );
        expectRevert(
            address(avaxRelayer),
            encodedSignature,
            "caller not the owner"
        );

        vm.stopPrank();
    }

    /**
     * @notice This test confirms that the owner cannot update the swap rate
     * precision for the wrong chain.
     */
    function testUpdateSwapRatePrecisionWrongChain(uint16 chainId_) public {
        vm.assume(chainId_ != avaxRelayer.chainId());

        uint256 swapRatePrecision_ = 1e10;

        // expect the updateSwapRatePrecision call to revert
        vm.expectRevert("wrong chain");
        avaxRelayer.updateSwapRatePrecision(
            chainId_,
            swapRatePrecision_
        );
    }

    /**
     * @notice This test confirms that the owner can update the max native
     * swap amount.
     */
    function testUpdateMaxNativeSwapAmount(uint256 maxAmount) public {
        // cache token address
        address token = address(avaxRelayer.WETH());

        // register the token
        avaxRelayer.registerToken(avaxRelayer.chainId(), token);

        // update the native to WETH swap rate
        avaxRelayer.updateMaxNativeSwapAmount(
            avaxRelayer.chainId(),
            token,
            maxAmount
        );

        // confirm state changes
        assertEq(avaxRelayer.maxNativeSwapAmount(token), maxAmount);
    }

    /**
     * @notice This test confirms that the owner can not update the max
     * native swap amount for unregistered tokens.
     */
    function testUpdateMaxNativeSwapAmountInvalidToken() public {
        // cache token address
        address token = address(avaxRelayer.WETH());
        uint256 maxAmount = 1e10;

        // expect the updateMaxNativeSwapAmount call to revert
        bytes memory encodedSignature = abi.encodeWithSignature(
            "updateMaxNativeSwapAmount(uint16,address,uint256)",
            avaxRelayer.chainId(),
            token,
            maxAmount
        );
        expectRevert(
            address(avaxRelayer),
            encodedSignature,
            "token not accepted"
        );
    }

    /**
     * @notice This test confirms that ONLY the owner can update the native
     * max swap amount.
     */
    function testUpdateMaxNativeSwapAmountOwnerOnly() public {
        address token = address(avaxRelayer.WETH());
        uint256 maxAmount = 1e10;

        // register the token
        avaxRelayer.registerToken(avaxRelayer.chainId(), token);

        // prank the caller address to something different than the owner's
        vm.startPrank(wallet);

        // expect the updateNativeMaxSwapAmount call to revert
        bytes memory encodedSignature = abi.encodeWithSignature(
            "updateMaxNativeSwapAmount(uint16,address,uint256)",
            avaxRelayer.chainId(),
            token,
            maxAmount
        );
        expectRevert(
            address(avaxRelayer),
            encodedSignature,
            "caller not the owner"
        );

        vm.stopPrank();
    }

    /**
     * @notice This test confirms that the owner cannot update the max swap
     * amount for the wrong chain.
     */
    function testUpdateMaxNativeSwapAmountWrongChain(uint16 chainId_) public {
        vm.assume(chainId_ != avaxRelayer.chainId());

        address token = address(avaxRelayer.WETH());
        uint256 maxAmount = 1e10;

        // expect the updateMaxNativeSwapRate call to revert
        vm.expectRevert("wrong chain");
        avaxRelayer.updateMaxNativeSwapAmount(
            chainId_,
            token,
            maxAmount
        );
    }
}
