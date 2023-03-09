module token_bridge_relayer::message {
    use std::vector;

    use wormhole::cursor;
    use wormhole::external_address::{Self, ExternalAddress};
    use wormhole::bytes::{Self};

    use token_bridge::normalized_amount::{Self, NormalizedAmount};

    // Errors.
    const E_INVALID_RECIPIENT: u64 = 0;
    const E_INVALID_MESSAGE: u64 = 1;

    // Payload IDs.
    const MESSAGE_TRANSFER_WITH_RELAY: u8 = 1;

    struct TransferWithRelay has drop {
        /// Relayer fee.
        target_relayer_fee: NormalizedAmount,

        /// Quantity of transferred tokens to swap for native tokens.
        to_native_token_amount: NormalizedAmount,

        /// The recipient of the token transfer on the target chain.
        recipient: ExternalAddress,
    }

    public fun new(
        target_relayer_fee: NormalizedAmount,
        to_native_token_amount: NormalizedAmount,
        recipient: ExternalAddress
    ): TransferWithRelay {
        TransferWithRelay {
            target_relayer_fee,
            to_native_token_amount,
            recipient
        }
    }

    public fun target_relayer_fee(
        self: &TransferWithRelay
    ): NormalizedAmount {
        self.target_relayer_fee
    }

    public fun to_native_token_amount(
        self: &TransferWithRelay
    ): NormalizedAmount {
        self.to_native_token_amount
    }

    public fun recipient(self: &TransferWithRelay): ExternalAddress {
        self.recipient
    }

    public fun serialize(transfer_with_relay: TransferWithRelay): vector<u8> {
        let encoded = vector::empty<u8>();

        // Message payload ID.
        bytes::serialize_u8(&mut encoded, MESSAGE_TRANSFER_WITH_RELAY);

        // Target relayer fee.
        normalized_amount::serialize_be(
            &mut encoded,
            transfer_with_relay.target_relayer_fee
        );

        // To native token amount.
        normalized_amount::serialize_be(
            &mut encoded,
            transfer_with_relay.to_native_token_amount
        );

        // Recipient.
        external_address::serialize(
            &mut encoded,
            transfer_with_relay.recipient
        );

        // Return.
        encoded
    }

    public fun deserialize(buf: vector<u8>): TransferWithRelay {
        let cur = cursor::new(buf);

        // Verify the message type.
        assert!(
            bytes::deserialize_u8(&mut cur) == MESSAGE_TRANSFER_WITH_RELAY,
            E_INVALID_MESSAGE
        );

        // Deserialize the rest of the payload.
        let target_relayer_fee = normalized_amount::deserialize_be(&mut cur);
        let to_native_token_amount =
            normalized_amount::deserialize_be(&mut cur);
        let recipient = external_address::deserialize(&mut cur);

        // Destory the cursor.
        cursor::destroy_empty(cur);

        // Return the deserialized struct.
        new(
            target_relayer_fee,
            to_native_token_amount,
            recipient
        )
    }
}

#[test_only]
module token_bridge_relayer::message_tests {
    use token_bridge_relayer::message::{Self};

    use wormhole::external_address::{Self};

    use token_bridge::normalized_amount::{Self};

    // Test consts.
    // Encoded TransferWithRelay message.
    const TEST_TRANSFER_WITH_RELAY: vector<u8> = x"0100000000000000000000000000000000000000000000000000000000000035b900000000000000000000000000000000000000000000000000000000000032530000000000000000000000000000000000000000000000000000000000003bf0";
    const TEST_TARGET_RELAYER_FEE: u64 = 13753;
    const TEST_TO_NATIVE_TOKEN_AMOUNT: u64 = 12883;
    const TEST_RECIPIENT: vector<u8> = x"3bf0";

    #[test]
    public fun new() {
        let target_relayer_fee = normalized_amount::new(
            TEST_TARGET_RELAYER_FEE
        );
        let to_native_token_amount = normalized_amount::new(
            TEST_TO_NATIVE_TOKEN_AMOUNT
        );
        let recipient = external_address::from_bytes(TEST_RECIPIENT);

        // Create a TransferWithRelay struct.
        let transfer_with_relay = message::new(
            target_relayer_fee,
            to_native_token_amount,
            recipient
        );

        // Confirm that the struct is correct.
        assert!(
            target_relayer_fee == message::target_relayer_fee(
                &transfer_with_relay
            ),
            0
        );
        assert!(
            to_native_token_amount == message::to_native_token_amount(
                &transfer_with_relay
            ),
            0
        );
        assert!(
            recipient == message::recipient(&transfer_with_relay),
            0
        );
    }

    #[test]
    public fun serialize() {
        let target_relayer_fee = normalized_amount::new(
            TEST_TARGET_RELAYER_FEE
        );
        let to_native_token_amount = normalized_amount::new(
            TEST_TO_NATIVE_TOKEN_AMOUNT
        );
        let recipient = external_address::from_bytes(TEST_RECIPIENT);

        // Create a TransferWithRelay struct.
        let transfer_with_relay = message::new(
            target_relayer_fee,
            to_native_token_amount,
            recipient
        );

        // Serialize the struct and confirm it was serialized correctly.
        let serialized_transfer_with_relay = message::serialize(
            transfer_with_relay
        );

        assert!(serialized_transfer_with_relay == TEST_TRANSFER_WITH_RELAY, 0);
    }

    #[test]
    public fun deserialize() {
        // Expected output from parsing the encoded message above.
        let target_relayer_fee = normalized_amount::new(
            TEST_TARGET_RELAYER_FEE
        );
        let to_native_token_amount = normalized_amount::new(
            TEST_TO_NATIVE_TOKEN_AMOUNT
        );
        let recipient = external_address::from_bytes(TEST_RECIPIENT);

        // Deserialize the TransferWithRelay struct.
        let deserialized_transfer_with_relay =
            message::deserialize(TEST_TRANSFER_WITH_RELAY);

        // Confirm that the deserialized struct is correct.
        assert!(
            target_relayer_fee == message::target_relayer_fee(
                &deserialized_transfer_with_relay
            ),
            0
        );
        assert!(
            to_native_token_amount == message::to_native_token_amount(
                &deserialized_transfer_with_relay
            ),
            0
        );
        assert!(
            recipient == message::recipient(
                &deserialized_transfer_with_relay
            ),
            0
        );
    }
}
