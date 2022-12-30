// SPDX-License-Identifier: Apache 2
pragma solidity ^0.8.13;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Upgrade.sol";

import "./TokenBridgeRelayer.sol";

contract TokenBridgeRelayerImplementation is TokenBridgeRelayer {
    function initialize() initializer public virtual {}

    modifier initializer() {
        address impl = ERC1967Upgrade._getImplementation();

        require(!isInitialized(impl), "already initialized");

        setInitialized(impl);

        _;
    }
}
