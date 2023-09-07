use crate::{
    error::TokenBridgeRelayerError,
    state::{OwnerConfig, RedeemerConfig, SenderConfig},
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ManageOwnership<'info> {
    /// Owner of the program set in the [`OwnerConfig`] account.
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ TokenBridgeRelayerError::OwnerOnly,
        seeds = [OwnerConfig::SEED_PREFIX],
        bump
    )]
    /// Owner Config account. This program requires that the `owner` specified
    /// in the context equals the pubkey specified in this account. Mutable.
    pub owner_config: Account<'info, OwnerConfig>,
}

#[derive(Accounts)]
pub struct ConfirmOwnershipTransfer<'info> {
    /// Must be the pending owner of the program set in the [`OwnerConfig`]
    /// account.
    pub pending_owner: Signer<'info>,

    #[account(
        mut,
        seeds = [OwnerConfig::SEED_PREFIX],
        bump
    )]
    /// Owner Config account. This program requires that the `pending_owner`
    /// specified in the context equals the pubkey specified in this account.
    pub owner_config: Account<'info, OwnerConfig>,

    #[account(
        mut,
        seeds = [SenderConfig::SEED_PREFIX],
        bump
    )]
    /// Sender Config account. This instruction will update the `owner`
    /// specified in this account to the `pending_owner` specified in the
    /// [`OwnerConfig`] account. Mutable.
    pub sender_config: Box<Account<'info, SenderConfig>>,

    #[account(
        mut,
        seeds = [RedeemerConfig::SEED_PREFIX],
        bump
    )]
    /// Redeemer Config account. This instruction will update the `owner`
    /// specified in this account to the `pending_owner` specified in the
    /// [`OwnerConfig`] account. Mutable.
    pub redeemer_config: Box<Account<'info, RedeemerConfig>>,
}

pub fn submit_ownership_transfer_request(
    ctx: Context<ManageOwnership>,
    new_owner: Pubkey,
) -> Result<()> {
    require_keys_neq!(
        new_owner,
        Pubkey::default(),
        TokenBridgeRelayerError::InvalidPublicKey
    );
    require_keys_neq!(
        new_owner,
        ctx.accounts.owner_config.owner,
        TokenBridgeRelayerError::AlreadyTheOwner
    );

    let owner_config = &mut ctx.accounts.owner_config;
    owner_config.pending_owner = Some(new_owner);

    Ok(())
}

pub fn confirm_ownership_transfer_request(ctx: Context<ConfirmOwnershipTransfer>) -> Result<()> {
    // Check that the signer is the pending owner.
    let pending_owner = ctx.accounts.pending_owner.key();
    require!(
        ctx.accounts.owner_config.is_pending_owner(&pending_owner),
        TokenBridgeRelayerError::NotPendingOwner
    );

    // Update the sender config.
    let sender_config = &mut ctx.accounts.sender_config;
    sender_config.owner = pending_owner;

    // Update the redeemer config.
    let redeemer_config = &mut ctx.accounts.redeemer_config;
    redeemer_config.owner = pending_owner;

    let owner_config = &mut ctx.accounts.owner_config;
    owner_config.owner = pending_owner;
    owner_config.pending_owner = None;

    Ok(())
}

pub fn cancel_ownership_transfer_request(ctx: Context<ManageOwnership>) -> Result<()> {
    let owner_config = &mut ctx.accounts.owner_config;
    owner_config.pending_owner = None;

    Ok(())
}

pub fn update_assistant(
    ctx: Context<ManageOwnership>,
    new_assistant: Pubkey,
) -> Result<()> {
    require_keys_neq!(
        new_assistant,
        Pubkey::default(),
        TokenBridgeRelayerError::InvalidPublicKey
    );
    require_keys_neq!(
        new_assistant,
        ctx.accounts.owner_config.assistant,
        TokenBridgeRelayerError::AlreadyTheAssistant
    );

    // Update the assistant key.
    let owner_config = &mut ctx.accounts.owner_config;
    owner_config.assistant = new_assistant;

    Ok(())
}
