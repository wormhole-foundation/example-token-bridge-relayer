use anchor_lang::prelude::*;
use wormhole_anchor_sdk::token_bridge;

#[derive(Default, AnchorSerialize, AnchorDeserialize, Copy, Clone, PartialEq, Eq, InitSpace)]
pub struct InboundTokenBridgeAddresses {
    // program pdas
    pub config: Pubkey,
    pub custody_signer: Pubkey,
    pub mint_authority: Pubkey,
}

#[account]
#[derive(Default, InitSpace)]
pub struct RedeemerConfig {
    /// Program's owner.
    pub owner: Pubkey,
    /// PDA bump.
    pub bump: u8,
    /// Token Bridge program's relevant addresses.
    pub token_bridge: InboundTokenBridgeAddresses,

    /// Relayer fee and swap rate precision.
    pub relayer_fee_precision: u32,
    pub swap_rate_precision: u32,

    /// Recipient of all relayer fees and swap proceeds.
    pub fee_recipient: Pubkey,
}

impl RedeemerConfig {
    /// AKA `b"redeemer"`.
    pub const SEED_PREFIX: &'static [u8; 8] = token_bridge::SEED_PREFIX_REDEEMER;
}
