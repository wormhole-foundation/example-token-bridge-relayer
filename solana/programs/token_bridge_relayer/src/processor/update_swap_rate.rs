use crate::{
    error::TokenBridgeRelayerError,
    state::{RegisteredToken, OwnerConfig},
    token::{Mint}
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct UpdateSwapRate<'info> {
    #[account(mut)]
    /// The signer of the transaction. Must be the owner or assistant.
    pub payer: Signer<'info>,

    #[account(
        seeds = [OwnerConfig::SEED_PREFIX],
        bump
    )]
    /// The owner_config is used when updating the swap rate so that the
    /// assistant key can be used in additional to the owner key.
    pub owner_config: Account<'info, OwnerConfig>,

    #[account(
        mut,
        seeds = [b"mint", mint.key().as_ref()],
        bump
    )]
    /// Registered Token account. This account stores information about the
    /// token, including the swap rate and max native swap amount. The program
    /// will modify this account to update the swap rate. Mutable.
    pub registered_token: Account<'info, RegisteredToken>,

    /// Mint info. This is the SPL token that will be bridged over to the
    /// foreign contract.
    pub mint: Account<'info, Mint>,

    /// System program.
    pub system_program: Program<'info, System>,
}

pub fn update_swap_rate(ctx: Context<UpdateSwapRate>, swap_rate: u64) -> Result<()> {
    // Check that the signer is the owner or assistant.
    require!(
        ctx.accounts
            .owner_config
            .is_authorized(&ctx.accounts.payer.key()),
        TokenBridgeRelayerError::OwnerOrAssistantOnly
    );

    // Confirm that the token is registered and the new swap rate
    // is nonzero.
    require!(
        ctx.accounts.registered_token.is_registered,
        TokenBridgeRelayerError::TokenNotRegistered
    );
    require!(swap_rate > 0, TokenBridgeRelayerError::ZeroSwapRate);

    // Set the new swap rate.
    let registered_token = &mut ctx.accounts.registered_token;
    registered_token.swap_rate = swap_rate;

    Ok(())
}
