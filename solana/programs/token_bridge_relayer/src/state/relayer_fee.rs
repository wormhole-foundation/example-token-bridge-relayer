use anchor_lang::prelude::*;

#[account]
#[derive(Default, InitSpace)]
/// Outbound relayer fee data.
pub struct RelayerFee {
    /// Emitter chain. Cannot equal `1` (Solana's Chain ID).
    pub chain: u16,
    /// Relayer fee in USD terms.
    pub fee: u64
}

impl RelayerFee {
    /// AKA `b"relayer_fee"`.
    pub const SEED_PREFIX: &'static [u8; 11] = b"relayer_fee";
}
