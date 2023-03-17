module token_bridge_relayer::registered_tokens {
    use sui::dynamic_field::{Self};
    use sui::object::{Self, UID};
    use sui::tx_context::{TxContext};

    use token_bridge_relayer::token_info::{Self, TokenInfo};

    friend token_bridge_relayer::state;

    const E_UNREGISTERED: u64 = 0;
    const E_ALREADY_REGISTERED: u64 = 1;
    const E_SWAP_RATE_IS_ZERO: u64 = 2;

    struct RegisteredTokens has key, store {
        id: UID,
        num_tokens: u64
    }

    struct Key<phantom C> has copy, drop, store {}

    public fun new(ctx: &mut TxContext): RegisteredTokens {
        RegisteredTokens {
            id: object::new(ctx),
            num_tokens: 0
        }
    }

    public fun num_tokens(self: &RegisteredTokens): u64 {
        self.num_tokens
    }

    public(friend) fun add_token<C>(
        self: &mut RegisteredTokens,
        swap_rate: u64,
        max_native_swap_amount: u64
    ) {
        assert!(!has<C>(self), E_ALREADY_REGISTERED);
        assert!(swap_rate > 0, E_SWAP_RATE_IS_ZERO);
        add<C>(
            self,
            token_info::new(swap_rate, max_native_swap_amount)
        )
    }

    public(friend) fun remove_token<C>(
        self: &mut RegisteredTokens
    ) {
        assert!(has<C>(self), E_UNREGISTERED);
        remove<C>(self);
    }

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

    public fun swap_rate<C>(self: &RegisteredTokens): u64 {
        assert!(has<C>(self), E_UNREGISTERED);
        token_info::swap_rate(borrow_token_info<C>(self))
    }

    public fun max_native_swap_amount<C>(self: &RegisteredTokens): u64 {
        assert!(has<C>(self), E_UNREGISTERED);
        token_info::max_native_swap_amount(borrow_token_info<C>(self))
    }

    public fun has<C>(self: &RegisteredTokens): bool {
        dynamic_field::exists_(&self.id, Key<C>{})
    }

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
