module token_bridge_relayer::transfer {
    use sui::sui::SUI;
    use sui::coin::{Self, Coin};
    use sui::transfer::{Self};
    use sui::tx_context::{Self, TxContext};

    use token_bridge::normalized_amount::{Self};
    use token_bridge::state::{Self as bridge_state, State as TokenBridgeState};
    use token_bridge::transfer_tokens_with_payload::{transfer_tokens_with_payload};
    // use token_bridge::complete_transfer_with_payload::{
    //     complete_transfer_with_payload
    // };
    // use token_bridge::transfer_with_payload::{payload, sender};

    use wormhole::external_address::{Self};
    use wormhole::state::{State as WormholeState};

    use token_bridge_relayer::message::{Self};
    use token_bridge_relayer::state::{Self as relayer_state, State};
    use token_bridge_relayer::bytes32::{Self};

    // Errors.
    const E_INVALID_TARGET_RECIPIENT: u64 = 0;
    const E_UNREGISTERED_FOREIGN_CONTRACT: u64 = 1;
    const E_INSUFFICIENT_AMOUNT: u64 = 2;
    const E_UNREGISTERED_COIN: u64 = 3;
    const E_INSUFFICIENT_TO_NATIVE_AMOUNT: u64 = 4;

    public entry fun transfer_tokens_with_relay<C>(
        t_state: &State,
        wormhole_state: &mut WormholeState,
        token_bridge_state: &mut TokenBridgeState,
        coins: Coin<C>,
        to_native_token_amount: u64,
        wormhole_fee: Coin<SUI>,
        target_chain: u16,
        nonce: u32,
        target_recipient: vector<u8>,
        ctx: &mut TxContext
    ) {
        // Confirm that the coin is registered with this contract.
        assert!(
            relayer_state::is_registered_token<C>(t_state),
            E_UNREGISTERED_COIN
        );

        // Cache the target_recipient ExternalAddress and verify that the
        // target_recipient is not the zero address.
        let target_recipient_address = external_address::from_bytes(
            target_recipient
        );
        assert!(
            external_address::is_nonzero(&target_recipient_address),
            E_INVALID_TARGET_RECIPIENT
        );

        // Fetch the token decimals from the token bridge,
        // and cache the token amount.
        let decimals = bridge_state::coin_decimals<C>(token_bridge_state);
        let amount_received = coin::value(&coins);

        // Compute the truncated to native token amount.
        let transformed_to_native_amount = normalized_amount::from_raw(
            to_native_token_amount,
            decimals
        );
        assert!(
            to_native_token_amount == 0 ||
            normalized_amount::value(&transformed_to_native_amount) > 0,
            E_INSUFFICIENT_TO_NATIVE_AMOUNT
        );

        // Confirm that the target chain has a registered contract.
        assert!(
            relayer_state::contract_registered(t_state, target_chain),
            E_UNREGISTERED_FOREIGN_CONTRACT
        );
        let foreign_contract =
            relayer_state::foreign_contract_address(t_state, target_chain);

        // Compute the normalized relayer fee and confirm that the user
        // sent enough tokens to cover the relayer fee and to native
        // token amount.
        let transformed_relayer_fee = normalized_amount::new(
                relayer_state::token_relayer_fee<C>(
                    t_state,
                    target_chain,
                    decimals
                )
            );

        // Compute the truncated token amount.
        let transformed_amount = normalized_amount::to_raw(
            normalized_amount::from_raw(
                amount_received,
                decimals
            ),
            decimals
        );
        assert!(
            transformed_amount >
                normalized_amount::value(&transformed_relayer_fee) +
                normalized_amount::value(&transformed_to_native_amount),
            E_INSUFFICIENT_AMOUNT
        );

        // Create the TransferWithRelay message.
        let msg = message::serialize(
            message::new(
                transformed_relayer_fee,
                transformed_to_native_amount,
                target_recipient_address
            )
        );

        // Split the coins object and send dust back to the user if
        // the `transformed_amount` is less the original amount.
        let coins_to_transfer;
        if (transformed_amount < amount_received){
            coins_to_transfer = coin::split(&mut coins, transformed_amount, ctx);

            // Return the original object with the dust.
            transfer::transfer(coins, tx_context::sender(ctx))
        } else {
            coins_to_transfer = coins;
        };

        // Finally transfer tokens via Token Bridge.
        transfer_tokens_with_payload(
            relayer_state::emitter_cap(t_state),
            wormhole_state,
            token_bridge_state,
            coins_to_transfer,
            wormhole_fee,
            target_chain,
            external_address::left_pad(&bytes32::data(foreign_contract)),
            nonce,
            msg
        );
    }

    // /// Consumes `transfer_with_payload` Wormhole message from a registered
    // /// foreign contract. Sends the transferred tokens to the recipient encoded
    // /// in the additional payload, and pays the relayer a fee if the user is
    // /// not self redeeming the transfer.
    // public entry fun redeem_transfer_with_payload<C>(
    //     t_state: &State,
    //     wormhole_state: &mut WormholeState,
    //     token_bridge_state: &mut TokenBridgeState,
    //     vaa: vector<u8>,
    //     ctx: &mut TxContext
    //  ) {
    //     // Complete the transfer on the Token Bridge. This call returns the
    //     // coin object for the amount transferred via the Token Bridge. It
    //     // also returns the chain ID of the message sender.
    //     let (coins, transfer_payload, emitter_chain_id) =
    //         complete_transfer_with_payload<C>(
    //             token_bridge_state,
    //             state::emitter_cap(t_state),
    //             wormhole_state,
    //             vaa,
    //             ctx
    //         );

    //     // Confirm that the emitter is a registered contract.
    //     assert!(
    //         *state::foreign_contract_address(
    //             t_state,
    //             emitter_chain_id
    //         ) == bytes32::from_external_address(
    //             &sender(&transfer_payload)
    //         ),
    //         E_UNREGISTERED_FOREIGN_CONTRACT
    //     );

    //     // Parse the additional payload.
    //     let msg = message::decode(payload(&transfer_payload));

    //     // Parse the recipient field.
    //     let recipient = to_address(
    //         &make_external(&bytes32::data(message::recipient(&msg)))
    //     );

    //     // Calculate the relayer fee.
    //     let relayer_fee = 0; /*state::compute_relayer_fee(
    //         t_state,
    //         coin::value(&coins)
    //     );*/

    //     // If the relayer fee is nonzero and the user is not self redeeming,
    //     // split the coins object and transfer the relayer fee to the signer.
    //     if (relayer_fee > 0 && recipient != tx_context::sender(ctx)) {
    //         let coins_for_relayer = coin::split(&mut coins, relayer_fee, ctx);

    //         // Send the caller the relayer fee.
    //         transfer::transfer(coins_for_relayer, tx_context::sender(ctx));
    //     };

    //     // Send the coins to the target recipient.
    //     transfer::transfer(coins, recipient);
    // }
}

#[test_only]
module token_bridge_relayer::transfer_tests {
    //use std::vector::{Self};

    use sui::sui::SUI;
    use sui::test_scenario::{Self, Scenario, TransactionEffects};
    use sui::coin::{Self, Coin, CoinMetadata};
    use sui::object::{Self};
    use sui::transfer::{Self as native_transfer};
    use sui::tx_context::{TxContext};

    use token_bridge_relayer::owner::{Self, OwnerCap};
    use token_bridge_relayer::transfer::{Self};
    use token_bridge_relayer::state::{State};
    use token_bridge_relayer::init_tests::{set_up, people};
    use token_bridge_relayer::relayer_fees::{Self};

    use wormhole::state::{
        Self as wormhole_state_module,
        State as WormholeState
    };

    use token_bridge::state::{State as BridgeState};//, deposit_test_only};
    use token_bridge::attest_token::{Self};

    // Example coins.
    use example_coins::coin_8::{Self, COIN_8};
    use example_coins::coin_9::{Self, COIN_9};

    // Test consts.
    const TEST_MAX_U64: u64 = 18446744073709551614;

    #[test]
    /// This test transfers tokens with an additional payload using example coin 8
    /// (which has 8 decimals).
    public fun transfer_tokens_with_relay_coin_8() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            x"0000000000000000000000000000000000000000000000000000000000000069";
        let coin_supply: u64 = 4206900000000; // 42069
        let to_native_token_amount = 500000000; // 5
        let target_recipient =
            x"000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe";
        let swap_rate: u64 = 690000000; // 6.9 USD
        let max_native_swap_amount: u64 = 1000000000; // 10
        let relayer_fee: u64 = 1000000000; // 10

        // Registration knobs, should be used to test negative test cases.
        let should_register_contract: bool = true;
        let should_register_token: bool = true;

        // Mint token 8, fetch the metadata and store the object ID for later.
        let (test_coin, test_metadata) = mint_coin_8(
            coin_supply,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Test transfer with COIN_8.
        test_transfer_tokens_with_relay(
            target_chain,
            target_contract,
            test_coin,
            test_metadata,
            to_native_token_amount,
            target_recipient,
            should_register_contract,
            should_register_token,
            swap_rate,
            max_native_swap_amount,
            relayer_fee,
            creator,
            scenario
        );

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun transfer_tokens_with_relay_coin_8_maximum_amount() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            x"0000000000000000000000000000000000000000000000000000000000000069";
        let max_coin_supply: u64 = TEST_MAX_U64; // Maximum amount.
        let to_native_token_amount = 500000000; // 5
        let target_recipient =
            x"000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe";
        let swap_rate: u64 = 690000000; // 6.9 USD
        let max_native_swap_amount: u64 = 1000000000; // 10
        let relayer_fee: u64 = 1000000000; // 10

        // Registration knobs, should be used to test negative test cases.
        let should_register_contract: bool = true;
        let should_register_token: bool = true;

        // Mint token 8, fetch the metadata and store the object ID for later.
        let (test_coin, test_metadata) = mint_coin_8(
            max_coin_supply,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Test transfer with COIN_8.
        test_transfer_tokens_with_relay(
            target_chain,
            target_contract,
            test_coin,
            test_metadata,
            to_native_token_amount,
            target_recipient,
            should_register_contract,
            should_register_token,
            swap_rate,
            max_native_swap_amount,
            relayer_fee,
            creator,
            scenario
        );

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun transfer_tokens_with_relay_coin_8_minimum_amount() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            x"0000000000000000000000000000000000000000000000000000000000000069";
        let min_coin_supply: u64 = 1; // Minimum amount.
        let to_native_token_amount = 0; // 5
        let target_recipient =
            x"000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe";
        let swap_rate: u64 = 690000000; // 6.9 USD
        let max_native_swap_amount: u64 = 1000000000; // 10
        let relayer_fee: u64 = 0; // 10

        // Registration knobs, should be used to test negative test cases.
        let should_register_contract: bool = true;
        let should_register_token: bool = true;

        // Mint token 8, fetch the metadata and store the object ID for later.
        let (test_coin, test_metadata) = mint_coin_8(
            min_coin_supply,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Test transfer with COIN_8.
        test_transfer_tokens_with_relay(
            target_chain,
            target_contract,
            test_coin,
            test_metadata,
            to_native_token_amount,
            target_recipient,
            should_register_contract,
            should_register_token,
            swap_rate,
            max_native_swap_amount,
            relayer_fee,
            creator,
            scenario
        );

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    /// This test transfers tokens with an additional payload using example coin 9
    /// (which has 9 decimals).
    public fun transfer_tokens_with_relay_coin_9() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            x"0000000000000000000000000000000000000000000000000000000000000069";
        let coin_supply: u64 = 42069000000009; // 42069.000000000009
        // Since COIN_9 has 9 decimals, the token bridge will truncate the
        // value. This is the expected amount to be returned by the contract.
        let expected_dust: u64 = 9;
        let to_native_token_amount = 1000000000; // 10
        let target_recipient =
            x"000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe";
        let swap_rate: u64 = 690000000; // 6.9 USD
        let max_native_swap_amount: u64 = 100000000000; // 100
        let relayer_fee: u64 = 1000000000; // 10

        // Registration knobs, should be used to test negative cases.
        let should_register_contract: bool = true;
        let should_register_token: bool = true;

        // Mint token 8, fetch the metadata and store the object ID for later.
        let (test_coin, test_metadata) = mint_coin_9(
            coin_supply,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Store test coin ID for later use.
        let test_coin_id = object::id(&test_coin);

        // Test transfer with COIN_9.
        test_transfer_tokens_with_relay(
            target_chain,
            target_contract,
            test_coin,
            test_metadata,
            to_native_token_amount,
            target_recipient,
            should_register_contract,
            should_register_token,
            swap_rate,
            max_native_swap_amount,
            relayer_fee,
            creator,
            scenario
        );

        // Confirm that the dust object was returned to the caller.
        let dust_object =
            test_scenario::take_from_sender_by_id<Coin<COIN_9>>(
                scenario,
                test_coin_id
            );

        // Confirm that the value of the token is non-zero.
        assert!(coin::value(&dust_object) == expected_dust, 0);

        // Bye bye.
        test_scenario::return_to_sender(scenario, dust_object);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    /// This test transfers tokens with an additional payload using example coin 9
    /// (which has 9 decimals). The last digit in the coin supply argument is zero
    /// in this test, so the contract should not return any dust.
    public fun transfer_tokens_with_relay_coin_9_no_dust() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            x"0000000000000000000000000000000000000000000000000000000000000069";
        let coin_supply: u64 = 42069000000000; // 42069
        let to_native_token_amount = 1000000000; // 10
        let target_recipient =
            x"000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe";
        let swap_rate: u64 = 690000000; // 6.9 USD
        let max_native_swap_amount: u64 = 100000000000; // 100
        let relayer_fee: u64 = 1000000000; // 10

        // Registration knobs, should be used to test negative cases.
        let should_register_contract: bool = true;
        let should_register_token: bool = true;

        // Mint token 8, fetch the metadata and store the object ID for later.
        let (test_coin, test_metadata) = mint_coin_9(
            coin_supply,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Test transfer with COIN_9.
        test_transfer_tokens_with_relay(
            target_chain,
            target_contract,
            test_coin,
            test_metadata,
            to_native_token_amount,
            target_recipient,
            should_register_contract,
            should_register_token,
            swap_rate,
            max_native_swap_amount,
            relayer_fee,
            creator,
            scenario
        );

        // Confirm that a dust object was not returned to the sender.
        assert!(
            !test_scenario::has_most_recent_for_sender<Coin<COIN_9>>(scenario),
            0
        );

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun transfer_tokens_with_relay_coin_9_maximum_amount() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            x"0000000000000000000000000000000000000000000000000000000000000069";
        let max_coin_supply: u64 = TEST_MAX_U64; // Maximum amount.
        // Since COIN_9 has 9 decimals, the token bridge will truncate the
        // value. This is the expected amount to be returned by the contract.
        let expected_dust: u64 = 4;
        let to_native_token_amount = 1000000000; // 10
        let target_recipient =
            x"000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe";
        let swap_rate: u64 = 690000000; // 6.9 USD
        let max_native_swap_amount: u64 = 100000000000; // 100
        let relayer_fee: u64 = 1000000000; // 10

        // Registration knobs, should be used to test negative cases.
        let should_register_contract: bool = true;
        let should_register_token: bool = true;

        // Mint token 8, fetch the metadata and store the object ID for later.
        let (test_coin, test_metadata) = mint_coin_9(
            max_coin_supply,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Store test coin ID for later use.
        let test_coin_id = object::id(&test_coin);

        // Test transfer with COIN_9.
        test_transfer_tokens_with_relay(
            target_chain,
            target_contract,
            test_coin,
            test_metadata,
            to_native_token_amount,
            target_recipient,
            should_register_contract,
            should_register_token,
            swap_rate,
            max_native_swap_amount,
            relayer_fee,
            creator,
            scenario
        );

        // Confirm that the dust object was returned to the caller.
        let dust_object =
            test_scenario::take_from_sender_by_id<Coin<COIN_9>>(
                scenario,
                test_coin_id
            );

        // Confirm that the value of the token is non-zero.
        assert!(coin::value(&dust_object) == expected_dust, 0);

        // Bye bye.
        test_scenario::return_to_sender(scenario, dust_object);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun transfer_tokens_with_relay_coin_9_minimum_amount() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            x"0000000000000000000000000000000000000000000000000000000000000069";
        let min_coin_supply: u64 = 10; // Minimum amount.
        // Since COIN_9 has 9 decimals, the token bridge will truncate the
        // value. This is the expected amount to be returned by the contract.
        let to_native_token_amount = 0;
        let target_recipient =
            x"000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe";
        let swap_rate: u64 = 690000000; // 6.9 USD
        let max_native_swap_amount: u64 = 100000000000; // 100
        let relayer_fee: u64 = 0;

        // Registration knobs, should be used to test negative cases.
        let should_register_contract: bool = true;
        let should_register_token: bool = true;

        // Mint token 8, fetch the metadata and store the object ID for later.
        let (test_coin, test_metadata) = mint_coin_9(
            min_coin_supply,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Test transfer with COIN_9.
        test_transfer_tokens_with_relay(
            target_chain,
            target_contract,
            test_coin,
            test_metadata,
            to_native_token_amount,
            target_recipient,
            should_register_contract,
            should_register_token,
            swap_rate,
            max_native_swap_amount,
            relayer_fee,
            creator,
            scenario
        );

        // Note: There's no dust for this test.

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = transfer::E_UNREGISTERED_COIN)]
    public fun cannot_transfer_tokens_with_relay_unregistered_token() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            x"0000000000000000000000000000000000000000000000000000000000000069";
        let coin_supply: u64 = 4206900000000; // 42069
        let to_native_token_amount = 500000000; // 5
        let target_recipient =
            x"000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe";
        let swap_rate: u64 = 690000000; // 6.9 USD
        let max_native_swap_amount: u64 = 1000000000; // 10
        let relayer_fee: u64 = 1000000000; // 10

        // Registration knobs, should be used to test negative test cases.
        let should_register_contract: bool = true;
        let should_register_token: bool = false; // set to false for this test

        // Mint token 8, fetch the metadata and store the object ID for later.
        let (test_coin, test_metadata) = mint_coin_8(
            coin_supply,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Test transfer with COIN_8.
        test_transfer_tokens_with_relay(
            target_chain,
            target_contract,
            test_coin,
            test_metadata,
            to_native_token_amount,
            target_recipient,
            should_register_contract,
            should_register_token,
            swap_rate,
            max_native_swap_amount,
            relayer_fee,
            creator,
            scenario
        );

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = transfer::E_INVALID_TARGET_RECIPIENT)]
    public fun cannot_transfer_tokens_with_relay_invalid_recipient() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            x"0000000000000000000000000000000000000000000000000000000000000069";
        let coin_supply: u64 = 4206900000000; // 42069
        let to_native_token_amount = 500000000; // 5
        // Set to zero address for this test.
        let target_recipient =
            x"0000000000000000000000000000000000000000000000000000000000000000";
        let swap_rate: u64 = 690000000; // 6.9 USD
        let max_native_swap_amount: u64 = 1000000000; // 10
        let relayer_fee: u64 = 1000000000; // 10

        // Registration knobs, should be used to test negative test cases.
        let should_register_contract: bool = true;
        let should_register_token: bool = true;

        // Mint token 8, fetch the metadata and store the object ID for later.
        let (test_coin, test_metadata) = mint_coin_8(
            coin_supply,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Test transfer with COIN_8.
        test_transfer_tokens_with_relay(
            target_chain,
            target_contract,
            test_coin,
            test_metadata,
            to_native_token_amount,
            target_recipient,
            should_register_contract,
            should_register_token,
            swap_rate,
            max_native_swap_amount,
            relayer_fee,
            creator,
            scenario
        );

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = transfer::E_UNREGISTERED_FOREIGN_CONTRACT)]
    public fun cannot_transfer_tokens_with_relay_unregistered_contract() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            x"0000000000000000000000000000000000000000000000000000000000000069";
        let coin_supply: u64 = 4206900000000; // 42069
        let to_native_token_amount = 500000000; // 5
        let target_recipient =
            x"000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe";
        let swap_rate: u64 = 690000000; // 6.9 USD
        let max_native_swap_amount: u64 = 1000000000; // 10
        let relayer_fee: u64 = 1000000000; // 10

        // Registration knobs, should be used to test negative test cases.
        let should_register_contract: bool = false; // set to false for this test
        let should_register_token: bool = true;

        // Mint token 8, fetch the metadata and store the object ID for later.
        let (test_coin, test_metadata) = mint_coin_8(
            coin_supply,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Test transfer with COIN_8.
        test_transfer_tokens_with_relay(
            target_chain,
            target_contract,
            test_coin,
            test_metadata,
            to_native_token_amount,
            target_recipient,
            should_register_contract,
            should_register_token,
            swap_rate,
            max_native_swap_amount,
            relayer_fee,
            creator,
            scenario
        );

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = transfer::E_INSUFFICIENT_TO_NATIVE_AMOUNT)]
    /// This test confirms that the contract correctly reverts when the
    /// specified to native token amount is too small and is normalized
    /// to zero. This test uses coin 9 since it has 9 decimals.
    public fun cannot_transfer_tokens_with_relay_insufficient_normalized_to_native_amount() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            x"0000000000000000000000000000000000000000000000000000000000000069";
        let coin_supply: u64 = 4206900000000; // 42069
        // Set the to native amount to something that will be converted to
        // zero when normalized by the contract.
        let to_native_token_amount = 9;
        let target_recipient =
            x"000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe";
        let swap_rate: u64 = 690000000; // 6.9 USD
        let max_native_swap_amount: u64 = 1000000000; // 10
        let relayer_fee: u64 = 0; // 10

        // Registration knobs, should be used to test negative test cases.
        let should_register_contract: bool = true;
        let should_register_token: bool = true;

        // Mint token 8, fetch the metadata and store the object ID for later.
        let (test_coin, test_metadata) = mint_coin_9(
            coin_supply,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Test transfer with COIN_9.
        test_transfer_tokens_with_relay(
            target_chain,
            target_contract,
            test_coin,
            test_metadata,
            to_native_token_amount,
            target_recipient,
            should_register_contract,
            should_register_token,
            swap_rate,
            max_native_swap_amount,
            relayer_fee,
            creator,
            scenario
        );

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = transfer::E_INSUFFICIENT_AMOUNT)]
    public fun cannot_transfer_tokens_with_relay_zero_amount() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            x"0000000000000000000000000000000000000000000000000000000000000069";
        // Explicitly set amount to zero.
        let coin_supply: u64 = 0;
        let to_native_token_amount = 0;
        let target_recipient =
            x"000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe";
        let swap_rate: u64 = 690000000; // 6.9 USD
        let max_native_swap_amount: u64 = 1000000000; // 10
        let relayer_fee: u64 = 0;

        // Registration knobs, should be used to test negative test cases.
        let should_register_contract: bool = true;
        let should_register_token: bool = true;

        // Mint token 8, fetch the metadata and store the object ID for later.
        let (test_coin, test_metadata) = mint_coin_9(
            coin_supply,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Test transfer with COIN_8.
        test_transfer_tokens_with_relay(
            target_chain,
            target_contract,
            test_coin,
            test_metadata,
            to_native_token_amount,
            target_recipient,
            should_register_contract,
            should_register_token,
            swap_rate,
            max_native_swap_amount,
            relayer_fee,
            creator,
            scenario
        );

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = transfer::E_INSUFFICIENT_AMOUNT)]
    public fun cannot_transfer_tokens_with_relay_insufficient_amount() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            x"0000000000000000000000000000000000000000000000000000000000000069";

        // Amount params. Set these values so that the coin_supply value is
        // less than the to_native_token_amount + relayer_fee.
        let coin_supply: u64 = 42069;
        let to_native_token_amount = 42000;
        let relayer_fee: u64 = 69;

        // Other.
        let target_recipient =
            x"000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe";
        let swap_rate: u64 = 690000000; // 6.9 USD
        let max_native_swap_amount: u64 = 1000000000; // 10

        // Registration knobs, should be used to test negative test cases.
        let should_register_contract: bool = true;
        let should_register_token: bool = true;

        // Mint token 8, fetch the metadata and store the object ID for later.
        let (test_coin, test_metadata) = mint_coin_8(
            coin_supply,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Test transfer with COIN_8.
        test_transfer_tokens_with_relay(
            target_chain,
            target_contract,
            test_coin,
            test_metadata,
            to_native_token_amount,
            target_recipient,
            should_register_contract,
            should_register_token,
            swap_rate,
            max_native_swap_amount,
            relayer_fee,
            creator,
            scenario
        );

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = relayer_fees::E_RELAYER_FEE_OVERFLOW)]
    public fun cannot_transfer_tokens_with_relay_relayer_fee_overflow() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            x"0000000000000000000000000000000000000000000000000000000000000069";

        // Transfer params.
        let coin_supply: u64 = 42069;
        let to_native_token_amount = 42000;

        // Set the relayer fee to the u64 max.
        let relayer_fee: u64 = TEST_MAX_U64;

        // Other.
        let target_recipient =
            x"000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe";

        // Set the swap rate to the minimum to help cause the overflow.
        let swap_rate: u64 = 1; // 6.9 USD
        let max_native_swap_amount: u64 = 1000000000; // 10

        // Registration knobs, should be used to test negative test cases.
        let should_register_contract: bool = true;
        let should_register_token: bool = true;

        // Mint token 8, fetch the metadata and store the object ID for later.
        let (test_coin, test_metadata) = mint_coin_8(
            coin_supply,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Test transfer with COIN_8.
        test_transfer_tokens_with_relay(
            target_chain,
            target_contract,
            test_coin,
            test_metadata,
            to_native_token_amount,
            target_recipient,
            should_register_contract,
            should_register_token,
            swap_rate,
            max_native_swap_amount,
            relayer_fee,
            creator,
            scenario
        );

        // Done.
        test_scenario::end(my_scenario);
    }

    /// Utilities.

    public fun mint_coin_8(
        amount: u64,
        ctx: &mut TxContext
    ): (Coin<COIN_8>, CoinMetadata<COIN_8>) {
        // Initialize token 8.
        let (treasury_cap, metadata) = coin_8::create_coin_test_only(ctx);

        // Mint tokens.
        let test_coin = coin::mint(
            &mut treasury_cap,
            amount,
            ctx
        );

        // Balance check the new coin object.
        assert!(coin::value(&test_coin) == amount, 0);

        // Bye bye.
        native_transfer::transfer(treasury_cap, @0x0);

        // Return.
        (test_coin, metadata)
    }

    public fun mint_coin_9(
        amount: u64,
        ctx: &mut TxContext
    ): (Coin<COIN_9>, CoinMetadata<COIN_9>) {
        // Initialize token 8.
        let (treasury_cap, metadata) = coin_9::create_coin_test_only(ctx);

        // Mint tokens.
        let test_coin = coin::mint(
            &mut treasury_cap,
            amount,
            ctx
        );

        // Balance check the new coin object.
        assert!(coin::value(&test_coin) == amount, 0);

        // Bye bye.
        native_transfer::transfer(treasury_cap, @0x0);

        // Return.
        (test_coin, metadata)
    }

    public fun mint_sui(amount: u64, ctx: &mut TxContext): Coin<SUI> {
        // Mint SUI tokens.
        let sui_coin = sui::coin::mint_for_testing<SUI>(
            amount,
            ctx
        );
        assert!(coin::value(&sui_coin) == amount, 0);

        sui_coin
    }

    public fun test_transfer_tokens_with_relay<C>(
        target_chain: u16,
        target_contract: vector<u8>,
        coins: Coin<C>,
        coin_metadata: CoinMetadata<C>,
        to_native_token_amount: u64,
        target_recipient_address: vector<u8>,
        should_register_contract: bool,
        should_register_token: bool,
        swap_rate: u64,
        max_swap_amount: u64,
        relayer_fee: u64,
        creator: address,
        scenario: &mut Scenario
    ): TransactionEffects {
        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);
        let owner_cap =
            test_scenario::take_from_sender<OwnerCap>(scenario);

        // Mint SUI token amount based on the wormhole fee.
        let sui_coin = mint_sui(
            wormhole_state_module::get_message_fee(&wormhole_state),
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Register the target contract and set the relayer fee.
        if (should_register_contract) {
            owner::register_foreign_contract(
                &owner_cap,
                &mut token_bridge_relayer_state,
                target_chain,
                target_contract
            );

            // Proceed.
            test_scenario::next_tx(scenario, creator);

            // Set the relayer fee.
            owner::update_relayer_fee(
                &owner_cap,
                &mut token_bridge_relayer_state,
                target_chain,
                relayer_fee
            );

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Attest the token on the token bridge, and register it with
        // the token bridge relayer.
        {
            // Perform the attestation.
            let fee_coin = mint_sui(
                wormhole_state_module::get_message_fee(&wormhole_state),
                test_scenario::ctx(scenario)
            );

            attest_token::attest_token<C>(
                &mut bridge_state,
                &mut wormhole_state,
                &coin_metadata,
                fee_coin,
                0, // batch ID
                test_scenario::ctx(scenario)
            );

            // Proceed.
            test_scenario::next_tx(scenario, creator);

            // Register the token.
            if (should_register_token) {
                owner::register_token<C>(
                    &owner_cap,
                    &mut token_bridge_relayer_state,
                    swap_rate,
                    max_swap_amount
                );

                // Proceed.
                test_scenario::next_tx(scenario, creator);
            };

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Send a test transfer.
        transfer::transfer_tokens_with_relay<C>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            coins,
            to_native_token_amount,
            sui_coin,
            target_chain,
            0, // nonce
            target_recipient_address,
            test_scenario::ctx(scenario)
        );

        // Return the goods.
        test_scenario::return_shared<State>(token_bridge_relayer_state);
        test_scenario::return_shared<BridgeState>(bridge_state);
        test_scenario::return_shared<WormholeState>(wormhole_state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);
        native_transfer::transfer(coin_metadata, @0x0);

        let effects = test_scenario::next_tx(scenario, creator);
        (effects)
    }
}
