module token_bridge_relayer::foreign_contracts {
    use sui::dynamic_object_field::{Self};
    use sui::object::{UID};
    use sui::table::{Self, Table};
    use sui::tx_context::{TxContext};

    use wormhole::state::{chain_id};
    use wormhole::external_address::{Self, ExternalAddress};

    // Errors.
    const E_INVALID_CHAIN: u64 = 0;
    const E_INVALID_CONTRACT_ADDRESS: u64 = 1;
    const E_CONTRACT_DOES_NOT_EXIST: u64 = 2;

    const KEY: vector<u8> = b"foreign_contracts";

    /// Creates new dynamic object field using the stateId as the parent. The
    /// dynamic object field hosts a chainId to emitter mapping.
    public fun new(parent_uid: &mut UID, ctx: &mut TxContext) {
        dynamic_object_field::add(
            parent_uid,
            KEY,
            table::new<u16, ExternalAddress>(ctx)
        );
    }

    public fun has(parent_uid: &UID, chain: u16): bool {
        table::contains<u16, ExternalAddress>(borrow_table(parent_uid), chain)
    }

    /// Returns an address associated with a registered chain ID.
    public fun contract_address(parent_uid: &UID, chain: u16): &ExternalAddress {
        assert!(has(parent_uid, chain), E_CONTRACT_DOES_NOT_EXIST);
        table::borrow(borrow_table(parent_uid), chain)
    }

    /// Adds a new chain ID => contract address mapping.
    public fun add(
        parent_uid: &mut UID,
        chain: u16,
        contract_address: ExternalAddress,
    ) {
        assert!(chain != 0 && chain != chain_id(), E_INVALID_CHAIN);
        assert!(
            external_address::is_nonzero(&contract_address),
            E_INVALID_CONTRACT_ADDRESS
        );

        table::add(borrow_table_mut(parent_uid), chain, contract_address);
    }

    /// Updates an existing chain ID => contract address mapping. The
    /// new address cannot be the zero address.
    public fun update(
        parent_uid: &mut UID,
        chain: u16,
        contract_address: ExternalAddress
    ) {
        assert!(
            external_address::is_nonzero(&contract_address),
            E_INVALID_CONTRACT_ADDRESS
        );

        *table::borrow_mut(
            borrow_table_mut(parent_uid),
            chain
        ) = contract_address;
    }

    fun borrow_table(parent_uid: &UID): &Table<u16, ExternalAddress> {
        dynamic_object_field::borrow(parent_uid, KEY)
    }

    fun borrow_table_mut(parent_uid: &mut UID): &mut Table<u16, ExternalAddress> {
        dynamic_object_field::borrow_mut(parent_uid, KEY)
    }
}
