module token_bridge_relayer::owner {
    use sui::dynamic_field::{Self};
    use sui::object::{Self, UID};
    use sui::transfer::{Self};
    use sui::tx_context::{Self, TxContext};

    use wormhole::emitter::{EmitterCapability as EmitterCap};
    use wormhole::external_address::{Self};

    use token_bridge_relayer::state::{Self, State};

    // Errors.
    const E_STATE_ALREADY_CREATED: u64 = 0;

    /// The one of a kind - created in the module initializer.
    struct OwnerCap has key {
        id: UID
    }

    /// This function is only called once on module publish.
    /// Use it to make sure something has happened only once, like
    /// here - only module author will own a version of a
    /// `OwnerCap` struct.
    fun init(ctx: &mut TxContext) {
        // Create `OwnerCap` to the contract publisher.
        let owner_cap = OwnerCap {
            id: object::new(ctx),
        };

        // Use this in `create_state` to determine if state is created already.
        // This step is unnecessary because the `EmitterCap` passed into
        // `create_state` deletes the object at that UID. But we will keep this
        // here for now in case something changes with Wormhole's EmitterCap.
        dynamic_field::add(&mut owner_cap.id, b"state_created", false);

        // Transfer `OwnerCap` to the contract publisher.
        transfer::transfer(owner_cap, tx_context::sender(ctx));
    }

    /// Only owner. This creates a new state object that also acts as dynamic
    /// storage.
    public entry fun create_state(
        owner_cap: &mut OwnerCap,
        emitter_cap: EmitterCap,
        ctx: &mut TxContext
    ) {
        assert!(
            !*dynamic_field::borrow(&owner_cap.id, b"state_created"),
            E_STATE_ALREADY_CREATED
        );

        // State will be created once function finishes.
        *dynamic_field::borrow_mut(&mut owner_cap.id, b"state_created") = true;

        // Hardcode the initial swap rate and relayer fee precision state variables.
        let swap_rate_precision: u64 = 1000000000;
        let relayer_fee_precision: u64 = 100000000;

        // Create and share state.
        transfer::share_object(
            state::new(emitter_cap, swap_rate_precision, relayer_fee_precision, ctx)
        )
    }

    /// Only owner. This method registers a foreign contract address.
    public entry fun register_foreign_contract(
        _: &OwnerCap,
        t_state: &mut State,
        chain: u16,
        contract_address: vector<u8>,
    ) {
        state::register_foreign_contract(
            t_state,
            chain,
            external_address::left_pad(&contract_address)
        );
    }

    /// Only owner. This method updates the relayer fee for this chain.
    public entry fun update_relayer_fee(
        _: &OwnerCap,
        t_state: &mut State,
        chain: u16,
        relayer_fee: u64
    ) {
        state::update_relayer_fee(t_state, chain, relayer_fee)
    }

    /// Only owner. This method updates the relayer fee precision for this
    /// chain.
    public entry fun update_relayer_fee_precision(
        _: &OwnerCap,
        t_state: &mut State,
        relayer_fee_precision: u64
    ) {
        state::update_relayer_fee_precision(t_state, relayer_fee_precision);
    }

    /// Only owner. This method registers a token, and sets the initial swap
    /// rate and max native swap amount for the registered token.
    public entry fun register_token<C>(
        _: &OwnerCap,
        t_state: &mut State,
        swap_rate: u64,
        max_native_swap_amount: u64,
        enable_swap: bool
    ) {
        state::register_token<C>(
            t_state,
            swap_rate,
            max_native_swap_amount,
            enable_swap
        )
    }

    /// Only owner. This method deregesters a token.
    public entry fun deregister_token<C>(
        _: &OwnerCap,
        t_state: &mut State
    ) {
        state::deregister_token<C>(t_state);
    }

    /// Only owner. This method updates the swap rate for a registered token.
    public entry fun update_swap_rate<C>(
        _: &OwnerCap,
        t_state: &mut State,
        swap_rate: u64
    ) {
        state::update_swap_rate<C>(t_state, swap_rate);
    }

    /// Only owner. This method updates the swap rate precision for this chain.
    public entry fun update_swap_rate_precision(
        _: &OwnerCap,
        t_state: &mut State,
        swap_rate_precision: u64
    ) {
        state::update_swap_rate_precision(t_state, swap_rate_precision);
    }

    /// Only owner. This method updates the max native swap amount for a
    /// registered token.
    public entry fun update_max_native_swap_amount<C>(
        _: &OwnerCap,
        t_state: &mut State,
        max_native_swap_amount: u64
    ) {
        state::update_max_native_swap_amount<C>(t_state, max_native_swap_amount);
    }

    /// Only owner. This method toggles the swap_enabled boolean for a
    /// registered token.
    public entry fun toggle_swap_enabled<C>(
        _: &OwnerCap,
        t_state: &mut State,
        enable_swap: bool
    ) {
        state::toggle_swap_enabled<C>(t_state, enable_swap);
    }

    #[test_only]
    /// We need this function to simulate calling `init` in our test.
    public fun init_test_only(ctx: &mut TxContext) {
        init(ctx)
    }
}

#[test_only]
module token_bridge_relayer::init_tests {
    use std::vector::{Self};
    use sui::object::{Self};
    use sui::test_scenario::{Self, Scenario, TransactionEffects};

    use token_bridge_relayer::state::{
        Self as relayer_state,
        State as RelayerState
    };
    use token_bridge_relayer::owner::{Self, OwnerCap};
    use token_bridge_relayer::foreign_contracts::{Self};
    use token_bridge_relayer::relayer_fees::{Self};
    use token_bridge_relayer::registered_tokens::{Self};

    use wormhole::emitter::{EmitterCapability as EmitterCap};
    use wormhole::state::{
        DeployerCapability as WormholeDeployerCap,
        State as WormholeState
    };
    use wormhole::external_address::{Self};

    use token_bridge::state::{
        Self as bridge_state,
        State as BridgeState,
        DeployerCapability as BridgeDeployerCap
    };

    // Example coins.
    use example_coins::coin_8::{COIN_8};
    use example_coins::coin_9::{COIN_9};

    // Test consts.
    const TEST_TARGET_CHAIN: u16 = 69;
    const TEST_TARGET_CONTRACT: vector<u8> =
        x"000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe";
    const TEST_INITIAL_RELAYER_FEE_USD: u64 = 5;
    const TEST_INITIAL_MAX_SWAP_AMOUNT: u64 = 69420;
    const TEST_INITIAL_SWAP_RATE: u64 = 69; // $69
    const TEST_ENABLE_SWAP: bool = true;

    #[test]
    public fun init_test() {
        let my_scenario = test_scenario::begin(@0x0);
        let scenario = &mut my_scenario;
        let (creator, _) = people();

        // Get things going.
        test_scenario::next_tx(scenario, creator);

        // Simulate calling `init`.
        {
            owner::init_test_only(test_scenario::ctx(scenario));

            // Check existence of creator and state capabilities.
            let effects = test_scenario::next_tx(scenario, creator);

            let created_ids = test_scenario::created(&effects);
            assert!(vector::length(&created_ids) == 1, 0);

            // Verify that the created ID matches the OwnerCap's ID.
            let owner_cap_id = vector::borrow(&created_ids, 0);
            let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);
            assert!(*owner_cap_id == object::id(&owner_cap), 0);

            // Bye bye.
            test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);
        };

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun create_state() {
        let (creator, _) = people();
        let (my_scenario, effects) = set_up(creator);
        let scenario = &mut my_scenario;

        // We expect one object to be created:
        // 1. State
        let created_ids = test_scenario::created(&effects);
        assert!(vector::length(&created_ids) == 1, 0);

        // Verify that the created ID matches the State's ID.
        let state_id = vector::borrow(&created_ids, 0);
        let state = test_scenario::take_shared<RelayerState>(scenario);
        assert!(*state_id == object::id(&state), 0);

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);

        // We expect one objects to be deleted:
        // 1. emitter_cap
        let deleted_ids = test_scenario::deleted(&effects);

        // TODO(Drew): Why is this two now?
        assert!(vector::length(&deleted_ids) == 2, 0);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = owner::E_STATE_ALREADY_CREATED)]
    public fun cannot_create_state_again() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch the owner and emitter caps.
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);
        let emitter_cap =
            test_scenario::take_from_sender<EmitterCap>(scenario);

        // The call to create the state should fail.
        owner::create_state(
            &mut owner_cap,
            emitter_cap,
            test_scenario::ctx(scenario)
        );

        // Bye bye.
        test_scenario::return_to_sender<OwnerCap>(
            scenario,
            owner_cap
        );

        // Done.
        test_scenario::end(my_scenario);
    }

    // Foreign contract registration tests.

    #[test]
    public fun register_foreign_contract() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // Verify that the contract isn't already registered.
        {
            let is_registered =
                relayer_state::contract_registered(
                    &state,
                    TEST_TARGET_CHAIN
                );
            assert!(!is_registered, 0);
        };

        // Register the emitter.
        owner::register_foreign_contract(
            &owner_cap,
            &mut state,
            TEST_TARGET_CHAIN,
            TEST_TARGET_CONTRACT,
        );

        // Verify that the contract was registered correctly.
        {
            let is_registered =
                relayer_state::contract_registered(&state, TEST_TARGET_CHAIN);
            assert!(is_registered, 0);

            let registered_contract =
                relayer_state::foreign_contract_address(
                    &state,
                    TEST_TARGET_CHAIN
                );
            assert!(
                external_address::get_bytes(
                    registered_contract
                ) == TEST_TARGET_CONTRACT,
                0
            );
        };

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun replace_foreign_contract() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Create mock target contract address.
        let target_contract2 =
            x"0000000000000000000000000000000000000000000000000000000000000069";

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // Register the emitter.
        owner::register_foreign_contract(
            &owner_cap,
            &mut state,
            TEST_TARGET_CHAIN,
            TEST_TARGET_CONTRACT
        );

        // Verify that the contract was registered correctly.
        {
            let is_registered =
                relayer_state::contract_registered(&state, TEST_TARGET_CHAIN);
            assert!(is_registered, 0);

            let registered_contract =
                relayer_state::foreign_contract_address(
                    &state,
                    TEST_TARGET_CHAIN
                );
            assert!(
                external_address::get_bytes(
                    registered_contract
                ) == TEST_TARGET_CONTRACT,
                0
            );
        };

        // Proceed.
        test_scenario::next_tx(scenario, creator);

        // Register another emitter with the same chain ID.
        owner::register_foreign_contract(
            &owner_cap,
            &mut state,
            TEST_TARGET_CHAIN,
            target_contract2,
        );

        // Verify that the contract was registered correctly.
        {
            let registered_contract =
                relayer_state::foreign_contract_address(
                    &state,
                    TEST_TARGET_CHAIN
                );
            assert!(
                external_address::get_bytes(
                    registered_contract
                ) == target_contract2,
                0
            );
        };

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = foreign_contracts::E_INVALID_CHAIN)]
    public fun cannot_register_foreign_contract_chain_id_zero() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Target chain ID.
        let target_chain_id: u16 = 0;

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // The `register_foreign_contract` call should fail.
        owner::register_foreign_contract(
            &owner_cap,
            &mut state,
            target_chain_id,
            TEST_TARGET_CONTRACT,
        );

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = foreign_contracts::E_INVALID_CHAIN)]
    public fun cannot_register_foreign_contract_this_chain_id() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Create mock chain ID and address pair.
        let target_chain: u16 = 21;
        let target_contract =
            x"000000000000000000000000beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe";

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // The `register_foreign_contract` call should fail.
        owner::register_foreign_contract(
            &owner_cap,
            &mut state,
            target_chain,
            target_contract,
        );

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = foreign_contracts::E_INVALID_CONTRACT_ADDRESS)]
    public fun cannot_register_foreign_contract_zero_address() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Create mock target contract address.
        let target_contract =
            x"0000000000000000000000000000000000000000000000000000000000000000";

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // The `register_foreign_contract` call should fail.
        owner::register_foreign_contract(
            &owner_cap,
            &mut state,
            TEST_TARGET_CHAIN,
            target_contract,
        );

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = foreign_contracts::E_INVALID_CONTRACT_ADDRESS)]
    public fun cannot_replace_foreign_contract_zero_address() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Create mock target contract address.
        let target_contract_zero_address =
            x"0000000000000000000000000000000000000000000000000000000000000000";

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // Register the emitter.
        owner::register_foreign_contract(
            &owner_cap,
            &mut state,
            TEST_TARGET_CHAIN,
            TEST_TARGET_CONTRACT,
        );

        // Verify that the contract was registered correctly.
        {
            let is_registered =
                relayer_state::contract_registered(&state, TEST_TARGET_CHAIN);
            assert!(is_registered, 0);

            let registered_contract =
                relayer_state::foreign_contract_address(
                    &state,
                    TEST_TARGET_CHAIN
                );
            assert!(
                external_address::get_bytes(
                    registered_contract
                ) == TEST_TARGET_CONTRACT,
                0
            );
        };

        // Proceed.
        test_scenario::next_tx(scenario, creator);

        // Attempt to replace the registered emitter with the zero address.
        owner::register_foreign_contract(
            &owner_cap,
            &mut state,
            TEST_TARGET_CHAIN,
            target_contract_zero_address
        );

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    // Relayer fee tests.

    #[test]
    public fun set_initial_relayer_fee() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // Register the target contract.
        {
            // Register the emitter.
            owner::register_foreign_contract(
                &owner_cap,
                &mut state,
                TEST_TARGET_CHAIN,
                TEST_TARGET_CONTRACT,
            );

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Set the initial relayer fee.
        let initial_relayer_fee;
        {
            // Fetch the relayer fee precision.
            let relayer_fee_precision = relayer_state::relayer_fee_precision(
                &state
            );
            initial_relayer_fee =
                TEST_INITIAL_RELAYER_FEE_USD * relayer_fee_precision;

            // Set the relayer fee.
            owner::update_relayer_fee(
                &owner_cap,
                &mut state,
                TEST_TARGET_CHAIN,
                initial_relayer_fee
            );

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Verify that the state was updated correctly.
        {
            let fee_in_state = relayer_state::usd_relayer_fee(
                &state,
                TEST_TARGET_CHAIN
            );
            assert!(
                initial_relayer_fee == fee_in_state,
                0
            );
        };

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun update_relayer_fee() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // Register the target contract.
        {
            // Register the emitter.
            owner::register_foreign_contract(
                &owner_cap,
                &mut state,
                TEST_TARGET_CHAIN,
                TEST_TARGET_CONTRACT,
            );

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Fetch the relayer fee precision.
        let relayer_fee_precision = relayer_state::relayer_fee_precision(
            &state
        );

        // Set the initial relayer fee.
        {
            let initial_relayer_fee =
                TEST_INITIAL_RELAYER_FEE_USD * relayer_fee_precision;

            // Set the relayer fee.
            owner::update_relayer_fee(
                &owner_cap,
                &mut state,
                TEST_TARGET_CHAIN,
                initial_relayer_fee
            );

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Update the relayer fee to a new value.
        let new_relayer_fee = 69 * relayer_fee_precision;
        {
            // Confirm that the relayer fee value is set.
            let fee_in_state = relayer_state::usd_relayer_fee(
                &state,
                TEST_TARGET_CHAIN
            );
            assert!(
                fee_in_state != 0 && fee_in_state != new_relayer_fee,
                0
            );

            // Finally, update the relayer fee.
            owner::update_relayer_fee(
                &owner_cap,
                &mut state,
                TEST_TARGET_CHAIN,
                new_relayer_fee
            );

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Verify that the state was updated correctly.
        {
            let fee_in_state = relayer_state::usd_relayer_fee(
                &state,
                TEST_TARGET_CHAIN
            );
            assert!(
                new_relayer_fee == fee_in_state,
                0
            );
        };

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = relayer_fees::E_CHAIN_NOT_REGISTERED)]
    public fun cannot_set_initial_relayer_fee_contract_not_registered() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // NOTE: Explicitly don't register the target contract.

        // Expect the call to update the relayer to revert.
        {
            // Fetch the relayer fee precision.
            let relayer_fee_precision = relayer_state::relayer_fee_precision(
                &state
            );
            let initial_relayer_fee =
                TEST_INITIAL_RELAYER_FEE_USD * relayer_fee_precision;

            // Set the relayer fee.
            owner::update_relayer_fee(
                &owner_cap,
                &mut state,
                TEST_TARGET_CHAIN,
                initial_relayer_fee
            );

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = relayer_fees::E_INVALID_CHAIN)]
    public fun cannot_set_initial_relayer_fee_this_chain_id() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // Expect the call to update the relayer to revert.
        let invalid_chain = 21;
        {
            // Fetch the relayer fee precision.
            let relayer_fee_precision = relayer_state::relayer_fee_precision(
                &state
            );
            let initial_relayer_fee =
                TEST_INITIAL_RELAYER_FEE_USD * relayer_fee_precision;

            // Set the relayer fee.
            owner::update_relayer_fee(
                &owner_cap,
                &mut state,
                invalid_chain,
                initial_relayer_fee
            );

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = relayer_fees::E_INVALID_CHAIN)]
    public fun cannot_set_initial_relayer_fee_chain_id_zero() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // Expect the call to update the relayer to revert.
        let invalid_chain = 0;
        {
            // Fetch the relayer fee precision.
            let relayer_fee_precision = relayer_state::relayer_fee_precision(
                &state
            );
            let initial_relayer_fee =
                TEST_INITIAL_RELAYER_FEE_USD * relayer_fee_precision;

            // Set the relayer fee.
            owner::update_relayer_fee(
                &owner_cap,
                &mut state,
                invalid_chain,
                initial_relayer_fee
            );

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    // Update relayer fee precision tests.

    #[test]
    public fun update_relayer_fee_precision() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // Fetch the initial relayer fee precision.
        let initial_relayer_fee_precision =
            relayer_state::relayer_fee_precision(
                &state
            );

        // Update the relayer fee precision to a new value.
        let new_relayer_fee_precision: u64 = 200000000;
        assert!(new_relayer_fee_precision != initial_relayer_fee_precision, 0);

        owner::update_relayer_fee_precision(
            &owner_cap,
            &mut state,
            new_relayer_fee_precision
        );

        // Confirm that the state was updated accordingly.
        let relayer_fee_precision_in_state =
            relayer_state::relayer_fee_precision(
                &state
            );
        assert!(
            relayer_fee_precision_in_state == new_relayer_fee_precision,
            0
        );

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = relayer_state::E_PRECISION_CANNOT_BE_ZERO)]
    public fun cannot_update_relayer_fee_precision_to_zero() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // Update the relayer fee precision to a new value.
        let new_relayer_fee_precision: u64 = 0;

        owner::update_relayer_fee_precision(
            &owner_cap,
            &mut state,
            new_relayer_fee_precision
        );

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    // Token registration tests.

    #[test]
    public fun register_tokens() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // Confirm that the token isn't already registered.
        {
            let is_registered =
                relayer_state::is_registered_token<COIN_8>(
                    &state
                );
            let num_tokens = relayer_state::registered_token_count(&state);
            assert!(!is_registered && num_tokens == 0, 0);
        };

        // Register the token.
        let initial_swap_rate;
        {
            let swap_rate_precision = relayer_state::swap_rate_precision(
                &state
            );
            initial_swap_rate = swap_rate_precision * TEST_INITIAL_SWAP_RATE;

            owner::register_token<COIN_8>(
                &owner_cap,
                &mut state,
                initial_swap_rate,
                TEST_INITIAL_MAX_SWAP_AMOUNT,
                TEST_ENABLE_SWAP
            );

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Confirm that the state was updated correctly.
        {
            // Make sure the token was registered.
            let is_registered =
                relayer_state::is_registered_token<COIN_8>(
                    &state
                );
            let num_tokens = relayer_state::registered_token_count(&state);
            assert!(is_registered && num_tokens == 1, 0);

            // Confirm that the swap rate and max native swap amount were set
            // in the contract's state properly.
            let swap_rate_in_state = relayer_state::swap_rate<COIN_8>(&state);
            let max_native_swap_amount_in_state =
                relayer_state::max_native_swap_amount<COIN_8>(&state);

            assert!(
                swap_rate_in_state == initial_swap_rate &&
                max_native_swap_amount_in_state == TEST_INITIAL_MAX_SWAP_AMOUNT,
                0
            );
        };

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    public fun register_multiple_tokens() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // Compute the intiial swap rate, this is used in both token
        // registrations.
        let swap_rate_precision = relayer_state::swap_rate_precision(
                &state
            );
        let initial_swap_rate = swap_rate_precision * TEST_INITIAL_SWAP_RATE;

        // Register Coin 8.
        {
            owner::register_token<COIN_8>(
                &owner_cap,
                &mut state,
                initial_swap_rate,
                TEST_INITIAL_MAX_SWAP_AMOUNT,
                TEST_ENABLE_SWAP
            );

            // Confirm the registration and token count.
            let is_registered =
                relayer_state::is_registered_token<COIN_8>(
                    &state
                );
            let num_tokens = relayer_state::registered_token_count(&state);
            assert!(is_registered && num_tokens == 1, 0);

            // Confirm that the swap rate and max native swap amount were set
            // in the contract's state properly.
            let swap_rate_in_state = relayer_state::swap_rate<COIN_8>(&state);
            let max_native_swap_amount_in_state =
                relayer_state::max_native_swap_amount<COIN_8>(&state);
            assert!(
                swap_rate_in_state == initial_swap_rate &&
                max_native_swap_amount_in_state == TEST_INITIAL_MAX_SWAP_AMOUNT,
                0
            );

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Register Coin 9.
        {
            owner::register_token<COIN_9>(
                &owner_cap,
                &mut state,
                initial_swap_rate,
                TEST_INITIAL_MAX_SWAP_AMOUNT,
                TEST_ENABLE_SWAP
            );

            // Confirm the registration and token count.
            let is_registered =
                relayer_state::is_registered_token<COIN_9>(
                    &state
                );
            let num_tokens = relayer_state::registered_token_count(&state);
            assert!(is_registered && num_tokens == 2, 0);

            // Confirm that the swap rate and max native swap amount were set
            // in the contract's state properly.
            let swap_rate_in_state = relayer_state::swap_rate<COIN_9>(&state);
            let max_native_swap_amount_in_state =
                relayer_state::max_native_swap_amount<COIN_9>(&state);
            assert!(
                swap_rate_in_state == initial_swap_rate &&
                max_native_swap_amount_in_state == TEST_INITIAL_MAX_SWAP_AMOUNT,
                0
            );

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = registered_tokens::E_ALREADY_REGISTERED)]
    public fun cannot_register_token_again() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // Fetch the swap rate precision.
        let swap_rate_precision = relayer_state::swap_rate_precision(
                &state
            );

        // Register COIN_8.
        {
            owner::register_token<COIN_8>(
                &owner_cap,
                &mut state,
                swap_rate_precision * TEST_INITIAL_SWAP_RATE,
                TEST_INITIAL_MAX_SWAP_AMOUNT,
                TEST_ENABLE_SWAP
            );

            // Confirm that COIN_8 was registered.
            let is_registered =
                relayer_state::is_registered_token<COIN_8>(
                    &state
                );
            assert!(is_registered, 0);

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Try to register COIN_8 again. This call should fail.
        {
            owner::register_token<COIN_8>(
                &owner_cap,
                &mut state,
                swap_rate_precision * TEST_INITIAL_SWAP_RATE,
                TEST_INITIAL_MAX_SWAP_AMOUNT,
                TEST_ENABLE_SWAP
            );

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = registered_tokens::E_SWAP_RATE_IS_ZERO)]
    public fun cannot_register_token_zero_swap_rate() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // Try to register a token with a swap rate of zero. This call
        // should fail.
        let swap_rate: u64 = 0;

        owner::register_token<COIN_8>(
            &owner_cap,
            &mut state,
            swap_rate,
            TEST_INITIAL_MAX_SWAP_AMOUNT,
            TEST_ENABLE_SWAP
        );

        // Confirm that COIN_8 was registered.
        let is_registered =
            relayer_state::is_registered_token<COIN_8>(
                &state
            );
        assert!(is_registered, 0);

        // Proceed.
        test_scenario::next_tx(scenario, creator);


        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    // Token deregistration tests.

    #[test]
    public fun deregister_token() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // Register the token.
        {
            let swap_rate_precision = relayer_state::swap_rate_precision(
                &state
            );
            let initial_swap_rate = swap_rate_precision * TEST_INITIAL_SWAP_RATE;

            owner::register_token<COIN_8>(
                &owner_cap,
                &mut state,
                initial_swap_rate,
                TEST_INITIAL_MAX_SWAP_AMOUNT,
                TEST_ENABLE_SWAP
            );

            // Confirm that COIN_8 was registered.
            let is_registered =
                relayer_state::is_registered_token<COIN_8>(
                    &state
                );
            let num_tokens = relayer_state::registered_token_count(&state);
            assert!(is_registered && num_tokens == 1, 0);

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Deregister the token.
        {
            owner::deregister_token<COIN_8>(
                &owner_cap,
                &mut state,
            );

            // Verify that COIN_8 was deregistered.
            let is_registered =
                relayer_state::is_registered_token<COIN_8>(
                    &state
                );
            let num_tokens = relayer_state::registered_token_count(&state);
            assert!(!is_registered && num_tokens == 0, 0);

            // Proceed.
            let effects = test_scenario::next_tx(scenario, creator);

            // We expect one objects to be deleted:
            // 1. TokenInfo for COIN_8
            let deleted_ids = test_scenario::deleted(&effects);

            // TODO(Drew): Why is this two now?
            assert!(vector::length(&deleted_ids) == 1, 0);

        };

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = registered_tokens::E_UNREGISTERED)]
    public fun cannot_deregister_token_not_registered() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // The call to reregister the token should fail.
        {
            owner::deregister_token<COIN_8>(
                &owner_cap,
                &mut state,
            );
        };

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    // Update swap rate tests.

    #[test]
    public fun update_swap_rate() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // Swap rate precision.
        let swap_rate_precision = relayer_state::swap_rate_precision(
                &state
            );

        // Register COIN_8 and set initial swap rate.
        let initial_swap_rate;
        {
            initial_swap_rate = swap_rate_precision * TEST_INITIAL_SWAP_RATE;

            // Do the thing.
            owner::register_token<COIN_8>(
                &owner_cap,
                &mut state,
                initial_swap_rate,
                TEST_INITIAL_MAX_SWAP_AMOUNT,
                TEST_ENABLE_SWAP
            );

            // Confirm that COIN_8 was registered.
            let is_registered =
                relayer_state::is_registered_token<COIN_8>(
                    &state
                );
            assert!(is_registered, 0);

            // Confirm that the swap rate is set properly.
            let swap_rate_in_state = relayer_state::swap_rate<COIN_8>(&state);
            assert!(swap_rate_in_state == initial_swap_rate, 0);

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Update the swap rate to a new value.
        {
            let new_swap_rate = 420 * swap_rate_precision;
            assert!(new_swap_rate != initial_swap_rate, 0);

            // Update.
            owner::update_swap_rate<COIN_8>(
                &owner_cap,
                &mut state,
                new_swap_rate
            );

            // Confirm the state changes.
            let swap_rate_in_state = relayer_state::swap_rate<COIN_8>(&state);
            assert!(swap_rate_in_state == new_swap_rate, 0);

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = registered_tokens::E_UNREGISTERED)]
    public fun cannot_update_swap_rate_token_not_registered() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // Swap rate precision.
        let swap_rate_precision = relayer_state::swap_rate_precision(
                &state
            );
        let new_swap_rate = 420 * swap_rate_precision;

        // Try to update the swap for an unregistered token. This call should
        // fail.
        owner::update_swap_rate<COIN_8>(
            &owner_cap,
            &mut state,
            new_swap_rate
        );

        // Proceed.
        test_scenario::next_tx(scenario, creator);

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = registered_tokens::E_SWAP_RATE_IS_ZERO)]
    public fun cannot_update_zero_swap_rate() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // Swap rate precision.
        let swap_rate_precision = relayer_state::swap_rate_precision(
                &state
            );

        // Register COIN_8 and set initial swap rate.
        {
            // Do the thing.
            owner::register_token<COIN_8>(
                &owner_cap,
                &mut state,
                swap_rate_precision * TEST_INITIAL_SWAP_RATE,
                TEST_INITIAL_MAX_SWAP_AMOUNT,
                TEST_ENABLE_SWAP
            );

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Attempt to the update the swap rate with a value of zero, this
        // call should fail.
        {
            let new_swap_rate: u64 = 0;

            // Try to update the swap for an unregistered token. This call should
            // fail.
            owner::update_swap_rate<COIN_8>(
                &owner_cap,
                &mut state,
                new_swap_rate
            );

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    // Update swap rate precision tests.

     #[test]
    public fun update_swap_rate_precision() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // Fetch the initial relayer fee precision.
        let initial_swap_rate_precision =
            relayer_state::swap_rate_precision(
                &state
            );

        // Update the relayer fee precision to a new value.
        let new_swap_rate_precision: u64 = 200000000;
        assert!(new_swap_rate_precision != initial_swap_rate_precision, 0);

        owner::update_swap_rate_precision(
            &owner_cap,
            &mut state,
            new_swap_rate_precision
        );

        // Confirm that the state was updated accordingly.
        let swap_rate_precision_in_state =
            relayer_state::swap_rate_precision(
                &state
            );
        assert!(
            swap_rate_precision_in_state == new_swap_rate_precision,
            0
        );

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = relayer_state::E_PRECISION_CANNOT_BE_ZERO)]
    public fun cannot_update_swap_rate_precision_to_zero() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // Update the relayer fee precision to a new value.
        let new_swap_rate_precision: u64 = 0;

        owner::update_swap_rate_precision(
            &owner_cap,
            &mut state,
            new_swap_rate_precision
        );

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    // Update max native swap amount tests.

    #[test]
    public fun update_max_native_swap_amount() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // Swap rate precision.
        let swap_rate_precision = relayer_state::swap_rate_precision(
                &state
            );

        // Register COIN_8 and set initial swap rate.
        {
            // Do the thing.
            owner::register_token<COIN_8>(
                &owner_cap,
                &mut state,
                swap_rate_precision * TEST_INITIAL_SWAP_RATE,
                TEST_INITIAL_MAX_SWAP_AMOUNT,
                TEST_ENABLE_SWAP
            );

            // Confirm that COIN_8 was registered.
            let is_registered =
                relayer_state::is_registered_token<COIN_8>(
                    &state
                );
            assert!(is_registered, 0);

            // Confirm that the swap rate is set properly.
            let max_native_swap_amount_in_state =
                relayer_state::max_native_swap_amount<COIN_8>(&state);
            assert!(
                max_native_swap_amount_in_state == TEST_INITIAL_MAX_SWAP_AMOUNT,
                0
            );

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Update the max native swap amount.
        {
            let new_max_native_swap_amount = 69;
            assert!(
                new_max_native_swap_amount != TEST_INITIAL_MAX_SWAP_AMOUNT,
                0
            );

            // Update.
            owner::update_max_native_swap_amount<COIN_8>(
                &owner_cap,
                &mut state,
                new_max_native_swap_amount
            );

            // Confirm the state changes.
            let max_native_swap_amount_in_state =
                relayer_state::max_native_swap_amount<COIN_8>(&state);
            assert!(
                max_native_swap_amount_in_state == new_max_native_swap_amount,
                0
            );

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    #[test]
    #[expected_failure(abort_code = registered_tokens::E_UNREGISTERED)]
    public fun cannot_update_max_native_swap_amount_token_not_registered() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // Try to update the swap for an unregistered token. This call should
        // fail.
        owner::update_max_native_swap_amount<COIN_8>(
            &owner_cap,
            &mut state,
            1234567
        );

        // Proceed.
        test_scenario::next_tx(scenario, creator);

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    // Update swap_enabled boolean tests.

    #[test]
    public fun toggle_swap_enabled() {
        let (creator, _) = people();
        let (my_scenario, _) = set_up(creator);
        let scenario = &mut my_scenario;

        // Fetch the TokenBridgeRelayer state object and owner capability.
        let state = test_scenario::take_shared<RelayerState>(scenario);
        let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);

        // Swap rate precision.
        let swap_rate_precision = relayer_state::swap_rate_precision(
                &state
            );

        // Register COIN_8 and set swap_enabled to true.
        {
            // Do the thing.
            owner::register_token<COIN_8>(
                &owner_cap,
                &mut state,
                swap_rate_precision * TEST_INITIAL_SWAP_RATE,
                TEST_INITIAL_MAX_SWAP_AMOUNT,
                TEST_ENABLE_SWAP
            );

            // Confirm that COIN_8 was registered.
            let is_registered =
                relayer_state::is_registered_token<COIN_8>(
                    &state
                );
            assert!(is_registered, 0);

            // Confirm that the token has swaps enabled.
            let is_swap_enabled = relayer_state::is_swap_enabled<COIN_8>(&state);
            assert!(is_swap_enabled, 0);

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Toggle the swap_enabled to false and confirm the state changes.
        {
            // Do the thing.
            owner::toggle_swap_enabled<COIN_8>(
                &owner_cap,
                &mut state,
                false
            );

            // Confirm that the token has swaps enabled.
            let is_swap_enabled = relayer_state::is_swap_enabled<COIN_8>(&state);
            assert!(!is_swap_enabled, 0);

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Bye bye.
        test_scenario::return_shared<RelayerState>(state);
        test_scenario::return_to_sender<OwnerCap>(scenario, owner_cap);

        // Done.
        test_scenario::end(my_scenario);
    }

    // Utility functions.

    /// Returns two unique test addresses.
    public fun people(): (address, address) {
        (@0x9f082e1bE326e8863BAc818F0c08ae28a8D47C99, @0x1337)
    }

    /// This function sets up the test scenario for Hello Token by
    /// initializing the wormhole, token bridge and Hello Token contracts.
    /// It also creates an `emitter_cap` for Hello Token which is registered
    /// with the Wormhole contract.
    public fun set_up(creator: address): (Scenario, TransactionEffects) {
        let my_scenario = test_scenario::begin(@0x0);
        let scenario = &mut my_scenario;

        // Proceed.
        test_scenario::next_tx(scenario, creator);

        // Set up Wormhole contract.
        {
            wormhole::state::test_init(test_scenario::ctx(scenario));

            // Proceed.
            test_scenario::next_tx(scenario, creator);

            let deployer =
                test_scenario::take_from_sender<WormholeDeployerCap>(
                    scenario
                );

            // Share Wormhole state.
            wormhole::state::init_and_share_state(
                deployer,
                1, // governance chain
                x"0000000000000000000000000000000000000000000000000000000000000004", // governance_contract
                vector[x"beFA429d57cD18b7F8A4d91A2da9AB4AF05d0FBe"], // initial_guardians
                100,
                test_scenario::ctx(scenario)
            );

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Create a Wormhole emitter for the Token Bridge.
        {
            let wormhole_state =
                test_scenario::take_shared<WormholeState>(scenario);
            wormhole::wormhole::get_new_emitter(
                &mut wormhole_state,
                test_scenario::ctx(scenario)
            );

            // Bye bye.
            test_scenario::return_shared<WormholeState>(wormhole_state);

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Set up Token Bridge contract.
        {
            bridge_state::init_test_only(test_scenario::ctx(scenario));

            // Proceed.
            test_scenario::next_tx(scenario, creator);
            assert!(
                test_scenario::has_most_recent_for_sender<BridgeDeployerCap>(scenario),
                0
            );

            let deployer_cap =
                test_scenario::take_from_sender<BridgeDeployerCap>(
                    scenario
                );
            let wormhole_state =
                test_scenario::take_shared<WormholeState>(scenario);

            // Init the bridge state.
            bridge_state::init_and_share_state(
                deployer_cap,
                &mut wormhole_state,
                test_scenario::ctx(scenario)
            );

            // Bye bye.
            test_scenario::return_shared<WormholeState>(wormhole_state);

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Create another Wormhole emitter for the TokenBridgeRelayer module.
        {
            let wormhole_state =
                test_scenario::take_shared<WormholeState>(scenario);
            wormhole::wormhole::get_new_emitter(
                &mut wormhole_state,
                test_scenario::ctx(scenario)
            );

            // Bye bye.
            test_scenario::return_shared<WormholeState>(wormhole_state);

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Initialize the Hello Token contract.
        {
            // We call `init_test_only` to simulate `init`
            owner::init_test_only(test_scenario::ctx(scenario));

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Register a test emitter on the token bridge.
        {
            let state = test_scenario::take_shared<BridgeState>(scenario);
            bridge_state::register_emitter_test_only(
                &mut state,
                2, // Ethereum chain ID
                external_address::from_bytes(x"3ee18B2214AFF97000D974cf647E7C347E8fa585"),
            );
            test_scenario::return_shared<BridgeState>(state);

            // Proceed.
            test_scenario::next_tx(scenario, creator);
        };

        // Create the Hello Token shared state object.
        {
            let owner_cap =
                test_scenario::take_from_sender<OwnerCap>(scenario);
            let emitter_cap =
                test_scenario::take_from_sender<EmitterCap>(scenario);

            owner::create_state(
                &mut owner_cap,
                emitter_cap,
                test_scenario::ctx(scenario)
            );

            // Bye bye.
            test_scenario::return_to_sender<OwnerCap>(
                scenario,
                owner_cap
            );
        };

        let effects = test_scenario::next_tx(scenario, creator);
        (my_scenario, effects)
    }
}
