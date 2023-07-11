use crate::{error::TokenBridgeRelayerError, state::SenderConfig};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct PauseOutboundTransfers<'info> {
    /// Owner of the program set in the [`SenderConfig`] account.
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ TokenBridgeRelayerError::OwnerOnly,
        seeds = [SenderConfig::SEED_PREFIX],
        bump
    )]
    /// Sender Config account. This program requires that the `owner` specified
    /// in the context equals the pubkey specified in this account. Mutable.
    pub config: Box<Account<'info, SenderConfig>>,
}

pub fn set_pause_for_transfers(ctx: Context<PauseOutboundTransfers>, paused: bool) -> Result<()> {
    // Set the new paused boolean.
    let sender_config = &mut ctx.accounts.config;
    sender_config.paused = paused;

    Ok(())
}
