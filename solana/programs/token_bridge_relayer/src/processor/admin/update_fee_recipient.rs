use crate::{
    error::TokenBridgeRelayerError,
    state::RedeemerConfig,
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct UpdateFeeRecipient<'info> {
    /// Owner of the program set in the [`RedeemerConfig`] account.
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ TokenBridgeRelayerError::OwnerOnly,
        seeds = [RedeemerConfig::SEED_PREFIX],
        bump
    )]
    /// Redeemer Config account, which saves program data useful for other
    /// instructions, specifically for inbound transfers. Also saves the payer
    /// of the [`initialize`](crate::initialize) instruction as the program's
    /// owner.
    pub redeemer_config: Box<Account<'info, RedeemerConfig>>,
}

pub fn update_fee_recipient(
    ctx: Context<UpdateFeeRecipient>,
    new_fee_recipient: Pubkey,
) -> Result<()> {
    require_keys_neq!(
        new_fee_recipient,
        Pubkey::default(),
        TokenBridgeRelayerError::InvalidPublicKey
    );
    require_keys_neq!(
        new_fee_recipient,
        ctx.accounts.redeemer_config.fee_recipient,
        TokenBridgeRelayerError::AlreadyTheFeeRecipient
    );

    // Update the fee_recipient key.
    let redeemer_config = &mut ctx.accounts.redeemer_config;
    redeemer_config.fee_recipient = new_fee_recipient;

    Ok(())
}
