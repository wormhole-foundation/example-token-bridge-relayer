/// This module implements serialization and deserialization for relayable token
/// transfers. This message is a specific message encoded as an arbitrary payload
/// via the Wormhole Token Bridge.
module token_bridge_relayer::message {
    use std::vector;

    // Wormhole dependencies.
    use wormhole::cursor;
    use wormhole::external_address::{Self, ExternalAddress};
    use wormhole::bytes::{Self};

    // Token Bridge dependencies.
    use token_bridge::normalized_amount::{Self, NormalizedAmount};

    /// Errors.
    const E_INVALID_RECIPIENT: u64 = 0;
    const E_INVALID_MESSAGE: u64 = 1;

    /// Transfer with relay payload ID.
    const MESSAGE_TRANSFER_WITH_RELAY: u8 = 1;

    /// Container that warehouses transfer information sent from registered
    /// Token Bridge Relayer contracts.
    ///
    /// NOTE: This struct has `drop` because we do not want to require an
    /// integrator receiving transfer information to have to manually destroy.
    struct TransferWithRelay has drop {
        /// Relayer fee in token terms.
        target_relayer_fee: NormalizedAmount,

        /// Quantity of transferred tokens to swap for native tokens.
        to_native_token_amount: NormalizedAmount,

        /// The recipient of the token transfer on the target chain.
        recipient: ExternalAddress,
    }

    /// Creates new `TransferWithRelay` type.
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

    /// Encodes a `TransferWithRelay` message to be sent by the Wormhole
    /// Token Bridge.
    public fun serialize(transfer_with_relay: TransferWithRelay): vector<u8> {
        let encoded = vector::empty<u8>();

        // Message payload ID.
        bytes::push_u8(&mut encoded, MESSAGE_TRANSFER_WITH_RELAY);

        // `target_relayer_fee`
        vector::append(
            &mut encoded,
            normalized_amount::to_bytes(transfer_with_relay.target_relayer_fee)
        );

        // `to_native_token_amount`
        vector::append(
            &mut encoded,
            normalized_amount::to_bytes(
                transfer_with_relay.to_native_token_amount
            )
        );

        // `recipient`
        vector::append(
            &mut encoded,
            external_address::to_bytes(transfer_with_relay.recipient)
        );

        // Return.
        encoded
    }

    /// Decodes a `TransferWithRelay` message into the the `TransferWithRelay`
    /// container.
    public fun deserialize(buf: vector<u8>): TransferWithRelay {
        let cur = cursor::new(buf);

        // Verify the message type.
        assert!(
            bytes::take_u8(&mut cur) == MESSAGE_TRANSFER_WITH_RELAY,
            E_INVALID_MESSAGE
        );

        // Deserialize the rest of the payload.
        let target_relayer_fee = normalized_amount::take_bytes(&mut cur);
        let to_native_token_amount =
            normalized_amount::take_bytes(&mut cur);
        let recipient = external_address::take_bytes(&mut cur);

        // Destory the cursor.
        cursor::destroy_empty(cur);

        // Return the deserialized struct.
        new(
            target_relayer_fee,
            to_native_token_amount,
            recipient
        )
    }

    // Getters.

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
}

#[test_only]
module token_bridge_relayer::message_tests {
    // Token Bridge Relayer modules.
    use token_bridge_relayer::message::{Self};

    // Wormhole dependencies.
    use wormhole::external_address::{Self};

    // Token Bridge dependencies.
    use token_bridge::normalized_amount::{Self};

    /// Test consts.
    const TEST_TRANSFER_WITH_RELAY: vector<u8> = x"0100000000000000000000000000000000000000000000000000000000000035b900000000000000000000000000000000000000000000000000000000000032530000000000000000000000000000000000000000000000000000000000003bf0";
    const TEST_TARGET_RELAYER_FEE: u64 = 13753;
    const TEST_TO_NATIVE_TOKEN_AMOUNT: u64 = 12883;
    const TEST_RECIPIENT: address = @0x3bf0;
    const TEST_DECIMALS: u8 = 8;

    #[test]
    public fun new() {
        let target_relayer_fee = normalized_amount::from_raw(
            TEST_TARGET_RELAYER_FEE,
            TEST_DECIMALS
        );
        let to_native_token_amount = normalized_amount::from_raw(
            TEST_TO_NATIVE_TOKEN_AMOUNT,
            TEST_DECIMALS
        );
        let recipient = external_address::from_address(TEST_RECIPIENT);

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
        let target_relayer_fee = normalized_amount::from_raw(
            TEST_TARGET_RELAYER_FEE,
            TEST_DECIMALS
        );
        let to_native_token_amount = normalized_amount::from_raw(
            TEST_TO_NATIVE_TOKEN_AMOUNT,
            TEST_DECIMALS
        );
        let recipient = external_address::from_address(TEST_RECIPIENT);

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
        let target_relayer_fee = normalized_amount::from_raw(
            TEST_TARGET_RELAYER_FEE,
            TEST_DECIMALS
        );
        let to_native_token_amount = normalized_amount::from_raw(
            TEST_TO_NATIVE_TOKEN_AMOUNT,
            TEST_DECIMALS
        );
        let recipient = external_address::from_address(TEST_RECIPIENT);

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
