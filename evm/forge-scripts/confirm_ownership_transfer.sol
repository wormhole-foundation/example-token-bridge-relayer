// SPDX-License-Identifier: Apache 2

pragma solidity ^0.8.17;

import "forge-std/Script.sol";
import "forge-std/console.sol";

import {ITokenBridgeRelayer} from "../src/interfaces/ITokenBridgeRelayer.sol";

contract ContractScript is Script {
    // contracts
    ITokenBridgeRelayer relayer;

    function setUp() public {
        relayer = ITokenBridgeRelayer(vm.envAddress("RELAYER_CONTRACT_ADDRESS"));
    }

    function confirmOwnershipTransferRequest() internal {
        relayer.confirmOwnershipTransferRequest();

        // confirm that the pending owner is address(0)
        require(
            relayer.pendingOwner() == address(0) &&
            relayer.owner() == msg.sender,
            "failed to transfer ownership"
        );
    }

    function run() public {
        // begin sending transactions
        vm.startBroadcast();

        // submit ownership transfer request
        confirmOwnershipTransferRequest();

        // finished
        vm.stopBroadcast();
    }
}
