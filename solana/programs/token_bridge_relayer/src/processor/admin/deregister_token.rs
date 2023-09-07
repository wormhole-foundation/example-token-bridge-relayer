use crate::{
    error::TokenBridgeRelayerError,
    state::{RegisteredToken, SenderConfig},
    token::Mint,
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct DeregisterToken<'info> {
    /// Owner of the program set in the [`SenderConfig`] account. Signer for
    /// closing [`RegisteredToken`] account.
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
        close = owner,
        seeds = [RegisteredToken::SEED_PREFIX, mint.key().as_ref()],
        bump
    )]
    /// Registered Token account. This account stores information about the
    /// token, including the swap rate and max native swap amount. This account
    /// also determines if a mint is registered or not.
    pub registered_token: Account<'info, RegisteredToken>,
}

pub fn deregister_token(_ctx: Context<DeregisterToken>) -> Result<()> {
    Ok(())
}
