/// This module composes on Wormhole's Token Bridge contract to faciliate
/// one-click transfers of Token Bridge supported assets to registered
/// (foreign) Token Bridge Relayer contracts.
module token_bridge_relayer::transfer {
    // Sui dependencies.
    use sui::sui::SUI;
    use sui::clock::{Clock};
    use sui::coin::{Self, Coin};
    use sui::tx_context::{TxContext};

    // Token Bridge dependencies.
    use token_bridge::normalized_amount::{Self};
    use token_bridge::coin_utils::{Self};
    use token_bridge::state::{Self as bridge_state, State as TokenBridgeState};
    use token_bridge::transfer_tokens_with_payload::{transfer_tokens_with_payload};

    // Wormhole dependencies.
    use wormhole::external_address::{Self};
    use wormhole::state::{State as WormholeState};

    // Token Bridge Relayer modules.
    use token_bridge_relayer::message::{Self};
    use token_bridge_relayer::state::{Self as relayer_state, State};

    /// Errors.
    const E_INVALID_TARGET_RECIPIENT: u64 = 0;
    const E_UNREGISTERED_FOREIGN_CONTRACT: u64 = 1;
    const E_INSUFFICIENT_AMOUNT: u64 = 2;
    const E_UNREGISTERED_COIN: u64 = 3;
    const E_INSUFFICIENT_TO_NATIVE_AMOUNT: u64 = 4;

    /// `transfer_tokens_with_relay` calls Wormhole's Token Bridge contract
    /// to emit a contract-controlled transfer. The transfer message includes
    /// an arbitrary payload with instructions for how to handle relayer
    /// payments on the target contract. Optionally, the payload will include
    /// a quantity of tokens to swap into native assets on the target chain.
    public entry fun transfer_tokens_with_relay<C>(
        t_state: &State,
        wormhole_state: &mut WormholeState,
        token_bridge_state: &mut TokenBridgeState,
        coins: Coin<C>,
        to_native_token_amount: u64,
        wormhole_fee: Coin<SUI>,
        target_chain: u16,
        nonce: u32,
        target_recipient: address,
        the_clock: &Clock,
        ctx: &TxContext
    ): u64 {
        // Confirm that the coin type is registered with this contract.
        assert!(
            relayer_state::is_registered_token<C>(t_state),
            E_UNREGISTERED_COIN
        );

        // Cache the `target_recipient` ExternalAddress and verify that the
        // `target_recipient` is not the zero address.
        let target_recipient_address = external_address::from_address(
            target_recipient
        );
        assert!(
            external_address::is_nonzero(&target_recipient_address),
            E_INVALID_TARGET_RECIPIENT
        );

        // Confirm that the `target_chain` has a registered contract.
        assert!(
            relayer_state::contract_registered(t_state, target_chain),
            E_UNREGISTERED_FOREIGN_CONTRACT
        );

        // Fetch the token decimals from the token bridge, and cache the token
        // amount.
        let decimals = bridge_state::coin_decimals<C>(token_bridge_state);
        let amount_received = coin::value(&coins);

        // Compute the normalized `to_native_token_amount`.
        let normalized_to_native_amount = normalized_amount::from_raw(
            to_native_token_amount,
            decimals
        );
        assert!(
            to_native_token_amount == 0 ||
            normalized_amount::value(&normalized_to_native_amount) > 0,
            E_INSUFFICIENT_TO_NATIVE_AMOUNT
        );

        // Compute the normalized `relayer_fee`.
        let normalized_relayer_fee = normalized_amount::from_raw(
                relayer_state::token_relayer_fee<C>(
                    t_state,
                    target_chain,
                    decimals
                ),
                decimals
            );

        // Compute the noramlized token amount and confirm that the user
        // sent enough tokens to cover the `relayer_fee` and the
        // `to_native_token_amount`.
        let normalized_amount = normalized_amount::from_raw(
            amount_received,
            decimals
        );
        assert!(
            normalized_amount::value(&normalized_amount) >
                normalized_amount::value(&normalized_relayer_fee) +
                normalized_amount::value(&normalized_to_native_amount),
            E_INSUFFICIENT_AMOUNT
        );

        // Create the `TransferWithRelay` message.
        let msg = message::serialize(
            message::new(
                normalized_relayer_fee,
                normalized_to_native_amount,
                target_recipient_address
            )
        );

        // Finally, call the Token Bridge.
        let (sequence, dust) = transfer_tokens_with_payload<C>(
            token_bridge_state,
            relayer_state::emitter_cap(t_state),
            wormhole_state,
            coins,
            wormhole_fee,
            target_chain,
            relayer_state::foreign_contract_address(t_state, target_chain),
            msg,
            nonce,
            the_clock
        );

        // Return to sender.
        coin_utils::return_nonzero(dust, ctx);

        sequence
    }
}

#[test_only]
module token_bridge_relayer::transfer_tests {
    use sui::sui::SUI;
    use sui::test_scenario::{Self, Scenario, TransactionEffects};
    use sui::coin::{Self, Coin, CoinMetadata};
    use sui::object::{Self};
    use sui::transfer::{Self as native_transfer};
    use sui::tx_context::{TxContext};

    // Token Bridge Relayer.
    use token_bridge_relayer::owner::{Self, OwnerCap};
    use token_bridge_relayer::transfer::{Self};
    use token_bridge_relayer::state::{State};
    use token_bridge_relayer::init_tests::{set_up, people};
    use token_bridge_relayer::relayer_fees::{Self};

    // Wormhole.
    use wormhole::state::{
        Self as wormhole_state_module,
        State as WormholeState
    };

    // Token Bridge.
    use token_bridge::state::{State as BridgeState};
    use token_bridge::attest_token::{Self};
    use token_bridge::token_bridge_scenario::{Self};

    // Example coins.
    use example_coins::coin_8::{Self, COIN_8};
    use example_coins::coin_10::{Self, COIN_10};

    // Test consts.
    const MAX_SUPPLY: u64 = 0xfffffffffffffffe;

    #[test]
    // This test transfers COIN_8 with relay parameters.
    public fun transfer_tokens_with_relay_coin_8() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract: address =
            @0x0000000000000000000000000000000000000000000000000000000000000069;
        let coin_supply: u64 = 4206900000000; // 42069
        let to_native_token_amount = 500000000; // 5
        let target_recipient: address =
            @0x000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe;
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
    /// This test transfers COIN_8 for the maximum amount allowed (max(uint64)).
    public fun transfer_tokens_with_relay_coin_8_maximum_amount() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            @0x0000000000000000000000000000000000000000000000000000000000000069;
        let max_coin_supply: u64 = MAX_SUPPLY; // Maximum amount able to mint.
        let to_native_token_amount = 500000000; // 5
        let target_recipient =
            @0x000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe;
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
    /// This test transfers COIN_8 for the minimum amount allowed (1 unit).
    public fun transfer_tokens_with_relay_coin_8_minimum_amount() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            @0x0000000000000000000000000000000000000000000000000000000000000069;
        let min_coin_supply: u64 = 1; // Minimum amount.
        let to_native_token_amount = 0; // 5
        let target_recipient =
            @0x000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe;
        let swap_rate: u64 = 690000000; // 6.9 USD
        let max_native_swap_amount: u64 = 1000000000; // 10
        let relayer_fee: u64 = 0; // 10

        // Registration knobs, should be used to test negative test cases.
        let should_register_contract: bool = true;
        let should_register_token: bool = true;

        // Mint token 10, fetch the metadata and store the object ID for later.
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
    /// This test transfers COIN_10 with relay parameters. The last digit in
    /// the `coin_supply` argument is nonzero, so the contract will return
    /// `dust` to the caller.
    public fun transfer_tokens_with_relay_coin_10() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            @0x0000000000000000000000000000000000000000000000000000000000000069;
        let coin_supply: u64 = 42069000000019; // 42069.000000000009

        // Since COIN_10 has 10 decimals, the token bridge will truncate the
        // value. This is the expected amount to be returned by the contract.
        let expected_dust: u64 = 19;
        let to_native_token_amount = 1000000000; // 10
        let target_recipient =
            @0x000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe;
        let swap_rate: u64 = 690000000; // 6.9 USD
        let max_native_swap_amount: u64 = 100000000000; // 100
        let relayer_fee: u64 = 1000000000; // 10

        // Registration knobs, should be used to test negative cases.
        let should_register_contract: bool = true;
        let should_register_token: bool = true;

        // Mint token 10, fetch the metadata and store the object ID for later.
        let (test_coin, test_metadata) = mint_coin_10(
            coin_supply,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Store test coin ID for later use.
        let test_coin_id = object::id(&test_coin);

        // Test transfer with COIN_10.
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
            test_scenario::take_from_sender_by_id<Coin<COIN_10>>(
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
    /// This test transfers COIN_10 with relayer parameters. The last digit
    /// in the `coin_supply` argument is zero in this test, so the contract
    /// should not return any dust.
    public fun transfer_tokens_with_relay_coin_10_no_dust() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            @0x0000000000000000000000000000000000000000000000000000000000000069;
        let coin_supply: u64 = 42069000000000; // 42069
        let to_native_token_amount = 1000000000; // 10
        let target_recipient =
            @0x000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe;
        let swap_rate: u64 = 690000000; // 6.9 USD
        let max_native_swap_amount: u64 = 100000000000; // 100
        let relayer_fee: u64 = 1000000000; // 10

        // Registration knobs, should be used to test negative cases.
        let should_register_contract: bool = true;
        let should_register_token: bool = true;

        // Mint token 10, fetch the metadata and store the object ID for later.
        let (test_coin, test_metadata) = mint_coin_10(
            coin_supply,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Test transfer with COIN_10.
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
            !test_scenario::has_most_recent_for_sender<Coin<COIN_10>>(scenario),
            0
        );

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    /// This test transfers COIN_10 for the maximum amount (max(uint64)).
    /// The last digit in the `coin_supply` argument is nonzero, so the
    /// contract will return `dust` to the caller.
    public fun transfer_tokens_with_relay_coin_10_maximum_amount() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            @0x0000000000000000000000000000000000000000000000000000000000000069;
        let max_coin_supply: u64 = MAX_SUPPLY; // Maximum amount able to mint.

        // Since COIN_10 has 10 decimals, the token bridge will truncate the
        // value. This is the expected amount to be returned by the contract.
        let expected_dust: u64 = 14;
        let to_native_token_amount = 1000000000; // 10
        let target_recipient =
            @0x000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe;
        let swap_rate: u64 = 690000000; // 6.9 USD
        let max_native_swap_amount: u64 = 100000000000; // 100
        let relayer_fee: u64 = 1000000000; // 10

        // Registration knobs, should be used to test negative cases.
        let should_register_contract: bool = true;
        let should_register_token: bool = true;

        // Mint token 10, fetch the metadata and store the object ID for later.
        let (test_coin, test_metadata) = mint_coin_10(
            max_coin_supply,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Store test coin ID for later use.
        let test_coin_id = object::id(&test_coin);

        // Test transfer with COIN_10.
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
            test_scenario::take_from_sender_by_id<Coin<COIN_10>>(
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
    /// This test transfers COIN_10 for the minimum amount (100 units).
    /// The last digit in the `coin_supply` argument is zero, so the
    /// contract will not return any `dust` to the caller.
    public fun transfer_tokens_with_relay_coin_10_minimum_amount() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            @0x0000000000000000000000000000000000000000000000000000000000000069;

        // The minimum amount for COIN_10 transfers is 100, because the Token
        // Bridge will truncate the amount by two decimal places.
        let min_coin_supply: u64 = 100;

        // Since COIN_10 has 10 decimals, the token bridge will truncate the
        // value. This is the expected amount to be returned by the contract.
        let to_native_token_amount = 0;
        let target_recipient =
            @0x000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe;
        let swap_rate: u64 = 690000000; // 6.9 USD
        let max_native_swap_amount: u64 = 100000000000; // 100
        let relayer_fee: u64 = 0;

        // Registration knobs, should be used to test negative cases.
        let should_register_contract: bool = true;
        let should_register_token: bool = true;

        // Mint token 10, fetch the metadata and store the object ID for later.
        let (test_coin, test_metadata) = mint_coin_10(
            min_coin_supply,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Test transfer with COIN_10.
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
    /// This test attempts to transfer a token that has not been registered
    /// on the Token Bridge Relayer contract.
    public fun cannot_transfer_tokens_with_relay_unregistered_token() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            @0x0000000000000000000000000000000000000000000000000000000000000069;
        let coin_supply: u64 = 4206900000000; // 42069
        let to_native_token_amount = 500000000; // 5
        let target_recipient =
            @0x000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe;
        let swap_rate: u64 = 690000000; // 6.9 USD
        let max_native_swap_amount: u64 = 1000000000; // 10
        let relayer_fee: u64 = 1000000000; // 10

        // Registration knobs, should be used to test negative test cases.
        let should_register_contract: bool = true;
        let should_register_token: bool = false; // Set to false for this test.

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
    /// This test attempts to transfer a token to an invalid target wallet.
    /// The zero address is purposely passed to the contract.
    public fun cannot_transfer_tokens_with_relay_invalid_recipient() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            @0x0000000000000000000000000000000000000000000000000000000000000069;
        let coin_supply: u64 = 4206900000000; // 42069
        let to_native_token_amount = 500000000; // 5
        // Set to zero address for this test.
        let target_recipient =
            @0x0000000000000000000000000000000000000000000000000000000000000000;
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
    /// This test attempts to transfer a token to an unregistered (foreign)
    /// Token Bridge Relayer contract.
    public fun cannot_transfer_tokens_with_relay_unregistered_contract() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            @0x0000000000000000000000000000000000000000000000000000000000000069;
        let coin_supply: u64 = 4206900000000; // 42069
        let to_native_token_amount = 500000000; // 5
        let target_recipient =
            @0x000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe;
        let swap_rate: u64 = 690000000; // 6.9 USD
        let max_native_swap_amount: u64 = 1000000000; // 10
        let relayer_fee: u64 = 1000000000; // 10

        // Registration knobs, should be used to test negative test cases.
        let should_register_contract: bool = false; // Set to false for this test.
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
    /// specified `to_native_token_amount` is too small and is normalized
    /// to zero. This test uses coin 10 since it has 10 decimals.
    public fun cannot_transfer_tokens_with_relay_insufficient_normalized_to_native_amount() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            @0x0000000000000000000000000000000000000000000000000000000000000069;
        let coin_supply: u64 = 4206900000000; // 42069

        // Set the `to_native_token_amount` to something that will be converted
        // to zero when normalized by the contract.
        let to_native_token_amount = 9;
        let target_recipient =
            @0x000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe;
        let swap_rate: u64 = 690000000; // 6.9 USD
        let max_native_swap_amount: u64 = 1000000000; // 10
        let relayer_fee: u64 = 0; // 10

        // Registration knobs, should be used to test negative test cases.
        let should_register_contract: bool = true;
        let should_register_token: bool = true;

        // Mint token 10, fetch the metadata and store the object ID for later.
        let (test_coin, test_metadata) = mint_coin_10(
            coin_supply,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Test transfer with COIN_10.
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
    /// This test confirms that the contract correctly reverts when the
    /// specified transfer amount is zero.
    public fun cannot_transfer_tokens_with_relay_zero_amount() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            @0x0000000000000000000000000000000000000000000000000000000000000069;

        // Explicitly set amount to zero.
        let coin_supply: u64 = 0;
        let to_native_token_amount = 0;
        let target_recipient =
            @0x000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe;
        let swap_rate: u64 = 690000000; // 6.9 USD
        let max_native_swap_amount: u64 = 1000000000; // 10
        let relayer_fee: u64 = 0;

        // Registration knobs, should be used to test negative test cases.
        let should_register_contract: bool = true;
        let should_register_token: bool = true;

        // Mint token 10, fetch the metadata and store the object ID for later.
        let (test_coin, test_metadata) = mint_coin_10(
            coin_supply,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Test transfer with COIN_10.
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
    /// This test confirms that the contract correctly reverts when the
    /// specified transfer amount is not large enough to cover the
    /// sum of the `target_relayer_fee` and `to_native_token_amount`.
    public fun cannot_transfer_tokens_with_relay_coin_8_insufficient_amount() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            @0x0000000000000000000000000000000000000000000000000000000000000069;

        // Amount params. Set these values so that the coin_supply value is
        // less than the to_native_token_amount + relayer_fee.
        let coin_supply: u64 = 42069;
        let to_native_token_amount = 42000;
        let relayer_fee: u64 = 690;

        // Other.
        let target_recipient =
            @0x000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe;
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
    #[expected_failure(abort_code = transfer::E_INSUFFICIENT_AMOUNT)]
    /// This test confirms that the contract correctly reverts when the
    /// specified transfer amount is not large enough to cover the
    /// sum of the `target_relayer_fee` and `to_native_token_amount`.
    public fun cannot_transfer_tokens_with_relay_coin_10_insufficient_amount() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            @0x0000000000000000000000000000000000000000000000000000000000000069;

        // Amount params. Set these values so that the coin_supply value is
        // less than the to_native_token_amount + relayer_fee.
        let coin_supply: u64 = 4206900;
        let to_native_token_amount = 4200000;
        let relayer_fee: u64 = 6900;

        // Other.
        let target_recipient =
            @0x000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe;
        let swap_rate: u64 = 690000000; // 6.9 USD
        let max_native_swap_amount: u64 = 1000000000; // 10

        // Registration knobs, should be used to test negative test cases.
        let should_register_contract: bool = true;
        let should_register_token: bool = true;

        // Mint token 10, fetch the metadata and store the object ID for later.
        let (test_coin, test_metadata) = mint_coin_10(
            coin_supply,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Test transfer with COIN_10.
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
    /// This test confirms that the contract reverts with a detailed error
    /// when the target relayer fee calculation overflows.
    public fun cannot_transfer_tokens_with_relay_relayer_fee_overflow() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Define test variables.
        let target_chain: u16 = 69;
        let target_contract =
            @0x0000000000000000000000000000000000000000000000000000000000000069;

        // Transfer params.
        let coin_supply: u64 = 42069;
        let to_native_token_amount = 42000;

        // Set the relayer fee to the u64 max.
        let relayer_fee: u64 = MAX_SUPPLY;

        // Other.
        let target_recipient =
            @0x000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe;

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
        native_transfer::public_transfer(treasury_cap, @0x0);

        // Return.
        (test_coin, metadata)
    }

    public fun mint_coin_10(
        amount: u64,
        ctx: &mut TxContext
    ): (Coin<COIN_10>, CoinMetadata<COIN_10>) {
        // Initialize token 8.
        let (treasury_cap, metadata) = coin_10::create_coin_test_only(ctx);

        // Mint tokens.
        let test_coin = coin::mint(
            &mut treasury_cap,
            amount,
            ctx
        );

        // Balance check the new coin object.
        assert!(coin::value(&test_coin) == amount, 0);

        // Bye bye.
        native_transfer::public_transfer(treasury_cap, @0x0);

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
        target_contract: address,
        coins: Coin<C>,
        coin_metadata: CoinMetadata<C>,
        to_native_token_amount: u64,
        target_recipient: address,
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
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Mint SUI coins to pay the Wormhole fee.
        let sui_coin = mint_sui(
            wormhole_state_module::message_fee(&wormhole_state),
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
                wormhole_state_module::message_fee(&wormhole_state),
                test_scenario::ctx(scenario)
            );

            attest_token::attest_token<C>(
                &mut bridge_state,
                &mut wormhole_state,
                fee_coin,
                &coin_metadata,
                0, // Nonce.
                &the_clock
            );

            // Proceed.
            test_scenario::next_tx(scenario, creator);

            // Register the token.
            if (should_register_token) {
                owner::register_token<C>(
                    &owner_cap,
                    &mut token_bridge_relayer_state,
                    swap_rate,
                    max_swap_amount,
                    true // Enable swap.
                );

                // Proceed.
                test_scenario::next_tx(scenario, creator);
            };

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Send a test transfer.
        transfer::transfer_tokens_with_relay(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            coins,
            to_native_token_amount,
            sui_coin,
            target_chain,
            0, // nonce
            target_recipient,
            &the_clock,
            test_scenario::ctx(scenario)
        );

        // Return the goods.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);
        test_scenario::return_to_sender(scenario, owner_cap);
        native_transfer::public_transfer(coin_metadata, @0x0);
        token_bridge_scenario::return_clock(the_clock);

        let effects = test_scenario::next_tx(scenario, creator);
        (effects)
    }
}
