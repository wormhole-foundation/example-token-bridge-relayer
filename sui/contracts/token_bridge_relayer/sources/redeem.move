module token_bridge_relayer::redeem {
    // Sui dependencies.
    use sui::sui::SUI;
    use sui::coin::{Self, Coin};
    use sui::math::{Self};
    use sui::clock::{Clock};
    use sui::transfer::{Self};
    use sui::tx_context::{Self, TxContext};

    // Token Bridge dependencies.
    use token_bridge::state::{Self as bridge_state, State as TokenBridgeState};
    use token_bridge::complete_transfer_with_payload::{Self as bridge};
    use token_bridge::transfer_with_payload::{Self, TransferWithPayload};
    use token_bridge::normalized_amount::{Self};

    // Wormhole dependencies.
    use wormhole::external_address::{Self};
    use wormhole::state::{State as WormholeState};

    // Token Bridge Relayer modules.
    use token_bridge_relayer::message::{Self};
    use token_bridge_relayer::state::{Self as relayer_state, State};

    /// Errors.
    const E_UNREGISTERED_FOREIGN_CONTRACT: u64 = 0;
    const E_UNREGISTERED_COIN: u64 = 1;
    const E_INVALID_CALLER_FOR_ACTION: u64 = 2;
    const E_INSUFFICIENT_NATIVE_COIN: u64 = 3;
    const E_SWAP_IN_OVERFLOW: u64 = 4;
    const E_SWAP_OUT_OVERFLOW: u64 = 5;

    /// Max U64 const.
    const U64_MAX: u64 = 18446744073709551614;

    /// `complete_transfer` calls Wormhole's Token Bridge contract to complete
    /// token transfers. It parses the encoded `TransferWithRelay` message
    /// and sends tokens to the encoded `recipient`.
    ///
    /// This method will revert if the caller is not the `recipient` and should
    /// only be used for self redeeming transfer VAAs.
    public entry fun complete_transfer<C>(
        t_state: &State,
        wormhole_state: &mut WormholeState,
        token_bridge_state: &mut TokenBridgeState,
        vaa: vector<u8>,
        the_clock: &Clock,
        ctx: &mut TxContext
    ) {
        // Complete the transfer on the Token Bridge. This call returns the
        // coin object for the amount transferred via the Token Bridge. It
        // also returns the chain ID of the message sender.
        let (balance, transfer_payload, emitter_chain_id) =
            bridge::complete_transfer_with_payload<C>(
                token_bridge_state,
                relayer_state::emitter_cap(t_state),
                wormhole_state,
                vaa,
                the_clock
            );

        // Verify that the token is accepted by this contract and that
        // the sender of the Wormhole message is a trusted contract.
        let (is_valid, reason) = verify_transfer<C>(
            t_state,
            emitter_chain_id,
            &transfer_payload
        );
        assert!(is_valid, reason);

        // Decode the `TransferWithRelay` message.
        let relay_msg = message::deserialize(
            transfer_with_payload::payload(&transfer_payload)
        );

        // Fetch the `recipient` address and verify that the caller is the
        // recipient.
        let recipient = external_address::to_address(
            message::recipient(&relay_msg)
        );
        assert!(
            recipient == tx_context::sender(ctx),
            E_INVALID_CALLER_FOR_ACTION
        );

        // Send the tokens to the recipient.
        transfer::public_transfer(
            coin::from_balance(balance, ctx),
            recipient
        );
    }

    /// `complete_transfer_with_relay` calls Wormhole's Token Bridge contract
    /// to complete token transfers. It parses the encoded `TransferWithRelay`
    /// message and sends tokens to the encoded `recipient`. If a `relayer_fee`
    /// is specified in the payload (it's nonzero) the contract will pay the
    /// relayer. If a `to_native_token_amount` is specified in the payload
    /// (it's nonzero) the contract will execute a native swap with the
    /// off-chain relayer to drop the `recipient` off with native gas (SUI).
    ///
    /// This method will revert if the caller is the `recipient` and is intended
    /// to be called by relayers only.
    public entry fun complete_transfer_with_relay<C>(
        t_state: &State,
        wormhole_state: &mut WormholeState,
        token_bridge_state: &mut TokenBridgeState,
        vaa: vector<u8>,
        native_coins: Coin<SUI>,
        the_clock: &Clock,
        ctx: &mut TxContext
     ) {
        // Complete the transfer on the Token Bridge. This call returns the
        // coin object for the amount transferred via the Token Bridge. It
        // also returns the chain ID of the message sender.
        let (balance, transfer_payload, emitter_chain_id) =
            bridge::complete_transfer_with_payload<C>(
                token_bridge_state,
                relayer_state::emitter_cap(t_state),
                wormhole_state,
                vaa,
                the_clock
            );

        // Convert the balance to a Coin object.
        let coins = coin::from_balance(balance, ctx);

        // Verify that the token is accepted by this contract and that
        // the sender of the Wormhole message is a trusted contract.
        let (is_valid, reason) = verify_transfer<C>(
            t_state,
            emitter_chain_id,
            &transfer_payload
        );
        assert!(is_valid, reason);

        // Parse the `TransferWithRelay` message.
        let relay_msg = message::deserialize(
            transfer_with_payload::payload(&transfer_payload)
        );

        // Parse the `recipient` from the transfer with relay message and
        // verify that the caller is not the `recipient`.
        let recipient = external_address::to_address(
            message::recipient(&relay_msg)
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
        // has elected to perform a swap and that a relayer is redeeming
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

    // Getters.

    /// Calculates the max number of tokens the recipient can convert to native
    /// Sui. The max amount of native assets the contract will swap with the
    /// recipient is governed by the `max_native_swap_amount` variable.
    ///
    /// If an overflow occurs, it is very likely that the contract owner
    /// has misconfigured one (or many) of the state variables. The owner
    /// should reconfigure the contract, or disable swaps to complete the
    /// transfer.
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
            relayer_state::native_swap_rate<C>(t_state) as u256);
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
        assert!(
            max_swap_amount_in <= (U64_MAX as u256),
            E_SWAP_IN_OVERFLOW
        );

        // Return.
        (max_swap_amount_in as u64)
    }

    /// Calculates the amount of native Sui that the recipient will receive
    /// for swapping the `to_native_amount` of tokens.
    ///
    /// If an overflow occurs, it is very likely that the contract owner
    /// has misconfigured one (or many) of the state variables. The owner
    /// should reconfigure the contract, or disable swaps to complete the
    /// transfer.
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
        assert!(
            native_swap_amount_out <= (U64_MAX as u256),
            E_SWAP_OUT_OVERFLOW
        );

        // Return.
        (native_swap_amount_out as u64)
    }

    // Internal methods.

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
            transfer::public_transfer(
                coins_for_relayer,
                tx_context::sender(ctx)
            );
        };

        // Send the original coin object to the recipient.
        transfer::public_transfer(coins, recipient);

        // Return any native coins to the relayer.
        if (coin::value(&native_coins) > 0) {
            transfer::public_transfer(
                native_coins,
                tx_context::sender(ctx)
            );
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
        // Calculate the quantity of native tokens to send to the `recipient` in
        // return for the specified `to_native_token_amount`. This method will
        // override the `to_native_token_amount` if the specified amount is too
        // large too swap (based on the `max_to_native_amount` for the token).
        let (native_amount_for_recipient, to_native_token_amount) =
            calculate_native_amount_for_recipient<C>(
                t_state,
                to_native_token_amount,
                decimals
            );

        // Perform the swap is the `native_amount_for_recipient` is nonzero.
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

            // The amount of transferred coins to send the recipient after
            // accounting for the swap.
            let native_coins_for_recipient;

            if (relayer_refund > 0) {
                native_coins_for_recipient = coin::split(
                    &mut native_coins,
                    native_coin_value - relayer_refund,
                    ctx
                );

                // Return the refund amount to the relayer.
                transfer::public_transfer(
                    native_coins,
                    tx_context::sender(ctx)
                );
            } else {
                native_coins_for_recipient = native_coins;
            };

            // Send the native coins to the `recipient`.
            transfer::public_transfer(native_coins_for_recipient, recipient);
        } else {
            // Set the `to_native_token_amount` to zero since the
            // `native_amount_for_recipient` is zero and no swap will occur.
            to_native_token_amount = 0;

            // Return the `native_coins` object to the relayer.
            transfer::public_transfer(native_coins, tx_context::sender(ctx));
        };

        // Compute the amount of transferred tokens to send to the relayer.
        let amount_for_relayer = relayer_fee + to_native_token_amount;

        // Split the coin object based on the amounts for the relayer and
        // `recipient`.
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
            transfer::public_transfer(coins, tx_context::sender(ctx));
        } else {
            coins_for_recipient = coins;
        };

        // Finally pay the recipient the transferred tokens.
        transfer::public_transfer(coins_for_recipient, recipient);
    }

    fun calculate_native_amount_for_recipient<C>(
        t_state: &State,
        to_native_token_amount: u64,
        decimals: u8
    ): (u64, u64) {
        if (to_native_token_amount > 0) {
            // Compute the max amount of tokens the `recipient` can swap.
            // Override the `to_native_token_amount` if its value is larger
            // than the `max_swap_amount`.
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
}

#[test_only]
module token_bridge_relayer::complete_transfer_tests {
    use std::vector;

    // Sui dependencies.
    use sui::sui::SUI;
    use sui::test_scenario::{Self, Scenario, TransactionEffects};
    use sui::coin::{Self, Coin, CoinMetadata};
    use sui::transfer::{Self as native_transfer};
    use sui::tx_context::{TxContext};

    // Token Bridge dependencies.
    use token_bridge::token_bridge_scenario::{Self};
    use token_bridge::state::{State as BridgeState};
    use token_bridge::attest_token::{Self};

    // Wormhole.
    use wormhole::state::{
        Self as wormhole_state_module,
        State as WormholeState
    };

    // Token Bridge Relayer modules.
    use token_bridge_relayer::owner::{Self, OwnerCap};
    use token_bridge_relayer::state::{State};
    use token_bridge_relayer::init_tests::{Self, set_up as owner_set_up};
    use token_bridge_relayer::redeem::{Self};

    // Example coins.
    use example_coins::coin_8::{Self, COIN_8};
    use example_coins::coin_10::{Self, COIN_10};

    /// Test consts.
    const TEST_FOREIGN_EMITTER_CHAIN: u16 = 2;
    const TEST_FOREIGN_EMITTER_CONTRACT: address =
        @0x0000000000000000000000000000000000000000000000000000000000000069;
    const TEST_INITIAL_SUI_SWAP_RATE: u64 = 2000000000; // $20.
    const TEST_INITIAL_COIN_SWAP_RATE: u64 = 100000000; // $1.
    const TEST_INITIAL_MAX_SWAP_AMOUNT: u64 = 1000000000; // 10 SUI.
    const U64_MAX: u64 = 18446744073709551614;

    #[test]
    public fun complete_transfer() {
        // Test variables.
        let vaa = x"0100000000010040d2baf562134e0131bc91aedbb10cdf34c66b950870ab3bea5130a1c844518a1193241366a11bd25239627d2858c5febba6169a0b25cdc7a990b4a643e2e272016425eac00000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa5850000000000000000010300000000000000000000000000000000000000000000000000038d7ea4c68000e4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a070015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 1000000000000000;

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

        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_8>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, recipient);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            &the_clock,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

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
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_minimum_amount() {
        // Test variables.
        let vaa = x"01000000000100e3f809f11f0b89468d9903e417e2141fca530e4c4647a4cef0b5347160c4fcf87e405d4d4e7129efdb2b1f5a5dbc766d95b059f48412efcab128db411ba80c23006425eb330000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585000000000000000001030000000000000000000000000000000000000000000000000000000000000001e4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a070015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 1;

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

        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_8>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, recipient);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            &the_clock,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

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
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_maximum_amount() {
        // Test variables.
        let vaa = x"0100000000010005f6332b5352b67eda5342c30d759a44e99f6140e60708b407ad2e0b5e3aeae57d37c997079f2a698a937f7c93d2fb72ce107e9d1d604e676ef2ba83b4168e5b006425f0d80000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa58500000000000000000103000000000000000000000000000000000000000000000000fffffffffffffffee4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a070015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = U64_MAX;

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

        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_8>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, recipient);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            &the_clock,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

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
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = redeem::E_UNREGISTERED_COIN)]
    public fun cannot_complete_transfer_unregistered_coin() {
        // Test variables.
        let vaa = x"010000000001006f8b9f5d82362d75e6a442b4a38ba79bf81610118219bfd8db39b0cf1df4f8a2282845e8061e2db8a57cc466f7f85e1e8650070e07b1868ee0d28b0882cfb0ef016425f7a00000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa5850000000000000000010300000000000000000000000000000000000000000000000000038d7ea4c68000e4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a070015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 1000000000000000;

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

        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_8>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, recipient);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

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

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            &the_clock,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        test_scenario::next_tx(scenario, recipient);

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = redeem::E_UNREGISTERED_FOREIGN_CONTRACT)]
    public fun cannot_complete_transfer_unknown_sender() {
        // Test variables.
        let vaa = x"01000000000100617a916a5d74838d014e005b63b5216c9f127bba17badc7424a7f52530630a740ce3eb21193fec127732012561ac9b70494e3ceeebdf858fe8a365e4f4e4824c016425f8200000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa5850000000000000000010300000000000000000000000000000000000000000000000000038d7ea4c68000e4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a070015000000000000000000000000000000000000000000000000000000000000004201000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
        let test_amount = 1000000000000000;

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

        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_8>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, recipient);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            &the_clock,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        test_scenario::next_tx(scenario, recipient);

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = redeem::E_INVALID_CALLER_FOR_ACTION)]
    public fun cannot_complete_transfer_invalid_caller() {
        // Test variables.
        let vaa = x"010000000001006f8b9f5d82362d75e6a442b4a38ba79bf81610118219bfd8db39b0cf1df4f8a2282845e8061e2db8a57cc466f7f85e1e8650070e07b1868ee0d28b0882cfb0ef016425f7a00000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa5850000000000000000010300000000000000000000000000000000000000000000000000038d7ea4c68000e4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a070015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
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

        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_8>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, recipient);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // NOTE: Switch the context to the relayer for this test.
        test_scenario::next_tx(scenario, relayer);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            &the_clock,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        test_scenario::next_tx(scenario, recipient);

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_8_no_swap_no_fee() {
        // Test variables.
        let vaa = x"010000000001006f8b9f5d82362d75e6a442b4a38ba79bf81610118219bfd8db39b0cf1df4f8a2282845e8061e2db8a57cc466f7f85e1e8650070e07b1868ee0d28b0882cfb0ef016425f7a00000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa5850000000000000000010300000000000000000000000000000000000000000000000000038d7ea4c68000e4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a070015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
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

        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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
        token_bridge_scenario::deposit_native<COIN_8>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, relayer);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

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
            &the_clock,
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
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_10_no_swap_no_fee() {
        // Test variables.
        let vaa = x"0100000000010053d0f91a25d439afff32b2014d7f709130da7e8d1e89b448a6249e115e34ad714d2923a9f4fa1b5184943bcdb2e0140bd51c8a28789bb7bb21ecdd78078cd7f2016425fa550000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa5850000000000000000010300000000000000000000000000000000000000000000000000038d7ea4c68000e4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a070015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
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

        // Fetch the coin 10 metadata.
        let test_metadata = get_coin_10_metadata(
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

        // Mint sui tokens for the relayer to swap with the contract.
        let (sui_coins_for_swap, _) = mint_sui_for_swap<COIN_10>(
            &token_bridge_relayer_state,
            swap_amount,
            10, // COIN_10 decimals.
            scenario
        );
        assert!(coin::value(&sui_coins_for_swap) == 0, 0);

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_10>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, relayer);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_10>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            &the_clock,
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
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_8_no_swap_with_fee() {
        // Test variables.
        let vaa = x"010000000001000701eacae6a19f20c10eff5468ee4865367428e79d983640569bccf068bfcd3712ee06d6fa1f0204b6529ba24ba101baea52878db66c9225249877bcb0dc6910016425fc930000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa5850000000000000000010300000000000000000000000000000000000000000000000000038d7ea4c68000e4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a07001500000000000000000000000000000000000000000000000000000000000000690100000000000000000000000000000000000000000000000000000002540be40000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
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

        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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

        // Mint sui tokens for the relayer to swap with the contract.
        let (sui_coins_for_swap, _) = mint_sui_for_swap<COIN_8>(
            &token_bridge_relayer_state,
            swap_amount,
            8, // COIN_8 decimals.
            scenario
        );
        assert!(coin::value(&sui_coins_for_swap) == 0, 0);

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_8>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, relayer);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            &the_clock,
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
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_10_no_swap_with_fee() {
        // Test variables.
        let vaa = x"01000000000100ae721a91e717f5875203e70ad24f72d44f2ddec644f0db1af42cc5a86ce7c2793a0ab664bd8b89bd121d26cdd2f9dbbb72cb80bda6f83b2d5ecdf1fc086c2464006425fd110000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa5850000000000000000010300000000000000000000000000000000000000000000000000038d7ea4c68000e4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a07001500000000000000000000000000000000000000000000000000000000000000690100000000000000000000000000000000000000000000000000000002540be40000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
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

        // Fetch the coin 10 metadata.
        let test_metadata = get_coin_10_metadata(
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

        // Mint sui tokens for the relayer to swap with the contract.
        let (sui_coins_for_swap, _) = mint_sui_for_swap<COIN_10>(
            &token_bridge_relayer_state,
            swap_amount,
            10, // COIN_10 decimals.
            scenario
        );
        assert!(coin::value(&sui_coins_for_swap) == 0, 0);

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_10>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, relayer);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_10>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            &the_clock,
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
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_8_with_swap_and_fee() {
        // Test variables.
        let vaa = x"01000000000100f9200b84a713acd26a787ab1c2652b037e4649f86f5b53e04712947fb1e4e62d7420e6f1c2083ef48f7639d56dacff9e4f0e87bf8e8bbf551ca1d8b5543bc293016425fdb00000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585000000000000000001030000000000000000000000000000000000000000000000000011c37937e08000e4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a07001500000000000000000000000000000000000000000000000000000000000000690100000000000000000000000000000000000000000000000000000000000a875000000000000000000000000000000000000000000000000000000000000186a00000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
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

        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_8>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, relayer);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            &the_clock,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

        // Store created object IDs.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 2, 0);

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
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_10_with_swap_and_fee() {
        // Test variables.
        let vaa = x"01000000000100ee57007769f4106400ff6af332609141919b87c09e9950612bd095485909d27c5f6401685416c3f6a14c310fa25d632f3f20401cc799afd2ee57c32441827ea3016425fe450000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585000000000000000001030000000000000000000000000000000000000000000000000011c37937e08000e4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a07001500000000000000000000000000000000000000000000000000000000000000690100000000000000000000000000000000000000000000000000000000000a875000000000000000000000000000000000000000000000000000000000000186a00000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
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

        // Fetch the coin 10 metadata.
        let test_metadata = get_coin_10_metadata(
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

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_10>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, relayer);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_10>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            &the_clock,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

        // Store created object IDs.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 2, 0);

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
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_8_with_swap_no_fee() {
        // Test variables.
        let vaa = x"010000000001004ecd11ef37d383bdb8ca7f3ae8e49636d27ed11fb0a150111d9163f572d25de4300c1bc22e4fefb20c8b8fa7e300e696cb9743195fce9c0f02254cfde0edd046016426069e0000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585000000000000000001030000000000000000000000000000000000000000000000000011c37937e08000e4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a070015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000186a00000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
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

        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_8>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, relayer);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            &the_clock,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

        // Store created object IDs.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 2, 0);

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
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_10_with_swap_no_fee() {
        // Test variables.
        let vaa = x"010000000001006c4d60c7577ce6a0c5345afc35060e99d4475c2eacd5827dea75fe052444cc811473bf83db2e9b9b42c6818c9a7781ae6e78c60fbf0d745de0b36deaa2f1354e01642607970000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585000000000000000001030000000000000000000000000000000000000000000000000011c37937e08000e4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a070015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000186a00000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
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

        // Fetch the coin 10 metadata.
        let test_metadata = get_coin_10_metadata(
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

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_10>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, relayer);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_10>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            &the_clock,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

        // Store created object IDs.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 2, 0);

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
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_8_swap_amount_limit_reached() {
        // Test variables.
        let vaa = x"010000000001002f87cd7dce747bcaacf5cf99f3f44896e69900ea1e656f1d5022dff6fe63a8da1e48685bb96e33d3431c1d3147a028db74f7a348df92eaac7c943214250c647001642607f40000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585000000000000000001030000000000000000000000000000000000000000000000000011c37937e08000e4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a070015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000116886276640000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
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

        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_8>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, relayer);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            &the_clock,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

        // Store created object IDs.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 2, 0);

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
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_10_swap_amount_limit_reached() {
        // Test variables.
        let vaa = x"01000000000100c570ec706eb93b44bc0070cfa9ab1bb0efd3f7c5225ab8019ceda0a611fd612e344c99db2ffcfc35070a465bea36282cfee5ee3becfa6f796b0acd928c95db4501642608540000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585000000000000000001030000000000000000000000000000000000000000000000000011c37937e08000e4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a070015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000116886276640000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
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

        // Fetch the coin 10 metadata.
        let test_metadata = get_coin_10_metadata(
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

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_10>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, relayer);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_10>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            &the_clock,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

        // Store created object IDs.
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 2, 0);

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
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_8_no_swap_no_fee_with_relayer_refund() {
        // Test variables.
        let vaa = x"0100000000010086cf601ebf46fa2f4f5e148c1989a2afbee2de5a7590c510c86d913e3e25c5d658b805a9a038300f86c846a69ee1f2e2bd90c3acd3bfb6db99a8f280e6c3d1fd01642608b20000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa5850000000000000000010300000000000000000000000000000000000000000000000000038d7ea4c68000e4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a070015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
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

        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_8>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, relayer);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            &the_clock,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

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
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_10_no_swap_no_fee_with_relayer_refund() {
        // Test variables.
        let vaa = x"01000000000100a7fb65c240496505f29e1d5a788a5b09022f045209a1cdf5cee4ae10d3830399414d378196a37ca97240b760be6ff12c99b8ee4534c775aebdcc3e1e03d3edf601642609070000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa5850000000000000000010300000000000000000000000000000000000000000000000000038d7ea4c68000e4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a070015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
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

        // Fetch the coin 10 metadata.
        let test_metadata = get_coin_10_metadata(
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

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_10>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, relayer);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_10>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            &the_clock,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        let effects = test_scenario::next_tx(scenario, recipient);

        // Store created object IDs.
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
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_8_with_swap_fee_and_relayer_refund() {
        // Test variables.
        let vaa = x"01000000000100d8c84830ac409d6700f253da892a084fb5c274e11cf6d6b29ee7e2b02b2913e570d7b885026be596a34b2cfd97974d493e66cb755307c7a5b5422dc29ca870ae016426099a0000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585000000000000000001030000000000000000000000000000000000000000000000000de0b6b3a7640000e4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a07001500000000000000000000000000000000000000000000000000000000000000690100000000000000000000000000000000000000000000000000000000000186a000000000000000000000000000000000000000000000000000000000009896800000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
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

        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_8>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, relayer);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            &the_clock,
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
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_10_with_swap_fee_and_relayer_refund() {
        // Test variables.
        let vaa = x"01000000000100017ff198f621fc34af7e98fec6c750c98dbf3865436901296b77371a54e4b1fd18adc54f3541bba0b4eb7f1e9e07179bef8f87a8349d5f6b905310a39afc7190016426e1330000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa58500000000000000000103000000000000000000000000000000000000000000000000002386f26fc10000e4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a07001500000000000000000000000000000000000000000000000000000000000000690100000000000000000000000000000000000000000000000000000000000003e800000000000000000000000000000000000000000000000000000000000186a00000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
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

        // Fetch the coin 10 metadata.
        let test_metadata = get_coin_10_metadata(
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

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_10>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, relayer);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_10>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            &the_clock,
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
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_8_maximum_amount() {
        // Test variables.
        let vaa = x"01000000000100efd41ec7a424159e29a36f33eda196af96f51e20dc685b98f73bc91b0332d48e6a7b4992d2f08490e5851ad39423282c5c36a892596447cd07d783e7ca983bf0016426e2390000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa58500000000000000000103000000000000000000000000000000000000000000000000fffffffffffffffee4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a070015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
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

        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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

        // Mint sui tokens for the relayer to swap with the contract.
        let (sui_coins_for_swap, _) = mint_sui_for_swap<COIN_8>(
            &token_bridge_relayer_state,
            swap_amount,
            8, // COIN_8 decimals.
            scenario
        );
        assert!(coin::value(&sui_coins_for_swap) == 0, 0);

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_8>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, relayer);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            &the_clock,
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
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_10_maximum_amount() {
        // Test variables.
        let vaa = x"010000000001001daee2a59ac06dc67b820f33461c76245a60e0a1b6f93dbdf3a45323f70bb4aa2afd96d057cb19a9f0e0f9f35dd72356d35c494b032450395a80b4e43bdbd693006426e2da0000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa58500000000000000000103000000000000000000000000000000000000000000000000028f5c28f5c28f5ce4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a070015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
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

        // Fetch the coin 10 metadata.
        let test_metadata = get_coin_10_metadata(
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

        // Mint sui tokens for the relayer to swap with the contract.
        let (sui_coins_for_swap, _) = mint_sui_for_swap<COIN_10>(
            &token_bridge_relayer_state,
            swap_amount,
            10, // COIN_10 decimals.
            scenario
        );
        assert!(coin::value(&sui_coins_for_swap) == 0, 0);

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_10>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, relayer);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_10>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            &the_clock,
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
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_8_minimum_amount() {
        // Test variables.
        let vaa = x"0100000000010013e6671712c51a4ae6a5247a2aa256620fa7d4f0a96c0dc1f2cd53ac7234f2713aeaae54f5ad0a9520133c45959a6943eb2541550a3ffa005b964530b3bef569006426e3290000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585000000000000000001030000000000000000000000000000000000000000000000000000000000000001e4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a070015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
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

        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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

        // Mint sui tokens for the relayer to swap with the contract.
        let (sui_coins_for_swap, _) = mint_sui_for_swap<COIN_8>(
            &token_bridge_relayer_state,
            swap_amount,
            8, // COIN_8 decimals.
            scenario
        );
        assert!(coin::value(&sui_coins_for_swap) == 0, 0);

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_8>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, relayer);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            &the_clock,
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
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun complete_transfer_with_relay_coin_10_minimum_amount() {
        // Test variables.
        let vaa = x"0100000000010065a9ab2c1a6e6b378babc706eef8f0ec0b6206ce0aacab1785e45290c29f9a023281bb4a55129cb9a45245655565cf35809f6712d012f3d4338c1f3fd4946757006426e3950000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585000000000000000001030000000000000000000000000000000000000000000000000000000000000001e4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a070015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
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

        // Fetch the coin 10 metadata.
        let test_metadata = get_coin_10_metadata(
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

        // Mint sui tokens for the relayer to swap with the contract.
        let (sui_coins_for_swap, _) = mint_sui_for_swap<COIN_10>(
            &token_bridge_relayer_state,
            swap_amount,
            10, // COIN_10 decimals.
            scenario
        );
        assert!(coin::value(&sui_coins_for_swap) == 0, 0);

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_10>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, relayer);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_10>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            &the_clock,
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
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    /// No relayer fee in this test.
    public fun complete_transfer_with_relay_max_swap_amount_overflow_recovery() {
        // Test variables.
        let vaa = x"01000000000100c64cb15dc24b25f0197973cfdbcb2471badd6081244f62b7623d1af02c246b1148d5a3f43243e5babebc067874411ef5a4580d3f349481b15496c3d3923ef44c006426e4000000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa58500000000000000000103000000000000000000000000000000000000000000000000fffffffffffffffee4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a0700150000000000000000000000000000000000000000000000000000000000000069010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000fffffffffffffffd0000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
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

        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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

        // Mint SUI for the swap.
        let sui_coins_for_swap = mint_sui(
            0,
            test_scenario::ctx(scenario)
        );

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_8>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, relayer);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            &the_clock,
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
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = redeem::E_UNREGISTERED_COIN)]
    public fun cannot_complete_transfer_with_relay_unregistered_coin() {
        // Test variables.
        let vaa = x"0100000000010081e52aa98547897df8ebf0ca7508ca295e46283aef48648ccaed71b69433efc969e987e4c63b3482636215c4fb6f6196797bb9ee592b1e9db1e159397574a822006426e5450000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585000000000000000001030000000000000000000000000000000000000000000000000de0b6b3a7640000e4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a070015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
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

        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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

        // Mint SUI for the swap. We avoid calling the `mint_sui_for_swap`
        // method here to avoid hitting the overflow exception outside
        // of the contract call.
        let sui_coins_for_swap = mint_sui(
            0,
            test_scenario::ctx(scenario)
        );

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_8>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, relayer);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            &the_clock,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        test_scenario::next_tx(scenario, recipient);

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = redeem::E_UNREGISTERED_FOREIGN_CONTRACT)]
    public fun cannot_complete_transfer_with_relay_unknown_sender() {
        // Test variables.
        let vaa = x"01000000000100623bd5202ec946a255bcec60efee62cf816952b430f1584f543f535dadd065f263d761abc8df1c0f1d6aab68d9d93630d98795c7d17fe45bc5be22fb9f94536a016426e78b0000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585000000000000000001030000000000000000000000000000000000000000000000000de0b6b3a7640000e4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a070015000000000000000000000000000000000000000000000000000000000000005001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
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

        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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

        // Mint SUI for the swap. We avoid calling the `mint_sui_for_swap`
        // method here to avoid hitting the overflow exception outside
        // of the contract call.
        let sui_coins_for_swap = mint_sui(
            0,
            test_scenario::ctx(scenario)
        );

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_8>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, relayer);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            &the_clock,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        test_scenario::next_tx(scenario, recipient);

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = redeem::E_INVALID_CALLER_FOR_ACTION)]
    public fun cannot_complete_transfer_with_relay_invalid_caller() {
        // Test variables.
        let vaa = x"01000000000100f756702ad05038bf30f829db2145b3681caf3d7c2c3b64fcc4d5a51771febb40536e6d32d2803d3ac8335112a4047fbb544597a716cba0f0737320276c31768f006426e7f10000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585000000000000000001030000000000000000000000000000000000000000000000000de0b6b3a7640000e4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a070015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
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

        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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

        // Mint SUI for the swap. We avoid calling the `mint_sui_for_swap`
        // method here to avoid hitting the overflow exception outside
        // of the contract call.
        let sui_coins_for_swap = mint_sui(
            0,
            test_scenario::ctx(scenario)
        );

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_8>(&mut bridge_state, test_amount);

        // NOTE: Explicitly set the context to the recipient to test that the
        // contract correctly reverts.
        test_scenario::next_tx(scenario, recipient);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            &the_clock,
            test_scenario::ctx(scenario)
        );

        // Proceed.
        test_scenario::next_tx(scenario, recipient);

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = redeem::E_INSUFFICIENT_NATIVE_COIN)]
    public fun cannot_complete_transfer_with_relay_coin_8_insufficient_native_amount() {
        // Test variables.
        let vaa = x"010000000001009f529b7eb564d366e4ad1a6b769aca0097c75fe156b7b25526d8bd59aacb219c245264c3da60de7a63713ff56b185da0fbc0dbaa1b674757d72d7434b479ccf3006426e88f0000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585000000000000000001030000000000000000000000000000000000000000000000000de0b6b3a7640000e4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a070015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002540be4000000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
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

        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_8>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, relayer);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            actual_sui_coins_for_swap,
            &the_clock,
            test_scenario::ctx(scenario)
        );

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);
        native_transfer::public_transfer(expected_sui_coins_for_swap, @0x0);
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = redeem::E_INSUFFICIENT_NATIVE_COIN)]
    public fun cannot_complete_transfer_with_relay_coin_10_insufficient_native_amount() {
        // Test variables.
        let vaa = x"01000000000100113e56a30d4a29d669939b08fc6b005d9015944b4b1efb09281f871db74f946a5c8bc148a892ba3a4d621a19ad3b4015e436f2f740ec670ea99d1d3bbc50dcaf006426e8fc0000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa5850000000000000000010300000000000000000000000000000000000000000000000000005af3107a4000e4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a070015000000000000000000000000000000000000000000000000000000000000006901000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f42400000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
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

        // Fetch the coin 10 metadata.
        let test_metadata = get_coin_10_metadata(
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

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_10>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, relayer);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_10>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            actual_sui_coins_for_swap,
            &the_clock,
            test_scenario::ctx(scenario)
        );

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);
        native_transfer::public_transfer(expected_sui_coins_for_swap, @0x0);
        token_bridge_scenario::return_clock(the_clock);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = redeem::E_SWAP_IN_OVERFLOW)]
    public fun cannot_complete_transfer_with_relay_max_swap_amount_overflow() {
        // Test variables.
        let vaa = x"01000000000100d1ddcc19a034feda60e1553e68d5c193ba88419417a091a8b75a99aadcdc1aae412147c94900ee3873564c296dee0fae8e2ea5ff0d36198c9cbd3b843fc8b13f016426e9d60000000000020000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa58500000000000000000103000000000000000000000000000000000000000000000000fffffffffffffffee4d0bcbdc026b98a242f13e2761601107c90de400f0c24cdafea526abf201c260015a80dc5b12f68ff8278c4eb48917aaa3572dde5420c19f8b74e0099eb13ed1a0700150000000000000000000000000000000000000000000000000000000000000069010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000fffffffffffffffd0000000000000000000000009f082e1be326e8863bac818f0c08ae28a8d47c99";
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

        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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

        // Mint SUI for the swap. We avoid calling the `mint_sui_for_swap`
        // method here to avoid hitting the overflow exception outside
        // of the contract call.
        let sui_coins_for_swap = mint_sui(
            0,
            test_scenario::ctx(scenario)
        );

        // Deposit tokens into the bridge.
        token_bridge_scenario::deposit_native<COIN_8>(&mut bridge_state, test_amount);
        test_scenario::next_tx(scenario, relayer);

        // Take clock.
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Redeem the transfer on the Token Bridge Relayer contract.
        redeem::complete_transfer_with_relay<COIN_8>(
            &token_bridge_relayer_state,
            &mut wormhole_state,
            &mut bridge_state,
            vaa,
            sui_coins_for_swap,
            &the_clock,
            test_scenario::ctx(scenario)
        );

        // Return state objects.
        test_scenario::return_shared(token_bridge_relayer_state);
        test_scenario::return_shared(bridge_state);
        test_scenario::return_shared(wormhole_state);
        token_bridge_scenario::return_clock(the_clock);

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

        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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

        // Fetch the coin 10 metadata.
        let test_metadata = get_coin_10_metadata(
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

        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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

        // Fetch the coin 10 metadata.
        let test_metadata = get_coin_10_metadata(
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

        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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

        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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

        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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


        // Fetch the coin 8 metadata.
        let test_metadata = get_coin_8_metadata(
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

        // Done.
        test_scenario::end(my_scenario);
    }

    /// Utilities.

     public fun get_coin_8_metadata(
        ctx: &mut TxContext
    ): CoinMetadata<COIN_8> {
        // Initialize token 8.
        let (treasury_cap, metadata) = coin_8::create_coin_test_only(ctx);

        // Bye bye.
        native_transfer::public_transfer(treasury_cap, @0x0);

        // Return.
        (metadata)
    }

    public fun get_coin_10_metadata(
        ctx: &mut TxContext
    ): CoinMetadata<COIN_10> {
        // Initialize token 8.
        let (treasury_cap, metadata) = coin_10::create_coin_test_only(ctx);

        // Bye bye.
        native_transfer::public_transfer(treasury_cap, @0x0);

        // Return.
        (metadata)
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
        recipient: address,
        scenario: &mut Scenario,
        coin_meta: CoinMetadata<C>
    ): TransactionEffects {
        // Fetch necessary objects.
        let owner_cap =
            test_scenario::take_from_sender<OwnerCap>(scenario);
        let the_clock = token_bridge_scenario::take_clock(scenario);

        // Register a foreign contract.
        {
            owner::register_foreign_contract(
                &owner_cap,
                token_bridge_relayer_state,
                TEST_FOREIGN_EMITTER_CHAIN,
                TEST_FOREIGN_EMITTER_CONTRACT
            );

            test_scenario::next_tx(scenario, recipient);
        };

        // Attest token.
        {
            // Attest SUI.
            let fee_coin = mint_sui(
                wormhole_state_module::message_fee(wormhole_state),
                test_scenario::ctx(scenario)
            );

            attest_token::attest_token<C>(
                bridge_state,
                wormhole_state,
                coin::into_balance<SUI>(fee_coin),
                &coin_meta,
                0, // nonce
                &the_clock
            );

            // Proceed.
            test_scenario::next_tx(scenario, recipient);
            native_transfer::public_transfer(coin_meta, @0x0);
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
            test_scenario::next_tx(scenario, recipient);

            // Register passed coin type. Enable swaps by default.
            owner::register_token<C>(
                &owner_cap,
                token_bridge_relayer_state,
                TEST_INITIAL_COIN_SWAP_RATE,
                TEST_INITIAL_MAX_SWAP_AMOUNT,
                true
            );

            // Proceed.
            test_scenario::next_tx(scenario, recipient);
        };

        // Return owner cap.
        test_scenario::return_to_sender(scenario, owner_cap);
        token_bridge_scenario::return_clock(the_clock);

        let effects = test_scenario::next_tx(scenario, recipient);
        (effects)
    }
}
