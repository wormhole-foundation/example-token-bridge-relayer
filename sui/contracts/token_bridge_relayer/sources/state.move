/// This module implements the global state variables for the Token Bridge
/// Relayer. The `State` object is used to perform anything that requires
/// access to data that defines the Token Bridge Relayer contract.
module token_bridge_relayer::state {
    // Sui dependencies.
    use sui::sui::SUI;
    use sui::object::{Self, UID};
    use sui::tx_context::{TxContext};

    // Wormhole dependencies.
    use wormhole::state::{State as WormholeState};
    use wormhole::emitter::{Self, EmitterCap};
    use wormhole::external_address::{ExternalAddress};

    // Token Bridge Relayer modules.
    use token_bridge_relayer::foreign_contracts::{Self};
    use token_bridge_relayer::relayer_fees::{Self};
    use token_bridge_relayer::registered_tokens::{Self, RegisteredTokens};

    // Only the owner should be allowed to mutate `State`.
    friend token_bridge_relayer::owner;
    friend token_bridge_relayer::redeem;
    friend token_bridge_relayer::transfer;

    /// Errors.
    const E_INVALID_CHAIN: u64 = 0;
    const E_INVALID_CONTRACT_ADDRESS: u64 = 1;
    const E_PRECISION_CANNOT_BE_ZERO: u64 = 2;
    const E_INVALID_NATIVE_SWAP_RATE: u64 = 3;

    /// Max U64 const.
    const MAX_SUPPLY: u256 = 0xfffffffffffffffe;

    /// Object that holds this contract's state. `foreign_contracts` and
    /// `relayer_fees` are stored as dynamic object fields in this state object.
    struct State has key, store {
        id: UID,

        /// Token Bridge Relayer owned emitter capability. This is used to
        /// emit Wormhole messages.
        emitter_cap: EmitterCap,

        /// Swap Rate Precision.
        swap_rate_precision: u64,

        /// Relayer Fee Precision.
        relayer_fee_precision: u64,

        /// Registered tokens object. Only coin types stored as dynamic fields
        /// on this object are accepted by this contract.
        registered_tokens: RegisteredTokens,
    }

    /// Creates new `State` object. The `emitter_cap` and `registered_tokens`
    /// objects are also created. This method should only be executed from the
    /// `owner::create_state` method.
    public(friend) fun new(
        wormhole_state: &WormholeState,
        swap_rate_precision: u64,
        relayer_fee_precision: u64,
        ctx: &mut TxContext
    ): State {
        // Create state object.
        let state = State {
            id: object::new(ctx),
            emitter_cap: emitter::new(wormhole_state, ctx),
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

    /// Registers foreign Token Bridge Relayer contracts. This contract will
    /// only accept `TransferWithRelay` messages from registered contracts.
    public(friend) fun register_foreign_contract(
        self: &mut State,
        chain: u16,
        contract_address: ExternalAddress,
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

    /// Updates the `relayer_fee` for a `chain`. This method will revert
    /// if a `foreign_contract` has not been registered for the specified
    /// `chain`.
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

    /// Updates the `relayer_fee_precision`.
    public(friend) fun update_relayer_fee_precision(
        self: &mut State,
        new_relayer_fee_precision: u64
    ) {
        assert!(new_relayer_fee_precision > 0, E_PRECISION_CANNOT_BE_ZERO);
        self.relayer_fee_precision = new_relayer_fee_precision;
    }

    /// Registers a coin type with this contract. This contract will only
    /// accept inbound transfers (and allow outbound transfers) for registered
    /// coin types.
    public(friend) fun register_token<C>(
        self: &mut State,
        swap_rate: u64,
        max_native_swap_amount: u64,
        enable_swap: bool
    ) {
        registered_tokens::add_token<C>(
            &mut self.registered_tokens,
            swap_rate,
            max_native_swap_amount,
            enable_swap
        );
    }

    /// Deregisters a coin type. This removes a dynamic field from the
    /// `registered_tokens` object.
    public(friend) fun deregister_token<C>(
        self: &mut State
    ) {
        registered_tokens::remove_token<C>(
            &mut self.registered_tokens
        );
    }

    /// Updates the `swap_rate` for the specified coin type. This method will
    /// revert when the caller passes an unregistered coin type.
    public(friend) fun update_swap_rate<C>(
        self: &mut State,
        swap_rate: u64
    ) {
        registered_tokens::update_swap_rate<C>(
            &mut self.registered_tokens,
            swap_rate
        );
    }

    /// Updates the `swap_rate_precision`.
    public(friend) fun update_swap_rate_precision(
        self: &mut State,
        new_swap_rate_precision: u64
    ) {
        assert!(new_swap_rate_precision > 0, E_PRECISION_CANNOT_BE_ZERO);
        self.swap_rate_precision = new_swap_rate_precision;
    }

    /// Updates the `max_native_swap_amount` for the specified coin type. This
    /// method will revert when the caller passes an unregistered coin type.
    public(friend) fun update_max_native_swap_amount<C>(
        self: &mut State,
        max_native_swap_amount: u64
    ) {
        registered_tokens::update_max_native_swap_amount<C>(
            &mut self.registered_tokens,
            max_native_swap_amount
        );
    }

    /// Updates the `swap_enabled` boolean for the specified coin type. This
    /// method will revert when the caller passes an unregistered coin type.
    public(friend) fun toggle_swap_enabled<C>(
        self: &mut State,
        enable_swap: bool
    ) {
        registered_tokens::toggle_swap_enabled<C>(
            &mut self.registered_tokens,
            enable_swap
        );
    }

    // Getters.

    public(friend) fun emitter_cap(self: &State): &EmitterCap {
        &self.emitter_cap
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

    /// This method computes the `native_swap_rate` for a specified coin type.
    /// If an overflow occurs, it is very likely that the contract owner
    /// has misconfigured the `swap_rate_precision` or incorrectly set
    /// the `swap_rate` for the specified coin type (or SUI).
    public fun native_swap_rate<C>(self: &State): u64 {
        let native_swap_rate = (
            (swap_rate_precision(self) as u256) *
            (swap_rate<SUI>(self) as u256) /
            (swap_rate<C>(self) as u256)
        );

        // Catch overflow.
        assert!(
            native_swap_rate > 0 &&
            native_swap_rate <= MAX_SUPPLY,
            E_INVALID_NATIVE_SWAP_RATE
        );

        (native_swap_rate as u64)
    }

    public fun max_native_swap_amount<C>(self: &State): u64 {
        registered_tokens::max_native_swap_amount<C>(&self.registered_tokens)
    }

    public fun is_swap_enabled<C>(self: &State): bool {
        registered_tokens::is_swap_enabled<C>(&self.registered_tokens)
    }

    public fun foreign_contract_address(
        self: &State,
        chain: u16
    ): ExternalAddress {
        *foreign_contracts::contract_address(&self.id, chain)
    }

    public fun usd_relayer_fee(self: &State, chain: u16): u64 {
        relayer_fees::usd_fee(&self.id, chain)
    }

    public fun token_relayer_fee<C>(
        self: &State,
        chain: u16,
        decimals: u8
    ): u64 {
        relayer_fees::token_fee(
            &self.id,
            chain,
            decimals,
            swap_rate<C>(self),
            swap_rate_precision(self),
            relayer_fee_precision(self)
        )
    }

    public fun relayer_fee_precision(self: &State): u64 {
        self.relayer_fee_precision
    }

    public fun swap_rate_precision(self: &State): u64 {
        self.swap_rate_precision
    }
}
