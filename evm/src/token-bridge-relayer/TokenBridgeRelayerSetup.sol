// SPDX-License-Identifier: Apache 2
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Upgrade.sol";
import {Context} from "@openzeppelin/contracts/utils/Context.sol";

import "./TokenBridgeRelayerGetters.sol";

contract TokenBridgeRelayerSetup is TokenBridgeRelayerGetters, ERC1967Upgrade, Context {
    function setup(
        address implementation,
        uint16 chainId,
        address wormhole,
        address tokenBridge_,
        uint256 swapRatePrecision,
        uint256 relayerFeePrecision
    ) public {
        require(implementation != address(0), "invalid implementation");
        require(chainId > 0, "invalid chainId");
        require(wormhole != address(0), "invalid wormhole address");
        require(tokenBridge_ != address(0), "invalid token bridge address");
        require(swapRatePrecision != 0, "swap rate precision must be > 0");
        require(relayerFeePrecision != 0, "relayer fee precision must be > 0");

        setOwner(_msgSender());
        setChainId(chainId);
        setWormhole(wormhole);
        setTokenBridge(tokenBridge_);
        setSwapRatePrecision(swapRatePrecision);
        setRelayerFeePrecision(relayerFeePrecision);

        // set the wethAddress based on the token bridges WETH getter
        setWethAddress(address(tokenBridge().WETH()));

        // set the implementation
        _upgradeTo(implementation);

        // call initialize function of the new implementation
        (bool success, bytes memory reason) = implementation.delegatecall(
            abi.encodeWithSignature("initialize()")
        );
        require(success, string(reason));
    }
}
