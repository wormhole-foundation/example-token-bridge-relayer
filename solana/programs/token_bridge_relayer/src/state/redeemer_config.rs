use anchor_lang::prelude::*;
use wormhole_anchor_sdk::token_bridge;

#[account]
#[derive(Default, InitSpace)]
pub struct RedeemerConfig {
    /// Program's owner.
    pub owner: Pubkey,
    /// PDA bump.
    pub bump: u8,

    /// Relayer fee and swap rate precision.
    pub relayer_fee_precision: u32,

    /// Recipient of all relayer fees and swap proceeds.
    pub fee_recipient: Pubkey,
}

impl RedeemerConfig {
    pub const SEED_PREFIX: &'static [u8; 8] = token_bridge::SEED_PREFIX_REDEEMER;
}
