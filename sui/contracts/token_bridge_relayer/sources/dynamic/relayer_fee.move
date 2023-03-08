module token_bridge_relayer::relayer_fees {
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
    public fun fee(parent_uid: &UID, chain: u16): u64 {
        assert!(has(parent_uid, chain), E_FEE_NOT_SET);

        // TODO: ask Karl if this should return value or reference, and why?
        *table::borrow(borrow_table(parent_uid), chain)
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
