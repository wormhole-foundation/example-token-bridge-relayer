module token_bridge_relayer::relayer_fees {
    use sui::math::{Self};
    use sui::dynamic_object_field::{Self};
    use sui::object::{UID};
    use sui::table::{Self, Table};
    use sui::tx_context::{TxContext};

    use wormhole::state::{chain_id};

    use token_bridge_relayer::foreign_contracts::{Self};

    // Errors.
    const E_INVALID_CHAIN: u64 = 0;
    const E_FEE_NOT_SET: u64 = 1;
    const E_CHAIN_NOT_REGISTERED: u64 = 2;
    const E_RELAYER_FEE_OVERFLOW: u64 = 3;

    // Max U64 const.
    const U64_MAX: u64 = 18446744073709551615;

    // Dynamic field key.
    const KEY: vector<u8> = b"relayer_fees";

    /// Creates new dynamic object field using the stateId as the parent. The
    /// dynamic object field hosts a chainId to RelayerFee mapping.
    public fun new(parent_uid: &mut UID, ctx: &mut TxContext) {
        dynamic_object_field::add(
            parent_uid,
            KEY,
            table::new<u16, u64>(ctx)
        );
    }

    /// Adds a new chain ID => relayer fee mapping.
    public fun add(
        parent_uid: &mut UID,
        chain: u16,
        fee: u64
    ) {
        assert!(chain != 0 && chain != chain_id(), E_INVALID_CHAIN);
        assert!(
            foreign_contracts::has(parent_uid, chain),
            E_CHAIN_NOT_REGISTERED
        );

        table::add(borrow_table_mut(parent_uid), chain, fee);
    }

    /// Updates an existing chain ID => relayer fee mapping.
    public fun update(
        parent_uid: &mut UID,
        chain: u16,
        fee: u64
    ) {
        *table::borrow_mut(
            borrow_table_mut(parent_uid),
            chain
        ) = fee;
    }

    /// Returns the relayer fee associated with the specified chain ID.
    public fun usd_fee(parent_uid: &UID, chain: u16): u64 {
        assert!(has(parent_uid, chain), E_FEE_NOT_SET);
        *table::borrow(borrow_table(parent_uid), chain)
    }

    public fun token_fee(
        parent_uid: &UID,
        chain: u16,
        decimals: u8,
        swap_rate: u64,
        swap_rate_precision: u64,
        relayer_fee_precision: u64
    ): u64 {
        let numerator = (math::pow(10, decimals) as u256) *
            (usd_fee(parent_uid, chain) as u256) *
            (swap_rate_precision as u256);
        let denominator = (swap_rate as u256) *
            (relayer_fee_precision as u256);
        let token_fee = numerator / denominator;

        // Catch overflow.
        assert!(token_fee < (U64_MAX as u256), E_RELAYER_FEE_OVERFLOW);

        // Return u64 casted relayer fee.
        (token_fee as u64)
    }

    public fun has(parent_uid: &UID, chain: u16): bool {
        table::contains<u16, u64>(borrow_table(parent_uid), chain)
    }

    fun borrow_table(parent_uid: &UID): &Table<u16, u64> {
        dynamic_object_field::borrow(parent_uid, KEY)
    }

    fun borrow_table_mut(parent_uid: &mut UID): &mut Table<u16, u64> {
        dynamic_object_field::borrow_mut(parent_uid, KEY)
    }
}
