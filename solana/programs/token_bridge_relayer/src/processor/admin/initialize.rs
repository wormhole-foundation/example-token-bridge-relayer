use crate::{
    error::TokenBridgeRelayerError,
    state::{OwnerConfig, RedeemerConfig, SenderConfig},
    BpfLoaderUpgradeable, ID, SWAP_RATE_PRECISION
};
use anchor_lang::prelude::*;
use wormhole_anchor_sdk::{token_bridge, wormhole};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    /// Deployer of the program.
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        seeds = [SenderConfig::SEED_PREFIX],
        bump,
        space = 8 + SenderConfig::INIT_SPACE
    )]
    /// Sender Config account, which saves program data useful for other
    /// instructions, specifically for outbound transfers. Also saves the payer
    /// of the [`initialize`](crate::initialize) instruction as the program's
    /// owner.
    pub sender_config: Box<Account<'info, SenderConfig>>,

    #[account(
        init,
        payer = owner,
        seeds = [RedeemerConfig::SEED_PREFIX],
        bump,
        space = 8 + RedeemerConfig::INIT_SPACE
    )]
    /// Redeemer Config account, which saves program data useful for other
    /// instructions, specifically for inbound transfers. Also saves the payer
    /// of the [`initialize`](crate::initialize) instruction as the program's
    /// owner.
    pub redeemer_config: Box<Account<'info, RedeemerConfig>>,

    #[account(
        init,
        payer = owner,
        seeds = [OwnerConfig::SEED_PREFIX],
        bump,
        space = 8 + OwnerConfig::INIT_SPACE
    )]
    /// Owner config account, which saves the owner, assistant and
    /// pending owner keys. This account is used to manage the ownership of the
    /// program.
    pub owner_config: Box<Account<'info, OwnerConfig>>,

    #[account(
        seeds = [token_bridge::SEED_PREFIX_EMITTER],
        bump,
        seeds::program = token_bridge::program::ID
    )]
    /// CHECK: Token Bridge program's emitter account. This isn't an account
    /// that holds data; it is purely just a signer for posting Wormhole
    /// messages on behalf of the Token Bridge program.
    pub token_bridge_emitter: UncheckedAccount<'info>,

    #[account(
        seeds = [
            wormhole::SequenceTracker::SEED_PREFIX,
            token_bridge_emitter.key().as_ref()
        ],
        bump,
        seeds::program = wormhole::program::ID
    )]
    /// Token Bridge emitter's sequence account. Like with all Wormhole
    /// emitters, this account keeps track of the sequence number of the last
    /// posted message.
    pub token_bridge_sequence: Box<Account<'info, wormhole::SequenceTracker>>,

    /// System program.
    pub system_program: Program<'info, System>,

    /// CHECK: BPF Loader Upgradeable program needs to modify this program's data to change the
    /// upgrade authority. We check this PDA address just in case there is another program that this
    /// deployer has deployed.
    ///
    /// NOTE: Set upgrade authority is scary because any public key can be used to set as the
    /// authority.
    #[account(
        mut,
        seeds = [ID.as_ref()],
        bump,
        seeds::program = bpf_loader_upgradeable_program,
    )]
    program_data: AccountInfo<'info>,

    bpf_loader_upgradeable_program: Program<'info, BpfLoaderUpgradeable>,
}

pub fn initialize(
    ctx: Context<Initialize>,
    fee_recipient: Pubkey,
    assistant: Pubkey,
) -> Result<()> {
    require!(
        fee_recipient != Pubkey::default() && assistant != Pubkey::default(),
        TokenBridgeRelayerError::InvalidPublicKey
    );

    // Initial precision value for the relayer fee. We use the 
    // `SWAP_RATE_PRECISION` const value here, because the initial
    // value is the same as the swap rate precision. Unlike the 
    // swap rate precision, the relayer fee precision can be changed. 
    let initial_relayer_fee_precision: u32 = SWAP_RATE_PRECISION;

    let owner = ctx.accounts.owner.key();

    // Initialize program's sender config.
    // * Set the owner of the sender config (effectively the owner of the program).
    // * Set the initial relayer fee precision value.
    // * Set the paused boolean to false. This value controls whether the program will allow
    //   outbound transfers.
    // * Set Token Bridge related addresses.
    ctx.accounts.sender_config.set_inner(SenderConfig {
        owner,
        bump: ctx.bumps["sender_config"],
        token_bridge: crate::OutboundTokenBridgeAddresses {
            sequence: ctx.accounts.token_bridge_sequence.key(),
        },
        relayer_fee_precision: initial_relayer_fee_precision,
        paused: false,
    });

    // Initialize program's redeemer config.
    // * Set the owner of the redeemer config (effectively the owner of the program).
    // * Set the initial relayer fee precision value.
    // * Set the fee recipient.
    ctx.accounts.redeemer_config.set_inner(RedeemerConfig {
        owner,
        bump: ctx.bumps["redeemer_config"],
        relayer_fee_precision: initial_relayer_fee_precision,
        fee_recipient,
    });

    // Initialize program's owner config.
    // * Set the owner and assistant for the owner config.
    ctx.accounts.owner_config.set_inner(OwnerConfig {
        owner,
        assistant,
        pending_owner: None,
    });

    #[cfg(not(feature = "devnet"))]
    {
        // Make the contract immutable by setting the new program authority
        // to `None`.
        solana_program::program::invoke(
            &solana_program::bpf_loader_upgradeable::set_upgrade_authority(
                &ID,
                &ctx.accounts.owner.key(),
                None,
            ),
            &ctx.accounts.to_account_infos(),
        )?;
    }

    Ok(())
}
