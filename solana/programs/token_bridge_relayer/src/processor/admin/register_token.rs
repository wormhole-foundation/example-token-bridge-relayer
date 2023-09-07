use crate::{
    error::TokenBridgeRelayerError,
    state::{RegisteredToken, SenderConfig},
    token::{spl_token, Mint, Token},
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RegisterToken<'info> {
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

    #[account(
        init,
        payer = owner,
        space = 8 + RegisteredToken::INIT_SPACE,
        seeds = [RegisteredToken::SEED_PREFIX, mint.key().as_ref()],
        bump
    )]
    /// Registered Token account. This account stores information about the
    /// token, including the swap rate and max native swap amount. Create this
    /// account if the mint has not been registered yet. Mutable.
    pub registered_token: Account<'info, RegisteredToken>,

    /// Mint info. This is the SPL token that will be bridged over to the
    /// foreign contract.
    pub mint: Account<'info, Mint>,

    // Token program.
    pub token_program: Program<'info, Token>,

    /// System program.
    pub system_program: Program<'info, System>,
}

pub fn register_token(
    ctx: Context<RegisterToken>,
    swap_rate: u64,
    max_native_swap_amount: u64,
) -> Result<()> {
    require!(swap_rate > 0, TokenBridgeRelayerError::ZeroSwapRate);

    // The max_native_swap_amount must be set to zero for the native mint.
    require!(
        ctx.accounts.mint.key() != spl_token::native_mint::ID || max_native_swap_amount == 0,
        TokenBridgeRelayerError::SwapsNotAllowedForNativeMint
    );

    // Register the token by setting the swap_rate and max_native_swap_amount.
    ctx.accounts.registered_token.set_inner(RegisteredToken {
        swap_rate,
        max_native_swap_amount
    });

    Ok(())
}
