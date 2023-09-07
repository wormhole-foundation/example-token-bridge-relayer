use anchor_lang::prelude::*;
use wormhole_anchor_sdk::token_bridge;

#[derive(Default, AnchorSerialize, AnchorDeserialize, Copy, Clone, PartialEq, Eq, InitSpace)]
pub struct OutboundTokenBridgeAddresses {
    // Program pdas.
    pub sequence: Pubkey,
}

#[account]
#[derive(Default, InitSpace)]
pub struct SenderConfig {
    /// Program's owner.
    pub owner: Pubkey,
    /// PDA bump.
    pub bump: u8,
    /// Token Bridge program's relevant addresses.
    pub token_bridge: OutboundTokenBridgeAddresses,

    /// Relayer fee and swap rate precision.
    pub relayer_fee_precision: u32,

    /// Boolean indicating whether outbound transfers are paused.
    pub paused: bool,
}

impl SenderConfig {
    pub const SEED_PREFIX: &'static [u8] = token_bridge::SEED_PREFIX_SENDER;
}
