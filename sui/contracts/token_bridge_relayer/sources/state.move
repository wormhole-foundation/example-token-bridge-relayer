module token_bridge_relayer::state {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::{TxContext};

    use wormhole::emitter::{EmitterCapability as EmitterCap};

    use token_bridge_relayer::bytes32::{Self};
    use token_bridge_relayer::foreign_contracts::{Self};
    use token_bridge_relayer::relayer_fees::{Self};
    use token_bridge_relayer::registered_tokens::{Self, RegisteredTokens};

    // Only the owner should be allowed to mutate `State`.
    friend token_bridge_relayer::owner;

    // Errors.
    const E_INVALID_CHAIN: u64 = 0;
    const E_INVALID_CONTRACT_ADDRESS: u64 = 1;
    const E_PRECISION_CANNOT_BE_ZERO: u64 = 2;

    /// Object that holds this contract's state. Foreign contracts are
    /// stored as dynamic object fields of `State`.
    struct State has key, store {
        id: UID,

        /// HelloToken owned emitter capability.
        emitter_cap: EmitterCap,

        /// Swap Rate Precision
        swap_rate_precision: u64,

        /// Relayer Fee Precision
        relayer_fee_precision: u64,

        /// Accepted Tokens
        registered_tokens: RegisteredTokens,
    }

    public(friend) fun new(
        emitter_cap: EmitterCap,
        swap_rate_precision: u64,
        relayer_fee_precision: u64,
        ctx: &mut TxContext
    ): State {
        // Create state object.
        let state = State {
            id: object::new(ctx),
            emitter_cap,
            swap_rate_precision,
            relayer_fee_precision,
            registered_tokens: registered_tokens::new(ctx)
        };

        // Make new foreign contracts map.
        foreign_contracts::new(&mut state.id, ctx);

        // Make new relayer fee map.
        relayer_fees::new(&mut state.id, ctx);

        // Done.
        state
    }

    public(friend) fun register_foreign_contract(
        self: &mut State,
        chain: u16,
        contract_address: bytes32::Bytes32,
    ) {
        if (contract_registered(self, chain)) {
            foreign_contracts::update(
                &mut self.id,
                chain,
                contract_address
            );
        } else {
            foreign_contracts::add(
                &mut self.id,
                chain,
                contract_address,
            );
        }
    }

    public(friend) fun update_relayer_fee(
        self: &mut State,
        chain: u16,
        fee: u64
    ) {
        if (relayer_fee_is_set(self, chain)) {
            relayer_fees::update(
                &mut self.id,
                chain,
                fee
            );
        } else {
            relayer_fees::add(
                &mut self.id,
                chain,
                fee
            );
        }
    }

    public(friend) fun update_relayer_fee_precision(
        self: &mut State,
        new_relayer_fee_precision: u64
    ) {
        assert!(new_relayer_fee_precision > 0, E_PRECISION_CANNOT_BE_ZERO);
        self.relayer_fee_precision = new_relayer_fee_precision;
    }

    public(friend) fun register_token<C>(
        self: &mut State,
        decimals: u8,
        swap_rate: u64,
        max_native_swap_amount: u64
    ) {
        registered_tokens::add_token<C>(
            &mut self.registered_tokens,
            decimals,
            swap_rate,
            max_native_swap_amount
        );
    }

    public(friend) fun deregister_token<C>(
        self: &mut State
    ) {
        registered_tokens::remove_token<C>(
            &mut self.registered_tokens
        );
    }

    public(friend) fun update_swap_rate<C>(
        self: &mut State,
        swap_rate: u64
    ) {
        registered_tokens::update_swap_rate<C>(
            &mut self.registered_tokens,
            swap_rate
        );
    }

    public(friend) fun update_swap_rate_precision(
        self: &mut State,
        new_swap_rate_precision: u64
    ) {
        assert!(new_swap_rate_precision > 0, E_PRECISION_CANNOT_BE_ZERO);
        self.swap_rate_precision = new_swap_rate_precision;
    }

    public(friend) fun update_max_native_swap_amount<C>(
        self: &mut State,
        max_native_swap_amount: u64
    ) {
        registered_tokens::update_max_native_swap_amount<C>(
            &mut self.registered_tokens,
            max_native_swap_amount
        );
    }

    public fun emitter_cap(self: &State): &EmitterCap {
        &self.emitter_cap
    }

    public fun id(self: &State): &ID {
        object::borrow_id(self)
    }

    public fun contract_registered(self: &State, chain: u16): bool {
        foreign_contracts::has(&self.id, chain)
    }

    public fun relayer_fee_is_set(self: &State, chain: u16): bool {
        relayer_fees::has(&self.id, chain)
    }

    public fun is_registered_token<C>(self: &State): bool {
        registered_tokens::has<C>(&self.registered_tokens)
    }

    public fun registered_token_count(self: &State): u64 {
        registered_tokens::num_tokens(&self.registered_tokens)
    }

    public fun swap_rate<C>(self: &State): u64 {
        registered_tokens::swap_rate<C>(&self.registered_tokens)
    }

    public fun max_native_swap_amount<C>(self: &State): u64 {
        registered_tokens::max_native_swap_amount<C>(&self.registered_tokens)
    }

    public fun foreign_contract_address(self: &State, chain: u16): &bytes32::Bytes32 {
        foreign_contracts::contract_address(&self.id, chain)
    }

    public fun relayer_fee(self: &State, chain: u16): u64 {
        relayer_fees::fee(&self.id, chain)
    }

    public fun relayer_fee_precision(self: &State): u64 {
        self.relayer_fee_precision
    }

    public fun swap_rate_precision(self: &State): u64 {
        self.swap_rate_precision
    }
}
