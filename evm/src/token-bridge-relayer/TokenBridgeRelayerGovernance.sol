// SPDX-License-Identifier: Apache 2
pragma solidity ^0.8.13;

import {IWormhole} from "../interfaces/IWormhole.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC1967Upgrade} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Upgrade.sol";

import "./TokenBridgeRelayerGetters.sol";

contract TokenBridgeRelayerGovernance is TokenBridgeRelayerGetters, ERC1967Upgrade {
    event ContractUpgraded(address indexed oldContract, address indexed newContract);
    event WormholeFinalityUpdated(uint8 indexed oldLevel, uint8 indexed newFinality);
    event OwnershipTransfered(address indexed oldOwner, address indexed newOwner);
    event SwapRateUpdated(address indexed token, uint256 indexed swapRate);

    /**
     * @notice Upgrades contract the implementation (logic contract)
     * @param chainId_ Wormhole chain ID
     * @param newImplementation Address of the new implementation (logic) contract
     */
    function upgrade(
        uint16 chainId_,
        address newImplementation
    ) public onlyOwner checkChain(chainId_) {
        require(newImplementation != address(0), "invalid implementation");

        address currentImplementation = _getImplementation();

        _upgradeTo(newImplementation);

        // call initialize function of the new implementation
        (bool success, bytes memory reason) = newImplementation.delegatecall(
            abi.encodeWithSignature("initialize()")
        );

        require(success, string(reason));

        emit ContractUpgraded(currentImplementation, newImplementation);
    }

    /**
     * @notice Starts the ownership transfer process of the contracts. It saves
     * an address in the pending owner state variable.
     * @param chainId_ Wormhole chain ID
     * @param newOwner Address of the pending owner
     */
    function submitOwnershipTransferRequest(
        uint16 chainId_,
        address newOwner
    ) public onlyOwner checkChain(chainId_) {
        require(newOwner != address(0), "newOwner cannot equal address(0)");

        setPendingOwner(newOwner);
    }

    /**
     * @notice Finalizes the ownership transfer to the pending owner
     * @dev It checks that the caller is the pendingOwner to validate the wallet
     * address. It updates the owner state variable with the pendingOwner state
     * variable.
     */
    function confirmOwnershipTransferRequest() public {
        // cache the new owner address
        address newOwner = pendingOwner();

        require(msg.sender == newOwner, "caller must be pendingOwner");

        // cache currentOwner for Event
        address currentOwner = owner();

        // update the owner in the contract state and reset the pending owner
        setOwner(newOwner);
        setPendingOwner(address(0));

        emit OwnershipTransfered(currentOwner, newOwner);
    }

    /**
     * @notice Registers foreign Token Bridge Relayer contracts
     * @param chainId_ Wormhole chain ID of the foreign contract
     * @param contractAddress Address of the foreign contract in bytes32 format
     * (zero-left-padded address).
     */
    function registerContract(
        uint16 chainId_,
        bytes32 contractAddress
    ) public onlyOwner {
        // sanity check both input arguments
        require(
            contractAddress != bytes32(0),
            "contractAddress cannot equal bytes32(0)"
        );
        require(
            chainId_ != 0 && chainId_ != chainId(),
            "chainId_ cannot equal 0 or this chainId"
        );

        // update the registeredContracts state variable
        _registerContract(chainId_, contractAddress);
    }

    /**
     * @notice Register tokens accepted by this contract
     * @param chainId_ Wormhole chain ID
     * @param token Address of the token
     */
    function registerToken(
        uint16 chainId_,
        address token
    ) public onlyOwner checkChain(chainId_) {
        require(token != address(0), "invalid token");
        require(!isAcceptedToken(token), "token already registered");

        addAcceptedToken(token);
    }

    /**
     * @notice Update the fee for relaying transfers to foreign contracts
     * @dev This function can update the source contract's record of the relayer
     * fee.
     * @param chainId_ Wormhole chain ID
     * @param token Address of the token to update the relayer fee for
     * @param amount Quantity of tokens to pay the relayer upon redemption
     */
    function updateRelayerFee(
        uint16 chainId_,
        address token,
        uint256 amount
    ) public onlyOwner {
        require(
            (chainId_ == chainId()) ||
            getRegisteredContract(chainId_) != bytes32(0),
            "contract doesn't exist"
        );
        require(isAcceptedToken(token), "token not accepted");

        // make sure the normalized relayer fee is nonzero
        uint8 decimals = getDecimals(token);
        require(
            amount == 0 || normalizeAmount(amount, decimals) > 0,
            "invalid relayer fee"
        );

        setRelayerFee(chainId_, token, amount);
    }

    /**
     * @notice Updates the conversion rate between the native asset of this chain
     * and the specified token.
     * @param chainId_ Wormhole chain ID
     * @param token Address of the token to update the conversion rate for
     * @param swapRate The native -> token conversion rate.
     * @dev The swapRate is the conversion rate using asset prices denominated in
     * USD multiplied by the nativeSwapRatePrecision. For example, if the conversion
     * rate is $15 and the nativeSwapRatePrecision is 1000000, the swapRate should be set
     * to 15000000.
     */
    function updateNativeSwapRate(
        uint16 chainId_,
        address token,
        uint256 swapRate
    ) public onlyOwner checkChain(chainId_) {
        require(isAcceptedToken(token), "token not accepted");
        require(swapRate > 0, "swap rate must be nonzero");

        setNativeSwapRate(token, swapRate);

        emit SwapRateUpdated(token, swapRate);
    }

    /**
     * @notice Updates the precision of the native swap rate
     * @param chainId_ Wormhole chain ID
     * @param nativeSwapRatePrecision_ Precision of native swap rate
     */
    function updateNativeSwapRatePrecision(
        uint16 chainId_,
        uint256 nativeSwapRatePrecision_
    ) public onlyOwner checkChain(chainId_) {
        require(nativeSwapRatePrecision_ > 0, "precision must be > 0");

        setNativeSwapRatePrecision(nativeSwapRatePrecision_);
    }

    /**
     * @notice Updates the max amount of native assets the contract will pay
     * to the target recipient.
     * @param chainId_ Wormhole chain ID
     * @param token Address of the token to update the max native swap amount for
     * @param maxAmount Max amount of native assets
     */
    function updateMaxNativeSwapAmount(
        uint16 chainId_,
        address token,
        uint256 maxAmount
    ) public onlyOwner checkChain(chainId_) {
        require(isAcceptedToken(token), "token not accepted");

        setMaxNativeSwapAmount(token, maxAmount);
    }

    modifier onlyOwner() {
        require(owner() == msg.sender, "caller not the owner");
        _;
    }

    modifier checkChain(uint16 chainId_) {
        require(chainId() == chainId_, "wrong chain");
        _;
    }
}
