use crate::{
    error::TokenBridgeRelayerError,
    state::{RegisteredToken, SenderConfig},
    token::{spl_token, Mint},
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct UpdateMaxNativeSwapAmount<'info> {
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
        mut,
        seeds = [RegisteredToken::SEED_PREFIX, mint.key().as_ref()],
        bump
    )]
    /// Registered Token account. This account stores information about the
    /// token, including the swap rate and max native swap amount. The program
    /// will modify this account when the swap rate or max native swap amount
    /// changes. Mutable.
    pub registered_token: Account<'info, RegisteredToken>,

    /// Mint info. This is the SPL token that will be bridged over to the
    /// foreign contract.
    pub mint: Account<'info, Mint>,
}

pub fn update_max_native_swap_amount(
    ctx: Context<UpdateMaxNativeSwapAmount>,
    max_native_swap_amount: u64,
) -> Result<()> {
    // The max_native_swap_amount must be set to zero for the native mint.
    require!(
        ctx.accounts.mint.key() != spl_token::native_mint::ID || max_native_swap_amount == 0,
        TokenBridgeRelayerError::SwapsNotAllowedForNativeMint
    );

    // Set the new max_native_swap_amount.
    let registered_token = &mut ctx.accounts.registered_token;
    registered_token.max_native_swap_amount = max_native_swap_amount;

    Ok(())
}
