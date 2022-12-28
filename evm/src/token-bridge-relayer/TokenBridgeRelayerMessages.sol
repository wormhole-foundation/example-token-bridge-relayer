// SPDX-License-Identifier: Apache 2
pragma solidity ^0.8.13;

import "../libraries/BytesLib.sol";

import "./TokenBridgeRelayerStructs.sol";

contract TokenBridgeRelayerMessages is TokenBridgeRelayerStructs {
    using BytesLib for bytes;

    /**
     * @notice Encodes the TokenBridgeRelayerMessage struct into bytes
     * @param parsedMessage TokenBridgeRelayerMessage struct
     * @return encodedMessage TokenBridgeRelayerMessage struct encoded into bytes
     */
    function encodePayload(
        TokenBridgeRelayerMessage memory parsedMessage
    ) public pure returns (bytes memory encodedMessage) {
        encodedMessage = abi.encodePacked(
            parsedMessage.payloadID, // payloadID = 1
            parsedMessage.targetRecipient
        );
    }

    /**
     * @notice Decodes bytes into TokenBridgeRelayerMessage struct
     * @dev reverts if:
     * - the message payloadID is not 1
     * - the encodedMessage length is incorrect
     * @param encodedMessage encoded TokenBridgeRelayer message
     * @return parsedMessage TokenBridgeRelayerMessage struct
     */
    function decodePayload(
        bytes memory encodedMessage
    ) public pure returns (TokenBridgeRelayerMessage memory parsedMessage) {
        uint256 index = 0;

        // parse payloadId
        parsedMessage.payloadID = encodedMessage.toUint8(index);
        require(parsedMessage.payloadID == 1, "invalid payloadID");
        index += 1;

        // target wallet recipient
        parsedMessage.targetRecipient = encodedMessage.toBytes32(index);
        index += 32;

        // confirm that the payload was the expected size
        require(index == encodedMessage.length, "invalid payload length");
    }
}
