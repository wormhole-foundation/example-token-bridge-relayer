// SPDX-License-Identifier: Apache 2
pragma solidity ^0.8.17;

import {IWETH} from "../src/interfaces/IWETH.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Helpers {
    function wrap(address weth, uint256 amount) internal {
        // wrap specified amount of WETH
        IWETH(weth).deposit{value: amount}();
    }

    function addressToBytes32(address address_) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(address_)));
    }

    function bytes32ToAddress(bytes32 address_) internal pure returns (address) {
        return address(uint160(uint256(address_)));
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
}
