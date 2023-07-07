use anchor_lang::prelude::*;

use crate::PostedTokenBridgeRelayerMessage;

#[account]
#[derive(Default, InitSpace)]
/// Foreign emitter account data.
pub struct ForeignContract {
    /// Emitter chain. Cannot equal `1` (Solana's Chain ID).
    pub chain: u16,
    /// Emitter address. Cannot be zero address.
    pub address: [u8; 32],
    /// Token Bridge program's foreign endpoint account key.
    pub token_bridge_foreign_endpoint: Pubkey,
}

impl ForeignContract {
    /// AKA `b"foreign_contract"`.
    pub const SEED_PREFIX: &'static [u8; 16] = b"foreign_contract";

    /// Convenience method to check whether an address equals the one saved in
    /// this account.
    pub fn verify(&self, vaa: &PostedTokenBridgeRelayerMessage) -> bool {
        vaa.emitter_chain() == self.chain &&
            *vaa.data().from_address() == self.address
    }
}
