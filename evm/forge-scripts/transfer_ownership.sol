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

    function submitOwnershipTransferRequest(
        address newOwner
    ) internal {
        address currentOwner = relayer.owner();

        relayer.submitOwnershipTransferRequest(
            relayer.chainId(),
            newOwner
        );

        // confirm that the pending owner is set
        require(
            relayer.pendingOwner() == newOwner,
            "pending owner didn't change"
        );

        console.log(
            "Current owner: %s, Pending owner: %s",
            currentOwner,
            newOwner
        );
    }

    function run() public {
        // begin sending transactions
        vm.startBroadcast();

        // submit ownership transfer request
        submitOwnershipTransferRequest(vm.envAddress("NEW_OWNER_ADDRESS"));

        // finished
        vm.stopBroadcast();
    }
}
