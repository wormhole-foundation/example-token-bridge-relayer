use crate::{
    error::TokenBridgeRelayerError,
    state::{SenderConfig, RegisteredToken},
    token::{Mint}
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct DeregisterToken<'info> {
    #[account(mut)]
    /// Owner of the program set in the [`SenderConfig`] account. Signer for
    /// creating [`ForeignContract`] account.
    pub owner: Signer<'info>,

    #[account(
        has_one = owner @ TokenBridgeRelayerError::OwnerOnly,
        seeds = [SenderConfig::SEED_PREFIX],
        bump
    )]
    /// Sender Config account. This program requires that the `owner` specified
    /// in the context equals the pubkey specified in this account. Read-only.
    pub config: Box<Account<'info, SenderConfig>>,

    /// Mint info. This is the SPL token that will be bridged over to the
    /// foreign contract.
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [b"mint", mint.key().as_ref()],
        bump
    )]
    /// Registered Token account. This account stores information about the
    /// token, including the swap rate and max native swap amount. This account
    /// also determines if a mint is registered or not.
    pub registered_token: Account<'info, RegisteredToken>,

    /// System program.
    pub system_program: Program<'info, System>,
}

pub fn deregister_token(ctx: Context<DeregisterToken>) -> Result<()> {
    require!(
        ctx.accounts.registered_token.is_registered,
        TokenBridgeRelayerError::TokenAlreadyRegistered
    );

    // Register the token by setting the swap_rate and max_native_swap_amount.
    ctx.accounts.registered_token.set_inner(RegisteredToken {
        swap_rate: 0,
        max_native_swap_amount: 0,
        is_registered: false,
    });

    Ok(())
}
