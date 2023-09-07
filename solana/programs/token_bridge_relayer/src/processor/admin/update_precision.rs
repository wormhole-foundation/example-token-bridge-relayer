use crate::{
    error::TokenBridgeRelayerError,
    state::{RedeemerConfig, SenderConfig},
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
// This context is used to update the relayer_fee_precision. This value
// is used to scale the `relayer_fee` that is paid to the `fee_recipient`
// upon redeeming a token transfer. 
pub struct UpdatePrecision<'info> {
    /// Owner of the program set in the [`RedeemerConfig`] and [`SenderConfig`] account.
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ TokenBridgeRelayerError::OwnerOnly,
        seeds = [RedeemerConfig::SEED_PREFIX],
        bump
    )]
    /// Redeemer Config account. This program requires that the `owner`
    /// specified in the context equals the pubkey specified in this account.
    /// Mutable.
    pub redeemer_config: Box<Account<'info, RedeemerConfig>>,

    #[account(
        mut,
        has_one = owner @ TokenBridgeRelayerError::OwnerOnly,
        seeds = [SenderConfig::SEED_PREFIX],
        bump
    )]
    /// Sender Config account. This program requires that the `owner`
    /// specified in the context equals the pubkey specified in this account.
    /// Mutable. The `owner` check is redundant here, but we keep it as an
    /// extra protection for future changes to the context. Mutable.
    pub sender_config: Box<Account<'info, SenderConfig>>,
}

pub fn update_relayer_fee_precision(
    ctx: Context<UpdatePrecision>,
    relayer_fee_precision: u32,
) -> Result<()> {
    require!(
        relayer_fee_precision > 0,
        TokenBridgeRelayerError::InvalidPrecision,
    );
    let redeemer_config = &mut ctx.accounts.redeemer_config;
    let sender_config = &mut ctx.accounts.sender_config;
    redeemer_config.relayer_fee_precision = relayer_fee_precision;
    sender_config.relayer_fee_precision = relayer_fee_precision;

    // Done.
    Ok(())
}
