/// This module manages the list of coins that are accepted by the Token Bridge
/// Relayer. Each token has an associated `swap_rate`, `max_native_token_amount`
/// and `swap_enabled` field that can be updated by the contract owner.
module token_bridge_relayer::registered_tokens {
    // Sui dependencies.
    use sui::dynamic_field::{Self};
    use sui::object::{Self, UID};
    use sui::tx_context::{TxContext};

    // Token Bridge Relayer modules.
    use token_bridge_relayer::token_info::{Self, TokenInfo};

    // `token_bridge_relayer::state` can access friendly methods.
    friend token_bridge_relayer::state;

    /// Errors.
    const E_UNREGISTERED: u64 = 0;
    const E_ALREADY_REGISTERED: u64 = 1;
    const E_SWAP_RATE_IS_ZERO: u64 = 2;

    /// Object that holds registered token dynamic fields.
    struct RegisteredTokens has key, store {
        id: UID,
        /// The number of tokens registered with this contract.
        num_tokens: u64
    }

    /// Coin type key.
    struct Key<phantom C> has copy, drop, store {}

    /// Creates a new `RegisteredTokens` object.
    public(friend) fun new(ctx: &mut TxContext): RegisteredTokens {
        RegisteredTokens {
            id: object::new(ctx),
            num_tokens: 0
        }
    }

    /// Adds a new coin type to the `RegisteredTokens` object and sets the
    /// initial values for `swap_rate`, `max_native_swap_amount` and
    /// `swap_enabled`.
    public(friend) fun add_token<C>(
        self: &mut RegisteredTokens,
        swap_rate: u64,
        max_native_swap_amount: u64,
        swap_enabled: bool
    ) {
        assert!(!has<C>(self), E_ALREADY_REGISTERED);
        assert!(swap_rate > 0, E_SWAP_RATE_IS_ZERO);
        add<C>(
            self,
            token_info::new(swap_rate, max_native_swap_amount, swap_enabled)
        )
    }

    /// Removes a coin type from the `RegisteredToken` object.
    public(friend) fun remove_token<C>(
        self: &mut RegisteredTokens
    ) {
        assert!(has<C>(self), E_UNREGISTERED);
        remove<C>(self);
    }

    /// Updates the `swap_rate` for a coin type in the `RegisteredToken`
    /// object.
    public(friend) fun update_swap_rate<C>(
        self: &mut RegisteredTokens,
        swap_rate: u64
    ) {
        assert!(has<C>(self), E_UNREGISTERED);
        assert!(swap_rate > 0, E_SWAP_RATE_IS_ZERO);
        token_info::update_swap_rate(
            borrow_token_info_mut<C>(self),
            swap_rate
        );
    }

    /// Updates the `max_native_swap_amount` for a coin type in the
    /// `RegisteredToken` object.
    public(friend) fun update_max_native_swap_amount<C>(
        self: &mut RegisteredTokens,
        max_native_swap_amount: u64
    ) {
        assert!(has<C>(self), E_UNREGISTERED);
        token_info::update_max_native_swap_amount(
            borrow_token_info_mut<C>(self),
            max_native_swap_amount
        );
    }

    /// Enables and disables native swaps for a coin type in the
    /// `RegisteredToken` object.
    public(friend) fun toggle_swap_enabled<C>(
        self: &mut RegisteredTokens,
        enable_swap: bool
    ) {
        if (enable_swap) {
            token_info::enable_swap(borrow_token_info_mut<C>(self));
        } else {
            token_info::disable_swap(borrow_token_info_mut<C>(self));
        }
    }

    // Getters.

    public fun has<C>(self: &RegisteredTokens): bool {
        dynamic_field::exists_(&self.id, Key<C>{})
    }

    public fun num_tokens(self: &RegisteredTokens): u64 {
        self.num_tokens
    }

    public fun swap_rate<C>(self: &RegisteredTokens): u64 {
        assert!(has<C>(self), E_UNREGISTERED);
        token_info::swap_rate(borrow_token_info<C>(self))
    }

    public fun max_native_swap_amount<C>(self: &RegisteredTokens): u64 {
        assert!(has<C>(self), E_UNREGISTERED);
        token_info::max_native_swap_amount(borrow_token_info<C>(self))
    }

    public fun is_swap_enabled<C>(self: &RegisteredTokens): bool {
        token_info::is_swap_enabled(borrow_token_info<C>(self))
    }

    // Internal methods.

    fun add<C>(
        self: &mut RegisteredTokens,
        asset: TokenInfo<C>
    ) {
        dynamic_field::add(&mut self.id, Key<C>{}, asset);
        self.num_tokens = self.num_tokens + 1;
    }

    fun remove<C>(
        self: &mut RegisteredTokens
    ) {
        let removed_token =
            dynamic_field::remove<Key<C>, TokenInfo<C>>(&mut self.id, Key<C>{});
        token_info::destroy(removed_token);
        self.num_tokens = self.num_tokens - 1;
    }

    fun borrow_token_info<C>(self: &RegisteredTokens): &TokenInfo<C> {
        dynamic_field::borrow(&self.id, Key<C>{})
    }

    fun borrow_token_info_mut<C>(self: &mut RegisteredTokens): &mut TokenInfo<C> {
        dynamic_field::borrow_mut(&mut self.id, Key<C>{})
    }
}
