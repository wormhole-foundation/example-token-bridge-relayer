use crate::{
    error::TokenBridgeRelayerError,
    state::{OwnerConfig, RegisteredToken},
    token::Mint,
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct UpdateSwapRate<'info> {
    /// The signer of the transaction. Must be the owner or assistant.
    pub owner: Signer<'info>,

    #[account(
        seeds = [OwnerConfig::SEED_PREFIX],
        bump
    )]
    /// The owner_config is used when updating the swap rate so that the
    /// assistant key can be used in additional to the owner key.
    pub owner_config: Account<'info, OwnerConfig>,

    #[account(
        mut,
        seeds = [RegisteredToken::SEED_PREFIX, mint.key().as_ref()],
        bump
    )]
    /// Registered Token account. This account stores information about the
    /// token, including the swap rate and max native swap amount. The program
    /// will modify this account to update the swap rate. Mutable.
    pub registered_token: Account<'info, RegisteredToken>,

    /// Mint info. This is the SPL token that will be bridged over to the
    /// foreign contract.
    pub mint: Account<'info, Mint>,
}

pub fn update_swap_rate(ctx: Context<UpdateSwapRate>, swap_rate: u64) -> Result<()> {
    // Check that the signer is the owner or assistant.
    require!(
        ctx.accounts
            .owner_config
            .is_authorized(&ctx.accounts.owner.key()),
        TokenBridgeRelayerError::OwnerOrAssistantOnly
    );

    // Confirm that the token is registered and the new swap rate
    // is nonzero.
    require!(swap_rate > 0, TokenBridgeRelayerError::ZeroSwapRate);

    // Set the new swap rate.
    let registered_token = &mut ctx.accounts.registered_token;
    registered_token.swap_rate = swap_rate;

    Ok(())
}
