use crate::{
    error::TokenBridgeRelayerError,
    state::{ForeignContract, OwnerConfig}
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(chain: u16)]
pub struct UpdateRelayerFee<'info> {
    #[account(mut)]
    /// Signer of the transaction. Must be the owner or assistant.
    pub payer: Signer<'info>,

    #[account(
        seeds = [OwnerConfig::SEED_PREFIX],
        bump
    )]
    /// The owner_config is used when updating the swap rate
    /// so that the assistant key can be used in addition to the
    /// owner key.
    pub owner_config: Account<'info, OwnerConfig>,

    #[account(
        mut,
        seeds = [
            ForeignContract::SEED_PREFIX,
            &chain.to_be_bytes()[..]
        ],
        bump
    )]
    /// This account holds the USD denominated relayer fee for the specified
    /// `chain`. This account is used to determine the cost of relaying
    /// a transfer to a target chain. If there already is a relayer fee
    /// saved in this account, overwrite it.
    pub foreign_contract: Box<Account<'info, ForeignContract>>,

    /// System program.
    pub system_program: Program<'info, System>,
}

pub fn update_relayer_fee(ctx: Context<UpdateRelayerFee>, _chain: u16, fee: u64) -> Result<()> {
    // Check that the signer is the owner or assistant.
    require!(
        ctx.accounts
            .owner_config
            .is_authorized(&ctx.accounts.payer.key()),
        TokenBridgeRelayerError::OwnerOrAssistantOnly
    );

    // NOTE: We do not have to check if the chain ID is valid Since the
    // ForeignContract account is required, this means the account has been
    // created and passed the checks required for successfully registering
    // an emitter.

    // Save the chain and fee information in the RelayerFee account.
    let foreign_contract = &mut ctx.accounts.foreign_contract;
    foreign_contract.fee = fee;

    Ok(())
}
