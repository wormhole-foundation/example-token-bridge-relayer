module token_bridge_relayer::redeem {
    use sui::sui::SUI;
    use sui::coin::{Self, Coin};
    use sui::math::{Self};
    use sui::transfer::{Self};
    use sui::tx_context::{Self, TxContext};

    use token_bridge::state::{Self as bridge_state, State as TokenBridgeState};
    use token_bridge::complete_transfer_with_payload::{
        complete_transfer_with_payload
    };
    use token_bridge::transfer_with_payload::{Self, TransferWithPayload};
    use token_bridge::normalized_amount::{Self};

    use wormhole::external_address::{Self};
    use wormhole::state::{State as WormholeState};

    use token_bridge_relayer::message::{Self};
    use token_bridge_relayer::state::{Self as relayer_state, State};

    // Errors.
    const E_UNREGISTERED_FOREIGN_CONTRACT: u64 = 0;
    const E_UNREGISTERED_COIN: u64 = 1;
    const E_INVALID_CALLER_FOR_ACTION: u64 = 2;
    const E_INSUFFICIENT_NATIVE_COIN: u64 = 3;
    const E_SWAP_IN_OVERFLOW: u64 = 4;
    const E_SWAP_OUT_OVERFLOW: u64 = 5;

    // Max U64 const.
    const U64_MAX: u64 = 18446744073709551614;

    public entry fun complete_transfer<C>(
        t_state: &State,
        wormhole_state: &mut WormholeState,
        token_bridge_state: &mut TokenBridgeState,
        vaa: vector<u8>,
        ctx: &mut TxContext
    ) {
        // Complete the transfer on the Token Bridge. This call returns the
        // coin object for the amount transferred via the Token Bridge. It
        // also returns the chain ID of the message sender.
        let (coins, transfer_payload, emitter_chain_id) =
            complete_transfer_with_payload<C>(
                token_bridge_state,
                relayer_state::emitter_cap(t_state),
                wormhole_state,
                vaa,
                ctx
            );

        // Verify that the token is accepted by this contract and that
        // the sender of the Wormhole message is a trusted contract.
        let (is_valid, reason) = verify_transfer<C>(
            t_state,
            emitter_chain_id,
            &transfer_payload
        );
        assert!(is_valid, reason);

        // Parse the TransferWithRelay message.
        let relay_msg = message::deserialize(
            transfer_with_payload::payload(&transfer_payload)
        );

        // Fetch the recipient address and verify that the caller is the
        // recipient.
        let recipient = external_address::to_address(
            &message::recipient(&relay_msg)
        );
        assert!(
            recipient == tx_context::sender(ctx),
            E_INVALID_CALLER_FOR_ACTION
        );

        // Handle self redemptions.
        transfer::transfer(coins, recipient);
    }

    public entry fun complete_transfer_with_relay<C>(
        t_state: &State,
        wormhole_state: &mut WormholeState,
        token_bridge_state: &mut TokenBridgeState,
        vaa: vector<u8>,
        native_coins: Coin<SUI>,
        ctx: &mut TxContext
     ) {
        // Complete the transfer on the Token Bridge. This call returns the
        // coin object for the amount transferred via the Token Bridge. It
        // also returns the chain ID of the message sender.
        let (coins, transfer_payload, emitter_chain_id) =
            complete_transfer_with_payload<C>(
                token_bridge_state,
                relayer_state::emitter_cap(t_state),
                wormhole_state,
                vaa,
                ctx
            );

        // Verify that the token is accepted by this contract and that
        // the sender of the Wormhole message is a trusted contract.
        let (is_valid, reason) = verify_transfer<C>(
            t_state,
            emitter_chain_id,
            &transfer_payload
        );
        assert!(is_valid, reason);

        // Parse the TransferWithRelay message.
        let relay_msg = message::deserialize(
            transfer_with_payload::payload(&transfer_payload)
        );

        // Parse the recipient from the transfer with relay message and
        // verify that the caller is not the recipient.
        let recipient = external_address::to_address(
            &message::recipient(&relay_msg)
        );
        assert!(recipient != tx_context::sender(ctx), E_INVALID_CALLER_FOR_ACTION);

        // Fetch token decimals and denormalize the encoded message values.
        let decimals = bridge_state::coin_decimals<C>(token_bridge_state);
        let denormalized_relayer_fee = normalized_amount::to_raw(
            message::target_relayer_fee(&relay_msg),
            decimals
        );
        let denormalized_to_native_token_amount = normalized_amount::to_raw(
            message::to_native_token_amount(&relay_msg),
            decimals
        );

        // Handle transfers when swaps are disabled for a token or
        // when the user elects not to swap tokens.
        if (
            !relayer_state::is_swap_enabled<C>(t_state) ||
            denormalized_to_native_token_amount == 0
        ) {
            handle_transfer_without_swap(
                denormalized_relayer_fee,
                coins,
                native_coins,
                recipient,
                ctx
            );

            // Bail out.
            return
        };

        // If this code executes, we know that swaps are enabled, the user
        // has elected to perform a swap and that a relyaer is redeeming
        // the transaction. Handle the transfer.
        handle_transfer_and_swap<C>(
            t_state,
            denormalized_relayer_fee,
            denormalized_to_native_token_amount,
            coins,
            decimals,
            native_coins,
            recipient,
            ctx
        );
    }

    fun verify_transfer<C>(
        t_state: &State,
        emitter_chain_id: u16,
        transfer_payload: &TransferWithPayload,
    ): (bool, u64) {
        // Check that the coin is registered with this contract.
        if (!relayer_state::is_registered_token<C>(t_state)) {
            return (false, E_UNREGISTERED_COIN)
        };

        // Check that the emitter is a registered contract.
        if(
            *relayer_state::foreign_contract_address(
                t_state,
                emitter_chain_id
            ) != transfer_with_payload::sender(transfer_payload)
        ) {
            return (false, E_UNREGISTERED_FOREIGN_CONTRACT)
        };

        (true, 0)
    }

    fun handle_transfer_without_swap<C>(
        relayer_fee: u64,
        coins: Coin<C>,
        native_coins: Coin<SUI>,
        recipient: address,
        ctx: &mut TxContext
    ) {
        if (relayer_fee > 0) {
            let coins_for_relayer = coin::split(
                &mut coins,
                relayer_fee,
                ctx
            );

            // Send the caller the relayer fee.
            transfer::transfer(coins_for_relayer, tx_context::sender(ctx));
        };

        // Send the original coin object to the recipient.
        transfer::transfer(coins, recipient);

        // Return any native coins to the relayer.
        if (coin::value(&native_coins) > 0) {
            transfer::transfer(native_coins, tx_context::sender(ctx));
        } else {
            coin::destroy_zero<SUI>(native_coins);
        }
    }

    fun handle_transfer_and_swap<C>(
        t_state: &State,
        relayer_fee: u64,
        to_native_token_amount: u64,
        coins: Coin<C>,
        decimals: u8,
        native_coins: Coin<SUI>,
        recipient: address,
        ctx: &mut TxContext
    ) {
        // Calculate the quantity of native tokens to send to the recipient in
        // return for the specified to_native_token_amount. This method will
        // override the to_native_token_amount if the specified amount is too
        // large too swap (based on the max_to_native_amount for the token).
        let (native_amount_for_recipient, to_native_token_amount) =
            calculate_native_amount_for_recipient<C>(
                t_state,
                to_native_token_amount,
                decimals
            );

        // Set the to_native_token_amount to zero if a swap will be performed.
        // Also compute the relayer refund in case the relayer sent more
        // tokens than necessary to perform the swap.
        if (native_amount_for_recipient > 0) {
            let native_coin_value = coin::value(&native_coins);

            // Confirm that the relayer sent enough tokens to perform the swap.
            assert!(
                native_coin_value >= native_amount_for_recipient,
                E_INSUFFICIENT_NATIVE_COIN
            );

            // Calculate the relayer refund. Send the native coins
            // to the recipient and the refund to the relayer.
            let relayer_refund =
                native_coin_value - native_amount_for_recipient;

            let native_coins_for_recipient;
            if (relayer_refund > 0) {
                native_coins_for_recipient = coin::split(
                    &mut native_coins,
                    native_coin_value - relayer_refund,
                    ctx
                );

                // Return the refund amount to the relayer.
                transfer::transfer(native_coins, tx_context::sender(ctx));
            } else {
                native_coins_for_recipient = native_coins;
            };

            // Send the native coins to the recipient.
            transfer::transfer(native_coins_for_recipient, recipient);
        } else {
            // Set the to_native_token_amount to zero since the
            // native_amount_for_recipient is zero and no swap will occur.
            to_native_token_amount = 0;

            // Return the native_coin object to the relayer.
            transfer::transfer(native_coins, tx_context::sender(ctx));
        };

        // Compute the amount of transferred tokens to send to the relayer.
        let amount_for_relayer = relayer_fee + to_native_token_amount;

        // Split the coin object based on the amounts for the relayer and
        // recipient.
        let coins_for_recipient;
        if (amount_for_relayer > 0) {
            let coin_amount = coin::value(&coins);

            // Split the coins.
            coins_for_recipient = coin::split(
                &mut coins,
                coin_amount - amount_for_relayer,
                ctx
            );

            // Pay the relayer designated coins.
            transfer::transfer(coins, tx_context::sender(ctx));
        } else {
            coins_for_recipient = coins;
        };

        // Finally pay the recipient the transferred tokens.
        transfer::transfer(coins_for_recipient, recipient);
    }

    fun calculate_native_amount_for_recipient<C>(
        t_state: &State,
        to_native_token_amount: u64,
        decimals: u8
    ): (u64, u64) {
        if (to_native_token_amount > 0) {
            // Compute the max amount of tokens the recipient can swap.
            // Override the to_native_token_amount if its value is larger
            // than the max_swap_amount.
            let max_swap_amount = calculate_max_swap_amount_in<C>(
                t_state,
                decimals
            );
            if (to_native_token_amount > max_swap_amount) {
                to_native_token_amount = max_swap_amount;
            };

            // Compute the amount of native asset to send the recipient.
            return (
                calculate_native_swap_amount_out<C>(
                    t_state,
                    to_native_token_amount,
                    decimals
                ),
                to_native_token_amount
            )
        } else {
            return (0, 0)
        }
    }

    public fun calculate_max_swap_amount_in<C>(
        t_state: &State,
        coin_decimals: u8
    ): u64 {
        // SUI token decimals are hardcoded to 9 in the coin contract,
        // and can be hardcoded here since this contract is only intended
        // to be deployed to the Sui network.
        let sui_decimals: u8 = 9;

        // Cast variables to u256 to avoid overflows.
        let native_swap_rate = (
            relayer_state::native_swap_rate<C>(t_state) as u256)
        ;
        let max_native_swap_amount = (
            relayer_state::max_native_swap_amount<C>(
                t_state
            ) as u256
        );
        let swap_rate_precision = (
            relayer_state::swap_rate_precision(t_state) as u256
        );

        // Compute the max_swap_amount_in.
        let max_swap_amount_in;
        if (coin_decimals > sui_decimals) {
            max_swap_amount_in = (
                max_native_swap_amount * native_swap_rate *
                (math::pow(10, coin_decimals - sui_decimals) as u256) /
                swap_rate_precision
            );
        } else {
            max_swap_amount_in = (
                (max_native_swap_amount * native_swap_rate) /
                ((math::pow(10, sui_decimals - coin_decimals) as u256) *
                swap_rate_precision)
            );
        };

        // Catch overflow.
        // TODO: document that the contract owner has configured
        // the contracts incorrectly.
        assert!(
            max_swap_amount_in <= (U64_MAX as u256),
            E_SWAP_IN_OVERFLOW
        );

        // Return u64 casted relayer fee.
        (max_swap_amount_in as u64)
    }

    public fun calculate_native_swap_amount_out<C>(
        t_state: &State,
        to_native_amount: u64,
        coin_decimals: u8
    ): u64 {
        // SUI token decimals are hardcoded to 9 in the coin contract,
        // and can be hardcoded here since this contract is only intended
        // to be deployed to the Sui network.
        let sui_decimals: u8 = 9;

        // Cast variables to u256 to avoid overflows.
        let native_swap_rate = (
            relayer_state::native_swap_rate<C>(t_state) as u256)
        ;
        let swap_rate_precision = (
            relayer_state::swap_rate_precision(t_state) as u256
        );

        // Compute native_swap_amount_out.
        let native_swap_amount_out;
        if (coin_decimals > sui_decimals) {
            native_swap_amount_out = (
                swap_rate_precision *
                (to_native_amount as u256) /
                (native_swap_rate *
                (math::pow(10, coin_decimals - sui_decimals) as u256))
            );
        } else {
            native_swap_amount_out = (
                swap_rate_precision *
                (to_native_amount as u256) *
                (math::pow(10, sui_decimals - coin_decimals) as u256) /
                native_swap_rate
            );
        };

        // Catch overflow.
        // TODO: document that the contract owner has configured
        // the contracts incorrectly.
        assert!(
            native_swap_amount_out <= (U64_MAX as u256),
            E_SWAP_OUT_OVERFLOW
        );

        // Return u64 casted relayer fee.
        (native_swap_amount_out as u64)
    }
}

#[test_only]
module token_bridge_relayer::complete_transfer_tests {
    use std::vector;
    use sui::sui::SUI;
    use sui::test_scenario::{Self, Scenario, TransactionEffects};
    use sui::coin::{Self, Coin, CoinMetadata};
    use sui::transfer::{Self as native_transfer};
    use sui::tx_context::{TxContext};

    // Token Bridge Relayer.
    use token_bridge_relayer::owner::{Self, OwnerCap};
    use token_bridge_relayer::state::{State};
    use token_bridge_relayer::init_tests::{Self, set_up as owner_set_up};
    use token_bridge_relayer::redeem::{Self};

    // Wormhole.
    use wormhole::state::{
        Self as wormhole_state_module,
        State as WormholeState
    };

    // Token Bridge.
    use token_bridge::state::{Self as bridge_state, State as BridgeState};
    use token_bridge::attest_token::{Self};

    // Example coins.
    use example_coins::coin_8::{Self, COIN_8};
    use example_coins::coin_10::{Self, COIN_10};

    // Test consts.
    const TEST_FOREIGN_EMITTER_CHAIN: u16 = 2;
    const TEST_FOREIGN_EMITTER_CONTRACT: vector<u8> =
        x"0000000000000000000000000000000000000000000000000000000000000069";
    const TEST_INITIAL_SUI_SWAP_RATE: u64 = 2000000000; // $20.
    const TEST_INITIAL_COIN_SWAP_RATE: u64 = 100000000; // $1.
    const TEST_INITIAL_MAX_SWAP_AMOUNT: u64 = 1000000000; // 10 SUI.
    const U64_MAX: u64 = 18446744073709551614;

    #[test]
    public fun complete_transfer() {
        // Test variables.
        let vaa = x"01000000000100e0f4a01001bef353bb9d428b27466bac1d5ed1a5634318d88e73921419c80e737ce22b96e9ef2e1021411bb94ba5a1ba0ef4e2f7451c8d00baab2fc56a8784c401641b8d730000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa5850000000000000000010300000000000000000000000000000000000000000000000000038d7ea4c68000000000000000000000000000000000000000000000000000000000000000000100150000000000000000000000000000000000000000000000000000000000000003001500000000000000000000000000000000000000000000000000000000000000690100000000000000000000000000000000000000000000000000000002540be40000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 1000000000000000;

        // Test setup.
        let (creator, _) = init_tests::people();
        let (my_scenario, _) = owner_set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            creator,
            scenario,
            test_metadata
        );

        // Ignore effects.
        test_scenario::next_tx(scenario, creator);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, creator);

        // Store created object IDs.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 1, 0);

        // Balance check the recipient.
        {
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_8>>(scenario);

            // Validate the object's value.
            assert!(coin::value(&token_object) == test_amount, 0);

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_minimum_amount() {
        // Test variables.
        let vaa = x"010000000001000eab97166ba96cb83ec3758ef54300bda75b692891eb5130ae2e5d35cb33204244a71f5b51bea56389d73231229ccf2842e9281842f0e128309ee7d03a7844ae01641b6ef90000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa5850000000000000000010300000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001001500000000000000000000000000000000000000000000000000000000000000030015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 1;

        // Test setup.
        let (creator, _) = init_tests::people();
        let (my_scenario, _) = owner_set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            creator,
            scenario,
            test_metadata
        );

        // Ignore effects.
        test_scenario::next_tx(scenario, creator);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, creator);

        // Store created object IDs.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 1, 0);

        // Balance check the recipient.
        {
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_8>>(scenario);

            // Validate the object's value.
            assert!(coin::value(&token_object) == test_amount, 0);

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_maximum_amount() {
        // Test variables.
        let vaa = x"010000000001001b9b842d25abb4cdbc0ddf7883b54f10223f3a4d545b6e049572ec985bbb213a254ad09e6304cb66b9f8c109796fccc85b384343bc771ca1f7e776f5487e986300641b8c0d0000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa58500000000000000000103000000000000000000000000000000000000000000000000fffffffffffffffe000000000000000000000000000000000000000000000000000000000000000100150000000000000000000000000000000000000000000000000000000000000003001500000000000000000000000000000000000000000000000000000000000000690100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000015dca94e7200000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = U64_MAX;

        // Test setup.
        let (creator, _) = init_tests::people();
        let (my_scenario, _) = owner_set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            creator,
            scenario,
            test_metadata
        );

        // Ignore effects.
        test_scenario::next_tx(scenario, creator);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, creator);

        // Store created object IDs.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 1, 0);

        // Balance check the recipient.
        {
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_8>>(scenario);

            // Validate the object's value.
            assert!(coin::value(&token_object) == test_amount, 0);

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = redeem::E_UNREGISTERED_COIN)]
    public fun cannot_complete_transfer_unregistered_coin() {
        // Test variables.
        let vaa = x"01000000000100e0f4a01001bef353bb9d428b27466bac1d5ed1a5634318d88e73921419c80e737ce22b96e9ef2e1021411bb94ba5a1ba0ef4e2f7451c8d00baab2fc56a8784c401641b8d730000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa5850000000000000000010300000000000000000000000000000000000000000000000000038d7ea4c68000000000000000000000000000000000000000000000000000000000000000000100150000000000000000000000000000000000000000000000000000000000000003001500000000000000000000000000000000000000000000000000000000000000690100000000000000000000000000000000000000000000000000000002540be40000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 1000000000000000;

        // Test setup.
        let (creator, _) = init_tests::people();
        let (my_scenario, _) = owner_set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            creator,
            scenario,
            test_metadata
        );

        // Ignore effects.
        test_scenario::next_tx(scenario, creator);

        // Deregister COIN_8 on the token bridge relayer contract.
        {
            let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

            owner::deregister_token<COIN_8>(
                &owner_cap,
                &mut token_bridge_relayer_state,
            );

            test_scenario::return_to_sender(scenario, owner_cap);
        };

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        test_scenario::next_tx(scenario, creator);

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = redeem::E_UNREGISTERED_FOREIGN_CONTRACT)]
    public fun cannot_complete_transfer_unknown_sender() {
        // Test variables.
        let vaa = x"01000000000100aa23947200f75f57002ae5d2c318d9c111358cd6b4c7951c2a9de23ab916a09861ec761ea008ba27f7c2d1cca96dd310b231ad4aa4f2bbd1312421600c0cb48701641c5da20000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa5850000000000000000010300000000000000000000000000000000000000000000000000038d7ea4c680000000000000000000000000000000000000000000000000000000000000000001001500000000000000000000000000000000000000000000000000000000000000030015000000000000000000000000000000000000000000000000000000000000beef0100000000000000000000000000000000000000000000000000000002540be40000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 1000000000000000;

        // Test setup.
        let (creator, _) = init_tests::people();
        let (my_scenario, _) = owner_set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            creator,
            scenario,
            test_metadata
        );

        // Ignore effects.
        test_scenario::next_tx(scenario, creator);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        test_scenario::next_tx(scenario, creator);

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = redeem::E_INVALID_CALLER_FOR_ACTION)]
    public fun cannot_complete_transfer_invalid_caller() {
        // Test variables.
        let vaa = x"01000000000100e0f4a01001bef353bb9d428b27466bac1d5ed1a5634318d88e73921419c80e737ce22b96e9ef2e1021411bb94ba5a1ba0ef4e2f7451c8d00baab2fc56a8784c401641b8d730000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa5850000000000000000010300000000000000000000000000000000000000000000000000038d7ea4c68000000000000000000000000000000000000000000000000000000000000000000100150000000000000000000000000000000000000000000000000000000000000003001500000000000000000000000000000000000000000000000000000000000000690100000000000000000000000000000000000000000000000000000002540be40000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 1000000000000000;

        // Test setup.
        let (creator, relayer) = init_tests::people();
        let (my_scenario, _) = owner_set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, creator);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            creator,
            scenario,
            test_metadata
        );

        // NOTE: Switch the context to the relayer for this test.
        test_scenario::next_tx(scenario, relayer);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        test_scenario::next_tx(scenario, creator);

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_8_no_swap_no_fee() {
        // Test variables.
        let vaa = x"01000000000100892ec39bfa1807a5d0e2e91f393e79fc3587b7744b1c33b873441f4357aaf4ce77346970b793f6b78e76aa2be7a4a61414f51886a48d0420a6b492aaa2b29d6a01641c84a10000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa5850000000000000000010300000000000000000000000000000000000000000000000000038d7ea4c680000000000000000000000000000000000000000000000000000000000000000001001500000000000000000000000000000000000000000000000000000000000000030015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 1000000000000000;
        let swap_amount = 0;

        // Test setup.
        let (recipient, relayer) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // NOTE: Switch the context to the relayer for this test.
        test_scenario::next_tx(scenario, relayer);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Mint sui tokens for the relayer to swap with the contract.
        let (sui_coins_for_swap, _) = mint_sui_for_swap<COIN_8>(
            &token_bridge_relayer_state,
            swap_amount,
            8, // COIN_8 decimals.
            scenario
        );
        assert!(coin::value(&sui_coins_for_swap) == 0, 0);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

        // Store created object IDs. Since the swap amount is zero in this test,
        // the native coins object is destroyed and not returned to the relayer.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 1, 0);

        // Balance check the recipient.
        {
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_8>>(scenario);

            // Validate the object's value.
            assert!(coin::value(&token_object) == test_amount, 0);

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_10_no_swap_no_fee() {
        // Test variables.
        let vaa = x"01000000000100f15e501dadcb8eb7663442db3ef77d2e05f44df46de302cd0545b93609cb8a4010262c0fc7a7d91e1b56db86bd0a821d823c5b02e4d098ace072433d9e51024600642361740000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa5850000000000000000010300000000000000000000000000000000000000000000000000038d7ea4c680000000000000000000000000000000000000000000000000000000000000000001001500000000000000000000000000000000000000000000000000000000000000030015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 100000000000000000;
        let swap_amount = 0;

        // Test setup.
        let (recipient, relayer) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 10.
        let (test_coin, test_metadata) = mint_coin_10(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_10>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // NOTE: Switch the context to the relayer for this test.
        test_scenario::next_tx(scenario, relayer);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Mint sui tokens for the relayer to swap with the contract.
        let (sui_coins_for_swap, _) = mint_sui_for_swap<COIN_10>(
            &token_bridge_relayer_state,
            swap_amount,
            10, // COIN_10 decimals.
            scenario
        );
        assert!(coin::value(&sui_coins_for_swap) == 0, 0);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_10>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

        // Store created object IDs. Since the swap amount is zero in this test,
        // the native coins object is destroyed and not returned to the relayer.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 1, 0);

        // Balance check the recipient.
        {
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_10>>(scenario);

            // Validate the object's value.
            assert!(coin::value(&token_object) == test_amount, 0);

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_8_no_swap_with_fee() {
        // Test variables.
        let vaa = x"010000000001003db589ee64873851de75a63e7970a94a9d7fb88622725379829787fb2f57c2727eb3ac98f11fa87c26312aac28fd835bf30ab9fdaff6bc282ea64fdf94984dd200641c8f060000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa5850000000000000000010300000000000000000000000000000000000000000000000000038d7ea4c68000000000000000000000000000000000000000000000000000000000000000000100150000000000000000000000000000000000000000000000000000000000000003001500000000000000000000000000000000000000000000000000000000000000690100000000000000000000000000000000000000000000000000000002540be40000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 1000000000000000;
        let swap_amount = 0;
        let relayer_fee = 10000000000;

        // Test setup.
        let (recipient, relayer) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // NOTE: Switch the context to the relayer for this test.
        test_scenario::next_tx(scenario, relayer);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Mint sui tokens for the relayer to swap with the contract.
        let (sui_coins_for_swap, _) = mint_sui_for_swap<COIN_8>(
            &token_bridge_relayer_state,
            swap_amount,
            8, // COIN_8 decimals.
            scenario
        );
        assert!(coin::value(&sui_coins_for_swap) == 0, 0);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

        // Store created object IDs. Since the swap amount is zero in this test,
        // the native coins object is destroyed and not returned to the relayer.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 2, 0);

        // Balance check the recipient.
        {
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_8>>(scenario);

            // Validate the object's value.
            assert!(coin::value(&token_object) == test_amount - relayer_fee, 0);

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
        };

        // Balance check the relayer.
        {
            // Switch the context to the recipient.
            test_scenario::next_tx(scenario, relayer);

            // Check COIN_8 balances.
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_8>>(scenario);

            // Validate the object's value.
            assert!(coin::value(&token_object) == relayer_fee, 0);

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_10_no_swap_with_fee() {
        // Test variables.
        let vaa = x"010000000001009034c0e26e0e789eb69fc27520da828b191b531293de6836fdb1da78ad66e7b33b199b200361006cec91d9f2d73aab37b4d40800dd48566da81ba97d715c575c00642362510000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa5850000000000000000010300000000000000000000000000000000000000000000000000038d7ea4c68000000000000000000000000000000000000000000000000000000000000000000100150000000000000000000000000000000000000000000000000000000000000003001500000000000000000000000000000000000000000000000000000000000000690100000000000000000000000000000000000000000000000000000002540be40000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 100000000000000000;
        let swap_amount = 0;
        let relayer_fee = 1000000000000;

        // Test setup.
        let (recipient, relayer) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 10.
        let (test_coin, test_metadata) = mint_coin_10(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_10>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // NOTE: Switch the context to the relayer for this test.
        test_scenario::next_tx(scenario, relayer);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Mint sui tokens for the relayer to swap with the contract.
        let (sui_coins_for_swap, _) = mint_sui_for_swap<COIN_10>(
            &token_bridge_relayer_state,
            swap_amount,
            10, // COIN_10 decimals.
            scenario
        );
        assert!(coin::value(&sui_coins_for_swap) == 0, 0);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_10>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

        // Store created object IDs. Since the swap amount is zero in this test,
        // the native coins object is destroyed and not returned to the relayer.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 2, 0);

        // Balance check the recipient.
        {
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_10>>(scenario);

            // Validate the object's value.
            assert!(coin::value(&token_object) == test_amount - relayer_fee, 0);

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
        };

        // Balance check the relayer.
        {
            // Switch the context to the recipient.
            test_scenario::next_tx(scenario, relayer);

            // Check COIN_8 balances.
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_10>>(scenario);

            // Validate the object's value.
            assert!(coin::value(&token_object) == relayer_fee, 0);

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_8_with_swap_and_fee() {
        // Test variables.
        let vaa = x"0100000000010097eb351b67b5313f836885d055cf99590fba6c883afe97fd220020268f98141f16273f2c3827f2de0bdae8b1ccb97845ab4c34fdc05ed2cd542ec02b9b02688a01641c91350000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585000000000000000001030000000000000000000000000000000000000000000000000011c37937e08000000000000000000000000000000000000000000000000000000000000000000100150000000000000000000000000000000000000000000000000000000000000003001500000000000000000000000000000000000000000000000000000000000000690100000000000000000000000000000000000000000000000000000000000a875000000000000000000000000000000000000000000000000000000000000186a00000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 5000000000000000;
        let swap_amount = 100000;
        let relayer_fee = 690000;

        // Test setup.
        let (recipient, relayer) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // NOTE: Switch the context to the relayer for this test.
        test_scenario::next_tx(scenario, relayer);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Mint sui tokens for the relayer to swap with the contract. The
        // swap_amount will be overridden if its value is larger than
        // the max allowed swap amount.
        let (sui_coins_for_swap, swap_amount) = mint_sui_for_swap<COIN_8>(
            &token_bridge_relayer_state,
            swap_amount,
            8, // COIN_8 decimals.
            scenario
        );
        let sui_coins_for_swap_amount = coin::value(&sui_coins_for_swap);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

        // Store created object IDs.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 3, 0);

        // Balance check the recipient.
        {
            // Check the SUI and COIN_8 balances.
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_8>>(scenario);
            let sui_object =
                test_scenario::take_from_sender<Coin<SUI>>(scenario);

            // Validate the object's value.
            assert!(
                coin::value(&token_object) ==
                    test_amount - relayer_fee - swap_amount,
                0
            );
            assert!(
                coin::value(&sui_object) == sui_coins_for_swap_amount,
                0
            );

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
            test_scenario::return_to_sender(scenario, sui_object);
        };

        // Balance check the relayer.
        {
            // Switch the context to the recipient.
            test_scenario::next_tx(scenario, relayer);

            // Check the SUI and COIN_8 balances.
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_8>>(scenario);

            // Validate the object's value.
            assert!(coin::value(&token_object) == relayer_fee + swap_amount, 0);

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_10_with_swap_and_fee() {
        // Test variables.
        let vaa = x"010000000001005778e9c6e5cde363ab934c7591a77b36ff18177b173f56aea45aafa899c1a1aa0727f6d449fd877c771e74097eb9616bd065ef402f5e1aea1c9fe7340b3f6d6e01642367100000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585000000000000000001030000000000000000000000000000000000000000000000000011c37937e08000000000000000000000000000000000000000000000000000000000000000000100150000000000000000000000000000000000000000000000000000000000000003001500000000000000000000000000000000000000000000000000000000000000690100000000000000000000000000000000000000000000000000000000000a875000000000000000000000000000000000000000000000000000000000000186a00000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 500000000000000000;
        let swap_amount = 10000000;
        let relayer_fee = 69000000;

        // Test setup.
        let (recipient, relayer) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 10.
        let (test_coin, test_metadata) = mint_coin_10(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_10>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // NOTE: Switch the context to the relayer for this test.
        test_scenario::next_tx(scenario, relayer);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Mint sui tokens for the relayer to swap with the contract. The
        // swap_amount will be overridden if its value is larger than
        // the max allowed swap amount.
        let (sui_coins_for_swap, swap_amount) = mint_sui_for_swap<COIN_10>(
            &token_bridge_relayer_state,
            swap_amount,
            10, // COIN_10 decimals.
            scenario
        );
        let sui_coins_for_swap_amount = coin::value(&sui_coins_for_swap);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_10>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

        // Store created object IDs.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 3, 0);

        // Balance check the recipient.
        {
            // Check the SUI and COIN_10 balances.
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_10>>(scenario);
            let sui_object =
                test_scenario::take_from_sender<Coin<SUI>>(scenario);

            // Validate the object's value.
            assert!(
                coin::value(&token_object) ==
                    test_amount - relayer_fee - swap_amount,
                0
            );
            assert!(
                coin::value(&sui_object) == sui_coins_for_swap_amount,
                0
            );

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
            test_scenario::return_to_sender(scenario, sui_object);
        };

        // Balance check the relayer.
        {
            // Switch the context to the recipient.
            test_scenario::next_tx(scenario, relayer);

            // Check the SUI and COIN_10 balances.
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_10>>(scenario);

            // Validate the object's value.
            assert!(coin::value(&token_object) == relayer_fee + swap_amount, 0);

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_8_with_swap_no_fee() {
        // Test variables.
        let vaa = x"01000000000100637e7759a7d2376386711ff1d14ffb006adc5c1ef22388faf66afa5aa7598eae0844beaf8410c385c17cbd3be1326ac01724d2a3dfef171568d26577583dd77f01641cb8c60000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585000000000000000001030000000000000000000000000000000000000000000000000011c37937e080000000000000000000000000000000000000000000000000000000000000000001001500000000000000000000000000000000000000000000000000000000000000030015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000186a00000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 5000000000000000;
        let swap_amount = 100000;

        // Test setup.
        let (recipient, relayer) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // NOTE: Switch the context to the relayer for this test.
        test_scenario::next_tx(scenario, relayer);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Mint sui tokens for the relayer to swap with the contract. The
        // swap_amount will be overridden if its value is larger than
        // the max allowed swap amount.
        let (sui_coins_for_swap, swap_amount) = mint_sui_for_swap<COIN_8>(
            &token_bridge_relayer_state,
            swap_amount,
            8, // COIN_8 decimals.
            scenario
        );
        let sui_coins_for_swap_amount = coin::value(&sui_coins_for_swap);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

        // Store created object IDs.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 3, 0);

        // Balance check the recipient.
        {
            // Check the SUI and COIN_8 balances.
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_8>>(scenario);
            let sui_object =
                test_scenario::take_from_sender<Coin<SUI>>(scenario);

            // Validate the object's value.
            assert!(
                coin::value(&token_object) ==
                    test_amount - swap_amount,
                0
            );
            assert!(
                coin::value(&sui_object) == sui_coins_for_swap_amount,
                0
            );

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
            test_scenario::return_to_sender(scenario, sui_object);
        };

        // Balance check the relayer.
        {
            // Switch the context to the recipient.
            test_scenario::next_tx(scenario, relayer);

            // Check the SUI and COIN_8 balances.
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_8>>(scenario);

            // Validate the object's value.
            assert!(coin::value(&token_object) == swap_amount, 0);

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_10_with_swap_no_fee() {
        // Test variables.
        let vaa = x"01000000000100ca67244a6ceb3769504626776fc0a72f2a36e02d2e0576221f0bd950a3622da337444288a0961ac1db3184b3917f28b85430fe8a1f17dd9a16703a6f6dae8fb000642369c40000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585000000000000000001030000000000000000000000000000000000000000000000000011c37937e080000000000000000000000000000000000000000000000000000000000000000001001500000000000000000000000000000000000000000000000000000000000000030015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000186a00000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 500000000000000000;
        let swap_amount = 10000000;

        // Test setup.
        let (recipient, relayer) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 10.
        let (test_coin, test_metadata) = mint_coin_10(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_10>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // NOTE: Switch the context to the relayer for this test.
        test_scenario::next_tx(scenario, relayer);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Mint sui tokens for the relayer to swap with the contract. The
        // swap_amount will be overridden if its value is larger than
        // the max allowed swap amount.
        let (sui_coins_for_swap, swap_amount) = mint_sui_for_swap<COIN_10>(
            &token_bridge_relayer_state,
            swap_amount,
            10, // COIN_10 decimals.
            scenario
        );
        let sui_coins_for_swap_amount = coin::value(&sui_coins_for_swap);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_10>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

        // Store created object IDs.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 3, 0);

        // Balance check the recipient.
        {
            // Check the SUI and COIN_10 balances.
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_10>>(scenario);
            let sui_object =
                test_scenario::take_from_sender<Coin<SUI>>(scenario);

            // Validate the object's value.
            assert!(
                coin::value(&token_object) ==
                    test_amount - swap_amount,
                0
            );
            assert!(
                coin::value(&sui_object) == sui_coins_for_swap_amount,
                0
            );

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
            test_scenario::return_to_sender(scenario, sui_object);
        };

        // Balance check the relayer.
        {
            // Switch the context to the recipient.
            test_scenario::next_tx(scenario, relayer);

            // Check the SUI and COIN_10 balances.
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_10>>(scenario);

            // Validate the object's value.
            assert!(coin::value(&token_object) == swap_amount, 0);

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_8_swap_amount_limit_reached() {
        // Test variables.
        let vaa = x"01000000000100378aabd42a88015672ddcf3b71be8333182356123bca791ddf74b6812b5975d55a151fef43a52fb28ff7fc3b4abf4e0afe3e27974e98404e1d057284222aa78a01641c9a880000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585000000000000000001030000000000000000000000000000000000000000000000000011c37937e080000000000000000000000000000000000000000000000000000000000000000001001500000000000000000000000000000000000000000000000000000000000000030015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000116886276640000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 5000000000000000;
        let initial_swap_amount = 4900000000000000;

        // Test setup.
        let (recipient, relayer) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // NOTE: Switch the context to the relayer for this test.
        test_scenario::next_tx(scenario, relayer);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Mint sui tokens for the relayer to swap with the contract. The
        // swap_amount will be overridden if its value is larger than
        // the max allowed swap amount.
        let (sui_coins_for_swap, swap_amount) = mint_sui_for_swap<COIN_8>(
            &token_bridge_relayer_state,
            initial_swap_amount,
            8, // COIN_8 decimals.
            scenario
        );
        let sui_coins_for_swap_amount = coin::value(&sui_coins_for_swap);

        // Confirm that the swap_amount was reduced.
        assert!(swap_amount < initial_swap_amount, 0);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

        // Store created object IDs.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 3, 0);

        // Balance check the recipient.
        {
            // Check the SUI and COIN_8 balances.
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_8>>(scenario);
            let sui_object =
                test_scenario::take_from_sender<Coin<SUI>>(scenario);

            // Validate the object's value.
            assert!(
                coin::value(&token_object) ==
                    test_amount - swap_amount,
                0
            );
            assert!(
                coin::value(&sui_object) == sui_coins_for_swap_amount,
                0
            );

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
            test_scenario::return_to_sender(scenario, sui_object);
        };

        // Balance check the relayer.
        {
            // Switch the context to the recipient.
            test_scenario::next_tx(scenario, relayer);

            // Check the SUI and COIN_8 balances.
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_8>>(scenario);

            // Validate the object's value.
            assert!(coin::value(&token_object) == swap_amount, 0);

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_10_swap_amount_limit_reached() {
        // Test variables.
        let vaa = x"010000000001000af2f0f92d6d0d6e1a20478010ecce03a287f8122e6149f9b5b24c2e999680cd36a7126bd8f2a36da98a179ddcaecaaa0f4d0e7b0b5554650111c4cfd3ae848201642372e90000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585000000000000000001030000000000000000000000000000000000000000000000000011c37937e080000000000000000000000000000000000000000000000000000000000000000001001500000000000000000000000000000000000000000000000000000000000000030015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000116886276640000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 500000000000000000;
        let initial_swap_amount = 490000000000000000;

        // Test setup.
        let (recipient, relayer) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 10.
        let (test_coin, test_metadata) = mint_coin_10(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_10>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // NOTE: Switch the context to the relayer for this test.
        test_scenario::next_tx(scenario, relayer);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Mint sui tokens for the relayer to swap with the contract. The
        // swap_amount will be overridden if its value is larger than
        // the max allowed swap amount.
        let (sui_coins_for_swap, swap_amount) = mint_sui_for_swap<COIN_10>(
            &token_bridge_relayer_state,
            initial_swap_amount,
            10, // COIN_10 decimals.
            scenario
        );
        let sui_coins_for_swap_amount = coin::value(&sui_coins_for_swap);

        // Confirm that the swap_amount was reduced.
        assert!(swap_amount < initial_swap_amount, 0);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_10>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

        // Store created object IDs.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 3, 0);

        // Balance check the recipient.
        {
            // Check the SUI and COIN_10 balances.
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_10>>(scenario);
            let sui_object =
                test_scenario::take_from_sender<Coin<SUI>>(scenario);

            // Validate the object's value.
            assert!(
                coin::value(&token_object) ==
                    test_amount - swap_amount,
                0
            );
            assert!(
                coin::value(&sui_object) == sui_coins_for_swap_amount,
                0
            );

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
            test_scenario::return_to_sender(scenario, sui_object);
        };

        // Balance check the relayer.
        {
            // Switch the context to the recipient.
            test_scenario::next_tx(scenario, relayer);

            // Check the SUI and COIN_10 balances.
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_10>>(scenario);

            // Validate the object's value.
            assert!(coin::value(&token_object) == swap_amount, 0);

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_8_no_swap_no_fee_with_relayer_refund() {
        // Test variables.
        let vaa = x"01000000000100892ec39bfa1807a5d0e2e91f393e79fc3587b7744b1c33b873441f4357aaf4ce77346970b793f6b78e76aa2be7a4a61414f51886a48d0420a6b492aaa2b29d6a01641c84a10000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa5850000000000000000010300000000000000000000000000000000000000000000000000038d7ea4c680000000000000000000000000000000000000000000000000000000000000000001001500000000000000000000000000000000000000000000000000000000000000030015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 1000000000000000;

        // Test setup.
        let (recipient, relayer) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // NOTE: Switch the context to the relayer for this test.
        test_scenario::next_tx(scenario, relayer);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Mint sui tokens for the relayer to swap with the contract. Set
        // the swap amount to a nonzero number so sui tokens are minted
        // and the contract is forced to refund the relayer.
        let (sui_coins_for_swap, _) = mint_sui_for_swap<COIN_8>(
            &token_bridge_relayer_state,
            5000000, // Swap amount.
            8, // COIN_8 decimals.
            scenario
        );

        // Cache the sui_coins_for_swap value and confirm it's nonzero.
        let sui_coins_for_swap_amount = coin::value(&sui_coins_for_swap);
        assert!(sui_coins_for_swap_amount > 0, 0);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

        // Store created object IDs.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 2, 0);

        // Balance check the recipient.
        {
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_8>>(scenario);

            // Validate the object's value.
            assert!(coin::value(&token_object) == test_amount, 0);

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
        };

        // Balance check the relayer.
        {
            // Switch the context to the recipient.
            test_scenario::next_tx(scenario, relayer);

            let sui_object =
                test_scenario::take_from_sender<Coin<SUI>>(scenario);

            // Validate the object's value.
            assert!(coin::value(&sui_object) == sui_coins_for_swap_amount, 0);

            // Bye bye.
            test_scenario::return_to_sender(scenario, sui_object);
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_10_no_swap_no_fee_with_relayer_refund() {
        // Test variables.
        let vaa = x"010000000001009f8f280ade41d71c5dcef18bde6da9b0aa570bf069c6f55b499163462cc750f938c68db908f1a8a061a5484de6004482d67aa90335925690aa9bb626df77241600642374da0000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa5850000000000000000010300000000000000000000000000000000000000000000000000038d7ea4c680000000000000000000000000000000000000000000000000000000000000000001001500000000000000000000000000000000000000000000000000000000000000030015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 100000000000000000;

        // This swap amount is not actually encoded in the VAA. This is used to
        // create a scenario where the contract refunds the relayer.
        let swap_amount = 5000000;

        // Test setup.
        let (recipient, relayer) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 10.
        let (test_coin, test_metadata) = mint_coin_10(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_10>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // NOTE: Switch the context to the relayer for this test.
        test_scenario::next_tx(scenario, relayer);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Mint sui tokens for the relayer to swap with the contract. Set
        // the swap amount to a nonzero number so sui tokens are minted
        // and the contract is forced to refund the relayer.
        let (sui_coins_for_swap, _) = mint_sui_for_swap<COIN_10>(
            &token_bridge_relayer_state,
            swap_amount, // Swap amount.
            10, // COIN_10 decimals.
            scenario
        );

        // Cache the sui_coins_for_swap value and confirm it's nonzero.
        let sui_coins_for_swap_amount = coin::value(&sui_coins_for_swap);
        assert!(sui_coins_for_swap_amount > 0, 0);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_10>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

        // Store created object IDs.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 2, 0);

        // Balance check the recipient.
        {
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_10>>(scenario);

            // Validate the object's value.
            assert!(coin::value(&token_object) == test_amount, 0);

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
        };

        // Balance check the relayer.
        {
            // Switch the context to the recipient.
            test_scenario::next_tx(scenario, relayer);

            let sui_object =
                test_scenario::take_from_sender<Coin<SUI>>(scenario);

            // Validate the object's value.
            assert!(coin::value(&sui_object) == sui_coins_for_swap_amount, 0);

            // Bye bye.
            test_scenario::return_to_sender(scenario, sui_object);
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_8_with_swap_fee_and_relayer_refund() {
        // Test variables.
        let vaa = x"01000000000100b2015fa63451a54aca6771da0e85f37a5908dff6da6d5a805e2573967bc9017279c2383a750f3f1ae88485eebe2a0244a36f9aaf98de47ffcd552d39920a33bc00641cc5fb0000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585000000000000000001030000000000000000000000000000000000000000000000000de0b6b3a7640000000000000000000000000000000000000000000000000000000000000000000100150000000000000000000000000000000000000000000000000000000000000003001500000000000000000000000000000000000000000000000000000000000000690100000000000000000000000000000000000000000000000000000000000186a000000000000000000000000000000000000000000000000000000000009896800000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 1000000000000000000;
        let swap_amount = 10000000;
        let relayer_fee = 100000;

        // Test setup.
        let (recipient, relayer) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // NOTE: Switch the context to the relayer for this test.
        test_scenario::next_tx(scenario, relayer);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Mint sui tokens for the relayer to swap with the contract. The
        // swap_amount will be overridden if its value is larger than
        // the max allowed swap amount. For this test specifically, we
        // will multiply the swap_amount by two to force the contract
        // to return half of the native coins.
        let (sui_coins_for_swap, swap_amount) = mint_sui_for_swap<COIN_8>(
            &token_bridge_relayer_state,
            swap_amount * 2,
            8, // COIN_8 decimals.
            scenario
        );
        let sui_coins_for_swap_amount = coin::value(&sui_coins_for_swap);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

        // Store created object IDs.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 4, 0);

        // Balance check the recipient.
        {
            // Check the SUI and COIN_8 balances.
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_8>>(scenario);
            let sui_object =
                test_scenario::take_from_sender<Coin<SUI>>(scenario);

            // Validate the object's value.
            assert!(
                coin::value(&token_object) ==
                    test_amount - relayer_fee - swap_amount / 2,
                0
            );
            assert!(
                coin::value(&sui_object) == sui_coins_for_swap_amount / 2,
                0
            );

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
            test_scenario::return_to_sender(scenario, sui_object);
        };

        // Balance check the relayer.
        {
            // Switch the context to the recipient.
            test_scenario::next_tx(scenario, relayer);

            // Check the SUI and COIN_8 balances.
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_8>>(scenario);
            let sui_object =
                test_scenario::take_from_sender<Coin<SUI>>(scenario);

            // Validate the object's value.
            assert!(coin::value(&token_object) == relayer_fee + swap_amount / 2, 0);
            assert!(
                coin::value(&sui_object) == sui_coins_for_swap_amount / 2,
                0
            );

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
            test_scenario::return_to_sender(scenario, sui_object);
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_10_with_swap_fee_and_relayer_refund() {
        // Test variables.
        let vaa = x"0100000000010018cd7f8e685cc58678013224ec29b3acef4fec41fc21112f8cd4553cd19514ff22d499f2fa0f9456d4e48b655c7719f8170f06156493b20c8fa7f4a9552a89080164237b7f0000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa58500000000000000000103000000000000000000000000000000000000000000000000002386f26fc10000000000000000000000000000000000000000000000000000000000000000000100150000000000000000000000000000000000000000000000000000000000000003001500000000000000000000000000000000000000000000000000000000000000690100000000000000000000000000000000000000000000000000000000000003e800000000000000000000000000000000000000000000000000000000000186a00000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 1000000000000000000;
        let swap_amount = 10000000;
        let relayer_fee = 100000;

        // Test setup.
        let (recipient, relayer) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 10.
        let (test_coin, test_metadata) = mint_coin_10(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_10>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // NOTE: Switch the context to the relayer for this test.
        test_scenario::next_tx(scenario, relayer);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Mint sui tokens for the relayer to swap with the contract. The
        // swap_amount will be overridden if its value is larger than
        // the max allowed swap amount. For this test specifically, we
        // will multiply the swap_amount by two to force the contract
        // to return half of the native coins.
        let (sui_coins_for_swap, swap_amount) = mint_sui_for_swap<COIN_10>(
            &token_bridge_relayer_state,
            swap_amount * 2,
            10, // COIN_10 decimals.
            scenario
        );
        let sui_coins_for_swap_amount = coin::value(&sui_coins_for_swap);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_10>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

        // Store created object IDs.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 4, 0);

        // Balance check the recipient.
        {
            // Check the SUI and COIN_10 balances.
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_10>>(scenario);
            let sui_object =
                test_scenario::take_from_sender<Coin<SUI>>(scenario);

            // Validate the object's value.
            assert!(
                coin::value(&token_object) ==
                    test_amount - relayer_fee - swap_amount / 2,
                0
            );
            assert!(
                coin::value(&sui_object) == sui_coins_for_swap_amount / 2,
                0
            );

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
            test_scenario::return_to_sender(scenario, sui_object);
        };

        // Balance check the relayer.
        {
            // Switch the context to the recipient.
            test_scenario::next_tx(scenario, relayer);

            // Check the SUI and COIN_10 balances.
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_10>>(scenario);
            let sui_object =
                test_scenario::take_from_sender<Coin<SUI>>(scenario);

            // Validate the object's value.
            assert!(coin::value(&token_object) == relayer_fee + swap_amount / 2, 0);
            assert!(
                coin::value(&sui_object) == sui_coins_for_swap_amount / 2,
                0
            );

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
            test_scenario::return_to_sender(scenario, sui_object);
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_8_maximum_amount() {
        // Test variables.
        let vaa = x"010000000001001995ebd46c97bc93cb6d405617fd42571542db2d4da1533194b79868cf3d6992276be61cb6b3327a6baf86d64a0357b53ea463d1ce2508987fa8248f664a58a801641cd10b0000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa58500000000000000000103000000000000000000000000000000000000000000000000fffffffffffffffe0000000000000000000000000000000000000000000000000000000000000001001500000000000000000000000000000000000000000000000000000000000000030015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = U64_MAX;
        let swap_amount = 0;

        // Test setup.
        let (recipient, relayer) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // NOTE: Switch the context to the relayer for this test.
        test_scenario::next_tx(scenario, relayer);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Mint sui tokens for the relayer to swap with the contract.
        let (sui_coins_for_swap, _) = mint_sui_for_swap<COIN_8>(
            &token_bridge_relayer_state,
            swap_amount,
            8, // COIN_8 decimals.
            scenario
        );
        assert!(coin::value(&sui_coins_for_swap) == 0, 0);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

        // Store created object IDs. Since the swap amount is zero in this test,
        // the native coins object is destroyed and not returned to the relayer.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 1, 0);

        // Balance check the recipient.
        {
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_8>>(scenario);

            // Validate the object's value.
            assert!(coin::value(&token_object) == test_amount, 0);

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_10_maximum_amount() {
        // Test variables.
        let vaa = x"01000000000100acc86233ab83f8dfc51d8024b9eb675ed46bba1a9e9b2db45446287d98e06dcd40a69e4f651e7d6a122aa88a94a2dc7e97750b67d3c4b1925969f3e2577bee01006423bf790000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa58500000000000000000103000000000000000000000000000000000000000000000000028f5c28f5c28f5c0000000000000000000000000000000000000000000000000000000000000001001500000000000000000000000000000000000000000000000000000000000000030015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        // Since amounts are truncated for token bridge transfers for tokens
        // with greater than 8 decimals, we need to subtract 14 from the max
        // u64 amount.
        let test_amount = U64_MAX - 14;
        let swap_amount = 0;

        // Test setup.
        let (recipient, relayer) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 10.
        let (test_coin, test_metadata) = mint_coin_10(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_10>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // NOTE: Switch the context to the relayer for this test.
        test_scenario::next_tx(scenario, relayer);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Mint sui tokens for the relayer to swap with the contract.
        let (sui_coins_for_swap, _) = mint_sui_for_swap<COIN_10>(
            &token_bridge_relayer_state,
            swap_amount,
            10, // COIN_10 decimals.
            scenario
        );
        assert!(coin::value(&sui_coins_for_swap) == 0, 0);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_10>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

        // Store created object IDs. Since the swap amount is zero in this test,
        // the native coins object is destroyed and not returned to the relayer.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 1, 0);

        // Balance check the recipient.
        {
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_10>>(scenario);

            // Validate the object's value.
            assert!(coin::value(&token_object) == test_amount, 0);

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_8_minimum_amount() {
        // Test variables.
        let vaa = x"010000000001000f2f9da9906b2a33d83c0d818d96b3945fbfe5f6ff5f0a7d6148142c240f3b81520704f1c2276254c7057f39e952c3951464d1b5094d9d3ee4bc4aae479eabd701641cd27a0000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa5850000000000000000010300000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001001500000000000000000000000000000000000000000000000000000000000000030015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 1;
        let swap_amount = 0;

        // Test setup.
        let (recipient, relayer) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // NOTE: Switch the context to the relayer for this test.
        test_scenario::next_tx(scenario, relayer);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Mint sui tokens for the relayer to swap with the contract.
        let (sui_coins_for_swap, _) = mint_sui_for_swap<COIN_8>(
            &token_bridge_relayer_state,
            swap_amount,
            8, // COIN_8 decimals.
            scenario
        );
        assert!(coin::value(&sui_coins_for_swap) == 0, 0);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

        // Store created object IDs. Since the swap amount is zero in this test,
        // the native coins object is destroyed and not returned to the relayer.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 1, 0);

        // Balance check the recipient.
        {
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_8>>(scenario);

            // Validate the object's value.
            assert!(coin::value(&token_object) == test_amount, 0);

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_10_minimum_amount() {
        // Test variables.
        let vaa = x"01000000000100ddcb916083cdb2be356f9d06dee98837b153e969e2f08ae69d533917d87b243279c6f5b24d066159289dab47db1b778afa91ace044daaf8d410635f7efa25c12016423c0710000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa5850000000000000000010300000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001001500000000000000000000000000000000000000000000000000000000000000030015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 100;
        let swap_amount = 0;

        // Test setup.
        let (recipient, relayer) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 10.
        let (test_coin, test_metadata) = mint_coin_10(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_10>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // NOTE: Switch the context to the relayer for this test.
        test_scenario::next_tx(scenario, relayer);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Mint sui tokens for the relayer to swap with the contract.
        let (sui_coins_for_swap, _) = mint_sui_for_swap<COIN_10>(
            &token_bridge_relayer_state,
            swap_amount,
            10, // COIN_10 decimals.
            scenario
        );
        assert!(coin::value(&sui_coins_for_swap) == 0, 0);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_10>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

        // Store created object IDs. Since the swap amount is zero in this test,
        // the native coins object is destroyed and not returned to the relayer.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 1, 0);

        // Balance check the recipient.
        {
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_10>>(scenario);

            // Validate the object's value.
            assert!(coin::value(&token_object) == test_amount, 0);

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    /// No relayer fee in this test.
    public fun complete_transfer_with_relay_max_swap_amount_overflow_recovery() {
        // Test variables.
        let vaa = x"010000000001000b5b89fe09b6ce9d0d9772129ea1560c0c2cc34437fb7693e99d46c194d999296ee01e710a82b769bd617335149cea6065821800f1a714e0df60b2bac8c3b5e500641cd2bc0000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa58500000000000000000103000000000000000000000000000000000000000000000000fffffffffffffffe00000000000000000000000000000000000000000000000000000000000000010015000000000000000000000000000000000000000000000000000000000000000300150000000000000000000000000000000000000000000000000000000000000069010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000fffffffffffffffd0000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = U64_MAX;
        let _swap_amount = 18446744073709551613;

        // Test setup.
        let (recipient, relayer) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // Ignore effects.
        test_scenario::next_tx(scenario, recipient);

        // Disable swaps for COIN_8 so the tokens can be recovered. Also
        // increase the max native swap amount to force an overflow.
        {
            let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

            // Disable swaps.
            owner::toggle_swap_enabled<COIN_8>(
                &owner_cap,
                &mut token_bridge_relayer_state,
                false
            );

            owner::update_max_native_swap_amount<COIN_8>(
                &owner_cap,
                &mut token_bridge_relayer_state,
                test_amount
            );

            test_scenario::return_to_sender(scenario, owner_cap);
        };

        // NOTE: Switch the context to the relayer for this test.
        test_scenario::next_tx(scenario, relayer);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Mint SUI for the swap.
        let sui_coins_for_swap = mint_sui(
            0,
            test_scenario::ctx(scenario)
        );

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

        // Store created object IDs. Since the swap amount is zero in this test,
        // the native coins object is destroyed and not returned to the relayer.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 1, 0);

        // Balance check the recipient.
        {
            let token_object =
                test_scenario::take_from_sender<Coin<COIN_8>>(scenario);

            // Validate the object's value.
            assert!(coin::value(&token_object) == test_amount, 0);

            // Bye bye.
            test_scenario::return_to_sender(scenario, token_object);
        };

        // Proceed.
        test_scenario::next_tx(scenario, recipient);

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = redeem::E_UNREGISTERED_COIN)]
    public fun cannot_complete_transfer_with_relay_unregistered_coin() {
        // Test variables.
        let vaa = x"01000000000100550313a786de681c34f12112ffaeff0bb923af7f6898144c9f2fb441c14b77ca6f276fa7b289e9649ccb520da3e274d7e06a767c9153e1977d709623fba32fe901641de07e0000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585000000000000000001030000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000000000000000001001500000000000000000000000000000000000000000000000000000000000000030015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 1000000000000000000;

        // Test setup.
        let (recipient, relayer) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // Ignore effects.
        test_scenario::next_tx(scenario, recipient);

        // Deregister COIN_8 on the token bridge relayer contract.
        {
            let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

            owner::deregister_token<COIN_8>(
                &owner_cap,
                &mut token_bridge_relayer_state,
            );

            test_scenario::return_to_sender(scenario, owner_cap);
        };

        // NOTE: Switch the context to the relayer for this test.
        test_scenario::next_tx(scenario, relayer);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Mint SUI for the swap. We avoid calling the `mint_sui_for_swap`
        // method here to avoid hitting the overflow exception outside
        // of the contract call.
        let sui_coins_for_swap = mint_sui(
            0,
            test_scenario::ctx(scenario)
        );

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        test_scenario::next_tx(scenario, recipient);

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = redeem::E_UNREGISTERED_FOREIGN_CONTRACT)]
    public fun cannot_complete_transfer_with_relay_unknown_sender() {
        // Test variables.
        let vaa = x"0100000000010066394a87b1740aa120175f687fa2cdd1457354388ea1706c74d6316edde311f560f6e2be66fdc16c68727186eab49f08a45df88e1535c47352fca01fcf2cbf3f01641de1f70000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585000000000000000001030000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000000000000000001001500000000000000000000000000000000000000000000000000000000000000030015000000000000000000000000000000000000000000000000000000000000beef01000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 1000000000000000000;

        // Test setup.
        let (recipient, relayer) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // NOTE: Switch the context to the relayer for this test.
        test_scenario::next_tx(scenario, relayer);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Mint SUI for the swap. We avoid calling the `mint_sui_for_swap`
        // method here to avoid hitting the overflow exception outside
        // of the contract call.
        let sui_coins_for_swap = mint_sui(
            0,
            test_scenario::ctx(scenario)
        );

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        test_scenario::next_tx(scenario, recipient);

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = redeem::E_INVALID_CALLER_FOR_ACTION)]
    public fun cannot_complete_transfer_with_relay_invalid_caller() {
        // Test variables.
        let vaa = x"01000000000100550313a786de681c34f12112ffaeff0bb923af7f6898144c9f2fb441c14b77ca6f276fa7b289e9649ccb520da3e274d7e06a767c9153e1977d709623fba32fe901641de07e0000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585000000000000000001030000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000000000000000001001500000000000000000000000000000000000000000000000000000000000000030015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 1000000000000000000;

        // Test setup.
        let (recipient, _) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // NOTE: Do not switch to the relayer for this test.
        test_scenario::next_tx(scenario, recipient);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Mint SUI for the swap. We avoid calling the `mint_sui_for_swap`
        // method here to avoid hitting the overflow exception outside
        // of the contract call.
        let sui_coins_for_swap = mint_sui(
            0,
            test_scenario::ctx(scenario)
        );

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        test_scenario::next_tx(scenario, recipient);

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = redeem::E_INSUFFICIENT_NATIVE_COIN)]
    public fun cannot_complete_transfer_with_relay_coin_8_insufficient_native_amount() {
        // Test variables.
        let vaa = x"010000000001003cc8126c35d8c9245949e6783090657719921d2b6b180fe4c5e21d78ea7e75784042e0b5e02e212f59dee454c929ab426fe19b1141d2afd136599a999dd9326d00641df20b0000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585000000000000000001030000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000000000000000001001500000000000000000000000000000000000000000000000000000000000000030015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002540be4000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 1000000000000000000;
        let swap_amount = 10000000000;

        // Test setup.
        let (recipient, relayer) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // NOTE: Switch the context to the relayer for this test.
        test_scenario::next_tx(scenario, relayer);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Mint sui tokens for the relayer to swap with the contract. The
        // swap_amount will be overridden if its value is larger than
        // the max allowed swap amount.
        let (expected_sui_coins_for_swap, _) = mint_sui_for_swap<COIN_8>(
            &token_bridge_relayer_state,
            swap_amount,
            8, // COIN_8 decimals.
            scenario
        );
        let sui_coin_value = coin::value(&expected_sui_coins_for_swap);

        // Instead of sending the full amount of sui coins to the contract,
        // we split the object and only send half. The transaction will revert
        // since the relayer "underpriced" the swap.
        let actual_sui_coins_for_swap = coin::split(
            &mut expected_sui_coins_for_swap,
            sui_coin_value / 2,
            test_scenario::ctx(scenario)
        );

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            actual_sui_coins_for_swap,
            test_scenario::ctx(scenario)
        );

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);
        native_transfer::transfer(expected_sui_coins_for_swap, @0x0);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = redeem::E_INSUFFICIENT_NATIVE_COIN)]
    public fun cannot_complete_transfer_with_relay_coin_10_insufficient_native_amount() {
        // Test variables.
        let vaa = x"01000000000100965572b12a481dfb02b85e0418304c6d8e82f90eb397548c651c9c650caaa9c765d5d3893247a336d8a40d52f078e321d0a32c40b27e5cba3a2aa6286b1ef80900642442290000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa5850000000000000000010300000000000000000000000000000000000000000000000000005af3107a40000000000000000000000000000000000000000000000000000000000000000001001500000000000000000000000000000000000000000000000000000000000000030015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f42400000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 10000000000000000;
        let swap_amount = 100000000;

        // Test setup.
        let (recipient, relayer) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 10.
        let (test_coin, test_metadata) = mint_coin_10(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_10>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // NOTE: Switch the context to the relayer for this test.
        test_scenario::next_tx(scenario, relayer);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Mint sui tokens for the relayer to swap with the contract. The
        // swap_amount will be overridden if its value is larger than
        // the max allowed swap amount.
        let (expected_sui_coins_for_swap, _) = mint_sui_for_swap<COIN_10>(
            &token_bridge_relayer_state,
            swap_amount,
            10, // COIN_10 decimals.
            scenario
        );
        let sui_coin_value = coin::value(&expected_sui_coins_for_swap);

        // Instead of sending the full amount of sui coins to the contract,
        // we split the object and only send half. The transaction will revert
        // since the relayer "underpriced" the swap.
        let actual_sui_coins_for_swap = coin::split(
            &mut expected_sui_coins_for_swap,
            sui_coin_value / 2,
            test_scenario::ctx(scenario)
        );

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_10>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            actual_sui_coins_for_swap,
            test_scenario::ctx(scenario)
        );

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);
        native_transfer::transfer(expected_sui_coins_for_swap, @0x0);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = redeem::E_SWAP_IN_OVERFLOW)]
    public fun cannot_complete_transfer_with_relay_max_swap_amount_overflow() {
        // Test variables.
        let vaa = x"010000000001000b5b89fe09b6ce9d0d9772129ea1560c0c2cc34437fb7693e99d46c194d999296ee01e710a82b769bd617335149cea6065821800f1a714e0df60b2bac8c3b5e500641cd2bc0000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa58500000000000000000103000000000000000000000000000000000000000000000000fffffffffffffffe00000000000000000000000000000000000000000000000000000000000000010015000000000000000000000000000000000000000000000000000000000000000300150000000000000000000000000000000000000000000000000000000000000069010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000fffffffffffffffd0000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = U64_MAX;
        let _swap_amount = 18446744073709551613;

        // Test setup.
        let (recipient, relayer) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            test_amount,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // Ignore effects.
        test_scenario::next_tx(scenario, recipient);

        // Set the max native swap amount to max(uint64).
        {
            // Fetch necessary objects.
            let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

            owner::update_max_native_swap_amount<COIN_8>(
                &owner_cap,
                &mut token_bridge_relayer_state,
                test_amount
            );

            test_scenario::return_to_sender(scenario, owner_cap);
        };

        // NOTE: Switch the context to the relayer for this test.
        test_scenario::next_tx(scenario, relayer);

        // Deposit tokens into the bridge.
        bridge_state::deposit_test_only(&mut bridge_state, test_coin);

        // Mint SUI for the swap. We avoid calling the `mint_sui_for_swap`
        // method here to avoid hitting the overflow exception outside
        // of the contract call.
        let sui_coins_for_swap = mint_sui(
            0,
            test_scenario::ctx(scenario)
        );

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            test_scenario::ctx(scenario)
        );

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun calculate_max_swap_amount_in_coin_8() {
        // Test setup.
        let (recipient, _) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            0,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // Ignore effects.
        test_scenario::next_tx(scenario, recipient);

        // Store the owner cap.
        let owner_cap =
            test_scenario::take_from_sender<OwnerCap>(scenario);

        // With test defaults.
        {
            let actual_amount = redeem::calculate_max_swap_amount_in<COIN_8>(
                &token_bridge_relayer_state,
                8 // Coin decimals.
            );
            assert!(actual_amount == 2000000000, 0);
        };

        // Decrease the native swap rate (by reducing SUI's swap rate).
        {
            // New Swap rate.
            let sui_swap_rate = 100000000; // 1 USD.

            // Update the SUI swap rate.
            owner::update_swap_rate<SUI>(
                &owner_cap,
                &mut token_bridge_relayer_state,
                sui_swap_rate
            );

            // Compute the max swap amount in.
            let actual_amount = redeem::calculate_max_swap_amount_in<COIN_8>(
                &token_bridge_relayer_state,
                8 // Coin decimals.
            );
            assert!(actual_amount == 100000000, 0);
        };

        // Increasae max native swap amount.
        {
            let new_max_amount = TEST_INITIAL_MAX_SWAP_AMOUNT * 5;

            // Update the SUI swap rate.
            owner::update_max_native_swap_amount<COIN_8>(
                &owner_cap,
                &mut token_bridge_relayer_state,
                new_max_amount
            );

            // Compute the max swap amount in.
            let actual_amount = redeem::calculate_max_swap_amount_in<COIN_8>(
                &token_bridge_relayer_state,
                8 // Coin decimals.
            );
            assert!(actual_amount == 500000000, 0);
        };

        // Decrease the max swap amount to zero.
        {
            // Update the SUI swap rate.
            owner::update_max_native_swap_amount<COIN_8>(
                &owner_cap,
                &mut token_bridge_relayer_state,
                0
            );

            // Compute the max swap amount in.
            let actual_amount = redeem::calculate_max_swap_amount_in<COIN_8>(
                &token_bridge_relayer_state,
                8 // Coin decimals.
            );
            assert!(actual_amount == 0, 0);
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);
        test_scenario::return_to_sender(scenario, owner_cap);
        native_transfer::transfer(test_coin, @0x0);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun calculate_max_swap_amount_in_coin_10() {
        // Test setup.
        let (recipient, _) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_10(
            0,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_10>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // Ignore effects.
        test_scenario::next_tx(scenario, recipient);

        // Store the owner cap.
        let owner_cap =
            test_scenario::take_from_sender<OwnerCap>(scenario);

        // With test defaults.
        {
            let actual_amount = redeem::calculate_max_swap_amount_in<COIN_10>(
                &token_bridge_relayer_state,
                10 // Coin decimals.
            );
            assert!(actual_amount == 200000000000, 0);
        };

        // Decrease the native swap rate (by reducing SUI's swap rate).
        {
            // New Swap rate.
            let sui_swap_rate = 100000000; // 1 USD.

            // Update the SUI swap rate.
            owner::update_swap_rate<SUI>(
                &owner_cap,
                &mut token_bridge_relayer_state,
                sui_swap_rate
            );

            // Compute the max swap amount in.
            let actual_amount = redeem::calculate_max_swap_amount_in<COIN_10>(
                &token_bridge_relayer_state,
                10 // Coin decimals.
            );
            assert!(actual_amount == 10000000000, 0);
        };

        // Increasae max native swap amount.
        {
            let new_max_amount = TEST_INITIAL_MAX_SWAP_AMOUNT * 5;

            // Update the SUI swap rate.
            owner::update_max_native_swap_amount<COIN_10>(
                &owner_cap,
                &mut token_bridge_relayer_state,
                new_max_amount
            );

            // Compute the max swap amount in.
            let actual_amount = redeem::calculate_max_swap_amount_in<COIN_10>(
                &token_bridge_relayer_state,
                10 // Coin decimals.
            );
            assert!(actual_amount == 50000000000, 0);
        };

        // Decrease the max swap amount to zero.
        {
            // Update the SUI swap rate.
            owner::update_max_native_swap_amount<COIN_10>(
                &owner_cap,
                &mut token_bridge_relayer_state,
                0
            );

            // Compute the max swap amount in.
            let actual_amount = redeem::calculate_max_swap_amount_in<COIN_10>(
                &token_bridge_relayer_state,
                10 // Coin decimals.
            );
            assert!(actual_amount == 0, 0);
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);
        test_scenario::return_to_sender(scenario, owner_cap);
        native_transfer::transfer(test_coin, @0x0);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun calculate_native_swap_amount_out_coin_8() {
        // Test setup.
        let (recipient, _) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            0,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // Ignore effects.
        test_scenario::next_tx(scenario, recipient);

        // Store the owner cap.
        let owner_cap =
            test_scenario::take_from_sender<OwnerCap>(scenario);

        // With test defaults.
        {
            let to_native_amount = 10000000000;

            let actual_amount = redeem::calculate_native_swap_amount_out<COIN_8>(
                &token_bridge_relayer_state,
                to_native_amount,
                8 // Coin decimals.
            );
            assert!(actual_amount == 5000000000, 0);
        };

        // Minimum to native token amount. The result is zero due to the move
        // compile rounding towards zero (similar to solidity).
        {
            let to_native_amount = 1;

            let actual_amount = redeem::calculate_native_swap_amount_out<COIN_8>(
                &token_bridge_relayer_state,
                to_native_amount,
                8 // Coin decimals.
            );
            assert!(actual_amount == 0, 0);
        };

        // With test defaults, large quantity.
        {
            let to_native_amount = 694200000000000;

            let actual_amount = redeem::calculate_native_swap_amount_out<COIN_8>(
                &token_bridge_relayer_state,
                to_native_amount,
                8 // Coin decimals.
            );
            assert!(actual_amount == 347100000000000, 0);
        };

        // Set the minimum token amount to zero. This path will not execute
        // from intra-contract calls, but could potentially be called
        // externally.
        {
            let to_native_amount = 0;

            let actual_amount = redeem::calculate_native_swap_amount_out<COIN_8>(
                &token_bridge_relayer_state,
                to_native_amount,
                8 // Coin decimals.
            );
            assert!(actual_amount == 0, 0);
        };

        // Decrease the native swap rate (by reducing SUI's swap rate).
        {
            // New Swap rate.
            let sui_swap_rate = 6942000000000; // 69420 USD.

            // Update the SUI swap rate.
            owner::update_swap_rate<SUI>(
                &owner_cap,
                &mut token_bridge_relayer_state,
                sui_swap_rate
            );

            // Amount to swap.
            let to_native_amount = 10000000000;

            let actual_amount = redeem::calculate_native_swap_amount_out<COIN_8>(
                &token_bridge_relayer_state,
                to_native_amount,
                8 // Coin decimals.
            );
            assert!(actual_amount == 1440507, 0);
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);
        test_scenario::return_to_sender(scenario, owner_cap);
        native_transfer::transfer(test_coin, @0x0);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun calculate_native_swap_amount_out_coin_10() {
        // Test setup.
        let (recipient, _) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 10.
        let (test_coin, test_metadata) = mint_coin_10(
            0,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_10>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // Ignore effects.
        test_scenario::next_tx(scenario, recipient);

        // Store the owner cap.
        let owner_cap =
            test_scenario::take_from_sender<OwnerCap>(scenario);

        // With test defaults.
        {
            let to_native_amount = 10000000000;

            let actual_amount = redeem::calculate_native_swap_amount_out<COIN_10>(
                &token_bridge_relayer_state,
                to_native_amount,
                10 // Coin decimals.
            );
            assert!(actual_amount == 50000000, 0);
        };

        // Minimum to native token amount. The result is zero due to the move
        // compile rounding towards zero (similar to solidity).
        {
            let to_native_amount = 1;

            let actual_amount = redeem::calculate_native_swap_amount_out<COIN_10>(
                &token_bridge_relayer_state,
                to_native_amount,
                10 // Coin decimals.
            );
            assert!(actual_amount == 0, 0);
        };

        // With test defaults, large quantity.
        {
            let to_native_amount = 694200000000000;

            let actual_amount = redeem::calculate_native_swap_amount_out<COIN_10>(
                &token_bridge_relayer_state,
                to_native_amount,
                10 // Coin decimals.
            );
            assert!(actual_amount == 3471000000000, 0);
        };

        // Set the minimum token amount to zero. This path will not execute
        // from intra-contract calls, but could potentially be called
        // externally.
        {
            let to_native_amount = 0;

            let actual_amount = redeem::calculate_native_swap_amount_out<COIN_10>(
                &token_bridge_relayer_state,
                to_native_amount,
                10 // Coin decimals.
            );
            assert!(actual_amount == 0, 0);
        };

        // Decrease the native swap rate (by reducing SUI's swap rate).
        {
            // New Swap rate.
            let sui_swap_rate = 6942000000000; // 69420 USD.

            // Update the SUI swap rate.
            owner::update_swap_rate<SUI>(
                &owner_cap,
                &mut token_bridge_relayer_state,
                sui_swap_rate
            );

            // Amount to swap.
            let to_native_amount = 10000000000;

            let actual_amount = redeem::calculate_native_swap_amount_out<COIN_10>(
                &token_bridge_relayer_state,
                to_native_amount,
                10 // Coin decimals.
            );
            assert!(actual_amount == 14405, 0);
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);
        test_scenario::return_to_sender(scenario, owner_cap);
        native_transfer::transfer(test_coin, @0x0);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = redeem::E_SWAP_OUT_OVERFLOW)]
    public fun cannot_calculate_native_swap_amount_out_overflow_check() {
        // Test setup.
        let (recipient, _) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            0,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // Ignore effects.
        test_scenario::next_tx(scenario, recipient);

        // Store the owner cap.
        let owner_cap =
            test_scenario::take_from_sender<OwnerCap>(scenario);

        // Cause overflow.
        {
            // Update the Sui swap rate to cause an overflow.
            owner::update_swap_rate<SUI>(
                &owner_cap,
                &mut token_bridge_relayer_state,
                100000000
            );

            // Attempt to calculate the swap amount.
            redeem::calculate_native_swap_amount_out<COIN_8>(
                &token_bridge_relayer_state,
                U64_MAX,
                8 // Coin decimals.
            );
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);
        test_scenario::return_to_sender(scenario, owner_cap);
        native_transfer::transfer(test_coin, @0x0);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun calculate_native_swap_rate() {
        // Test setup.
        let (recipient, _) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            0,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // Ignore effects.
        test_scenario::next_tx(scenario, recipient);

        // Store the owner cap.
        let owner_cap =
            test_scenario::take_from_sender<OwnerCap>(scenario);

        // Calculate the native swap rate with the test defaults.
        {
            let native_swap_rate =
                token_bridge_relayer::state::native_swap_rate<COIN_8>(
                    &token_bridge_relayer_state
                );
            assert!(native_swap_rate == 2000000000, 0);
        };

        // Calculate the native swap rate with the test defaults.
        {
            let native_swap_rate =
                token_bridge_relayer::state::native_swap_rate<COIN_8>(
                    &token_bridge_relayer_state
                );
            assert!(native_swap_rate == 2000000000, 0);
        };

        // Increase the Sui swap rate.
        {
            owner::update_swap_rate<SUI>(
                &owner_cap,
                &mut token_bridge_relayer_state,
                6942000000000
            );

            let native_swap_rate =
                token_bridge_relayer::state::native_swap_rate<COIN_8>(
                    &token_bridge_relayer_state
                );
            assert!(native_swap_rate == 6942000000000, 0);
        };

        // Increase the COIN_8 swap rate.
        {
            owner::update_swap_rate<COIN_8>(
                &owner_cap,
                &mut token_bridge_relayer_state,
                6900000000
            );

            let native_swap_rate =
                token_bridge_relayer::state::native_swap_rate<COIN_8>(
                    &token_bridge_relayer_state
                );
            assert!(native_swap_rate == 100608695652, 0);
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);
        test_scenario::return_to_sender(scenario, owner_cap);
        native_transfer::transfer(test_coin, @0x0);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = token_bridge_relayer::state::E_INVALID_NATIVE_SWAP_RATE)]
    public fun cannot_calculate_native_swap_rate_overflow() {
        // Test setup.
        let (recipient, _) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            0,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // Ignore effects.
        test_scenario::next_tx(scenario, recipient);

        // Store the owner cap.
        let owner_cap =
            test_scenario::take_from_sender<OwnerCap>(scenario);

        // Increase the Sui swap rate and decrease the COIN_8 swap rate to
        // cause an overflow.
        {
            // Increase the SUI swap rate.
            owner::update_swap_rate<SUI>(
                &owner_cap,
                &mut token_bridge_relayer_state,
                U64_MAX
            );

            // Decrease the COIN_8 swap rate.
            owner::update_swap_rate<COIN_8>(
                &owner_cap,
                &mut token_bridge_relayer_state,
                1
            );

            token_bridge_relayer::state::native_swap_rate<COIN_8>(
                &token_bridge_relayer_state
            );
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);
        test_scenario::return_to_sender(scenario, owner_cap);
        native_transfer::transfer(test_coin, @0x0);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = token_bridge_relayer::state::E_INVALID_NATIVE_SWAP_RATE)]
    public fun cannot_calculate_native_swap_rate_zero() {
        // Test setup.
        let (recipient, _) = init_tests::people();
        let (my_scenario, _) = owner_set_up(recipient);
        let scenario = &mut my_scenario;

        // Fetch state objects.
        let token_bridge_relayer_state =
            test_scenario::take_shared<State>(scenario);
        let bridge_state =
            test_scenario::take_shared<BridgeState>(scenario);
        let wormhole_state =
            test_scenario::take_shared<WormholeState>(scenario);

        // Mint coin 8.
        let (test_coin, test_metadata) = mint_coin_8(
            0,
            test_scenario::ctx(scenario)
        );
        test_scenario::next_tx(scenario, recipient);

        // Set the test up.
        redeem_set_up<COIN_8>(
            &mut token_bridge_relayer_state,
            &mut bridge_state,
            &mut wormhole_state,
            recipient,
            scenario,
            test_metadata
        );

        // Ignore effects.
        test_scenario::next_tx(scenario, recipient);

        // Store the owner cap.
        let owner_cap =
            test_scenario::take_from_sender<OwnerCap>(scenario);

        // Decrease the Sui swap rate and increase the COIN_8 swap rate to
        // cause an overflow.
        {
            // Increase the SUI swap rate.
            owner::update_swap_rate<SUI>(
                &owner_cap,
                &mut token_bridge_relayer_state,
                1
            );

            // Decrease the COIN_8 swap rate.
            owner::update_swap_rate<COIN_8>(
                &owner_cap,
                &mut token_bridge_relayer_state,
                U64_MAX
            );

            token_bridge_relayer::state::native_swap_rate<COIN_8>(
                &token_bridge_relayer_state
            );
        };

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);
        test_scenario::return_to_sender(scenario, owner_cap);
        native_transfer::transfer(test_coin, @0x0);

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

    public fun mint_sui_for_swap<C>(
        token_bridge_relayer_state: &State,
        to_native_token_amount: u64,
        coin_decimals: u8,
        scenario: &mut Scenario
    ): (Coin<SUI>, u64) {
        // Compute the max swap amount in.
        let max_swap_amount_in = redeem::calculate_max_swap_amount_in<C>(
            token_bridge_relayer_state,
            coin_decimals
        );

        // Override the to_native_token_amount if the value is large than the
        // allowed max swap amount.
        if (to_native_token_amount > max_swap_amount_in) {
            to_native_token_amount = max_swap_amount_in
        };

        // Calculate the amount of tokens the relayer has to swap with the
        // contract.
        let swap_quote = redeem::calculate_native_swap_amount_out<C>(
            token_bridge_relayer_state,
            to_native_token_amount,
            coin_decimals
        );

        // Mint SUI for the swap.
        let fee_coin = mint_sui(
            swap_quote,
            test_scenario::ctx(scenario)
        );

        (fee_coin, to_native_token_amount)
    }

    public fun redeem_set_up<C>(
        token_bridge_relayer_state: &mut State,
        bridge_state: &mut BridgeState,
        wormhole_state: &mut WormholeState,
        creator: address,
        scenario: &mut Scenario,
        coin_meta: CoinMetadata<C>
    ): TransactionEffects {
        // Fetch necessary objects.
        let owner_cap =
            test_scenario::take_from_sender<OwnerCap>(scenario);

        // Register a foreign contract.
        {
            owner::register_foreign_contract(
                &owner_cap,
                token_bridge_relayer_state,
                TEST_FOREIGN_EMITTER_CHAIN,
                TEST_FOREIGN_EMITTER_CONTRACT
            );

            test_scenario::next_tx(scenario, creator);
        };

        // Attest token.
        {
            // Attest SUI.
            let fee_coin = mint_sui(
                wormhole_state_module::get_message_fee(wormhole_state),
                test_scenario::ctx(scenario)
            );

            attest_token::attest_token<C>(
                bridge_state,
                wormhole_state,
                &coin_meta,
                fee_coin,
                0, // batch ID
                test_scenario::ctx(scenario)
            );

            // Proceed.
            test_scenario::next_tx(scenario, creator);
            native_transfer::transfer(coin_meta, @0x0);
        };

        // Register each token.
        {
            // Register SUI. Swaps should never be enabled for SUI.
            owner::register_token<SUI>(
                &owner_cap,
                token_bridge_relayer_state,
                TEST_INITIAL_SUI_SWAP_RATE,
                TEST_INITIAL_MAX_SWAP_AMOUNT,
                false
            );

            // Proceed.
            test_scenario::next_tx(scenario, creator);

            // Register passed coin type. Enable swaps by default.
            owner::register_token<C>(
                &owner_cap,
                token_bridge_relayer_state,
                TEST_INITIAL_COIN_SWAP_RATE,
                TEST_INITIAL_MAX_SWAP_AMOUNT,
                true
            );

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Return owner cap.
        test_scenario::return_to_sender(scenario, owner_cap);

        let effects = test_scenario::next_tx(scenario, creator);
        (effects)
    }
}
