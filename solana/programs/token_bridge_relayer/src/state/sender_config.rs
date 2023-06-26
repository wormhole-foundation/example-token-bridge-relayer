use anchor_lang::prelude::*;
use wormhole_anchor_sdk::token_bridge;

#[derive(Default, AnchorSerialize, AnchorDeserialize, Copy, Clone, PartialEq, Eq, InitSpace)]
pub struct OutboundTokenBridgeAddresses {
    // program pdas
    pub config: Pubkey,
    pub authority_signer: Pubkey,
    pub custody_signer: Pubkey,
    pub emitter: Pubkey,
    pub sequence: Pubkey,
    /// [BridgeData](wormhole_anchor_sdk::wormhole::BridgeData) address.
    pub wormhole_bridge: Pubkey,
    /// [FeeCollector](wormhole_anchor_sdk::wormhole::FeeCollector) address.
    pub wormhole_fee_collector: Pubkey,
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

    /// AKA consistency level. u8 representation of Solana's
    /// [Finality](wormhole_anchor_sdk::wormhole::Finality).
    pub finality: u8,

    /// Relayer fee and swap rate precision.
    pub relayer_fee_precision: u32,
    pub swap_rate_precision: u32,
}

impl SenderConfig {
    /// AKA `b"sender"`.
    pub const SEED_PREFIX: &'static [u8; 6] = token_bridge::SEED_PREFIX_SENDER;
}
