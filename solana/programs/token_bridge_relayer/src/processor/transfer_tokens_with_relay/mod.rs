mod native;
mod wrapped;

pub use native::*;
pub use wrapped::*;

use crate::{
    error::TokenBridgeRelayerError,
    message::TokenBridgeRelayerMessage,
    utils::valid_foreign_address,
    state::{RegisteredToken, SenderConfig, ForeignContract},
};
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use wormhole_anchor_sdk::token_bridge;

struct PrepareTransfer<'ctx, 'info> {
    pub config: &'ctx Account<'info, SenderConfig>,
    pub mint: &'ctx Account<'info, Mint>,
    pub registered_token: &'ctx Account<'info, RegisteredToken>,
    pub foreign_contract: &'ctx Account<'info, ForeignContract>,
    pub tmp_token_account: &'ctx Account<'info, TokenAccount>,
    pub token_bridge_authority_signer: &'ctx UncheckedAccount<'info>,
    pub token_program: &'ctx Program<'info, Token>,
}

fn prepare_transfer(
    prepare_transfer: PrepareTransfer,
    amount: u64,
    to_native_token_amount: u64,
    recipient_chain: u16,
    recipient: [u8; 32],
) -> Result<TokenBridgeRelayerMessage> {
    let PrepareTransfer {
        config,
        mint,
        registered_token,
        foreign_contract,
        tmp_token_account,
        token_bridge_authority_signer,
        token_program,
    } = prepare_transfer;
    require!(
        valid_foreign_address(recipient_chain, &recipient),
        TokenBridgeRelayerError::InvalidRecipient,
    );

    // Normalize the to_native_token_amount.
    let normalized_to_native_amount =
        token_bridge::normalize_amount(to_native_token_amount, mint.decimals);
    require!(
        to_native_token_amount == 0 || normalized_to_native_amount > 0,
        TokenBridgeRelayerError::InvalidToNativeAmount
    );

    // Compute the relayer fee in terms of the native token being
    // transferred.
    let relayer_fee = foreign_contract
        .checked_token_fee(
            mint.decimals,
            registered_token.swap_rate,
            config.relayer_fee_precision,
        )
        .ok_or(TokenBridgeRelayerError::FeeCalculationError)?;
    let normalized_relayer_fee = token_bridge::normalize_amount(relayer_fee, mint.decimals);

    // Confirm that the user has sent enough tokens to cover the native
    // swap on the target chain and to the pay relayer fee.
    require!(
        token_bridge::normalize_amount(amount, mint.decimals)
            > normalized_to_native_amount + normalized_relayer_fee,
        TokenBridgeRelayerError::InsufficientFunds
    );

    // These seeds are used to:
    // 1.  Sign the Sender Config's token account to delegate approval
    //     of amount.
    // 2.  Sign Token Bridge program's transfer_wrapped instruction.
    // 3.  Close tmp_token_account.
    let config_seeds = &[SenderConfig::SEED_PREFIX, &[config.bump]];

    // Delegate spending to Token Bridge program's authority signer.
    anchor_spl::token::approve(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            anchor_spl::token::Approve {
                to: tmp_token_account.to_account_info(),
                delegate: token_bridge_authority_signer.to_account_info(),
                authority: config.to_account_info(),
            },
            &[&config_seeds[..]],
        ),
        amount,
    )?;

    // Serialize TokenBridgeRelayerMessage as encoded payload for Token Bridge
    // transfer.
    Ok(TokenBridgeRelayerMessage::TransferWithRelay {
        target_relayer_fee: normalized_relayer_fee,
        to_native_token_amount: normalized_to_native_amount,
        recipient,
    })
}
