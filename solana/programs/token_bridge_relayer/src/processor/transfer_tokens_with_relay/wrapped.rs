use crate::{
    constants::{SEED_PREFIX_BRIDGED, SEED_PREFIX_TMP},
    error::TokenBridgeRelayerError,
    state::{ForeignContract, RegisteredToken, SenderConfig, SignerSequence},
    token::{Token, TokenAccount},
};
use anchor_lang::prelude::*;
use anchor_spl::token::Mint;
use wormhole_anchor_sdk::{token_bridge, wormhole};

use super::{prepare_transfer, PrepareTransfer};

#[derive(Accounts)]
#[instruction(
    _amount: u64,
    _to_native_token_amount: u64,
    recipient_chain: u16
)]
pub struct TransferWrappedWithRelay<'info> {
    #[account(mut)]
    /// Payer will pay Wormhole fee to transfer tokens.
    pub payer: Signer<'info>,

    /// Used to keep track of payer's Wormhole sequence number.
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + SignerSequence::INIT_SPACE,
        seeds = [SignerSequence::SEED_PREFIX, payer.key().as_ref()],
        bump,
    )]
    payer_sequence: Account<'info, SignerSequence>,

    #[account(
        seeds = [SenderConfig::SEED_PREFIX],
        bump,
        constraint = !config.paused @ TokenBridgeRelayerError::OutboundTransfersPaused
    )]
    /// Sender Config account. Acts as the Token Bridge sender PDA. Mutable.
    pub config: Box<Account<'info, SenderConfig>>,

    #[account(
        seeds = [
            ForeignContract::SEED_PREFIX,
            &recipient_chain.to_be_bytes()[..]
        ],
        bump,
    )]
    /// Foreign Contract account. Send tokens to the contract specified in this
    /// account. Funnily enough, the Token Bridge program does not have any
    /// requirements for outbound transfers for the recipient chain to be
    /// registered. This account provides extra protection against sending
    /// tokens to an unregistered Wormhole chain ID. Read-only.
    pub foreign_contract: Box<Account<'info, ForeignContract>>,

    #[account(mut)]
    /// Token Bridge wrapped mint info. This is the SPL token that will be
    /// bridged to the foreign contract. The wrapped mint PDA must agree
    /// with the native token's metadata. Mutable.
    pub token_bridge_wrapped_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = token_bridge_wrapped_mint,
        associated_token::authority = payer,
    )]
    /// Payer's associated token account. We may want to make this a generic
    /// token account in the future.
    pub from_token_account: Account<'info, TokenAccount>,

    #[account(
        seeds = [RegisteredToken::SEED_PREFIX, token_bridge_wrapped_mint.key().as_ref()],
        bump
    )]
    // Registered token account for the specified mint. This account stores
    // information about the token. Read-only.
    pub registered_token: Box<Account<'info, RegisteredToken>>,

    #[account(
        init,
        payer = payer,
        seeds = [
            SEED_PREFIX_TMP,
            token_bridge_wrapped_mint.key().as_ref(),
        ],
        bump,
        token::mint = token_bridge_wrapped_mint,
        token::authority = config,
    )]
    /// Program's temporary token account. This account is created before the
    /// instruction is invoked to temporarily take custody of the payer's
    /// tokens. When the tokens are finally bridged out, the token account
    /// will have zero balance and can be closed.
    pub tmp_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: Token Bridge program's wrapped metadata, which stores info
    /// about the token from its native chain:
    ///   * Wormhole Chain ID
    ///   * Token's native contract address
    ///   * Token's native decimals
    pub token_bridge_wrapped_meta: UncheckedAccount<'info>,

    /// CHECK: Token Bridge config. Read-only.
    pub token_bridge_config: UncheckedAccount<'info>,

    /// CHECK: Token Bridge authority signer. Read-only.
    pub token_bridge_authority_signer: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Wormhole bridge data. Mutable.
    pub wormhole_bridge: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [
            SEED_PREFIX_BRIDGED,
            payer.key().as_ref(),
            &payer_sequence.to_be_bytes()[..]
        ],
        bump,
    )]
    /// CHECK: Wormhole Message. Token Bridge program writes info about the
    /// tokens transferred in this account.
    pub wormhole_message: UncheckedAccount<'info>,

    /// CHECK: Token Bridge emitter.
    pub token_bridge_emitter: UncheckedAccount<'info>,

    /// CHECK: Token Bridge sequence.
    #[account(mut)]
    pub token_bridge_sequence: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Wormhole fee collector. Mutable.
    pub wormhole_fee_collector: UncheckedAccount<'info>,

    pub wormhole_program: Program<'info, wormhole::program::Wormhole>,
    pub token_bridge_program: Program<'info, token_bridge::program::TokenBridge>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,

    /// CHECK: Token Bridge program needs clock sysvar.
    pub clock: UncheckedAccount<'info>,

    /// CHECK: Token Bridge program needs rent sysvar.
    pub rent: UncheckedAccount<'info>,
}

pub fn transfer_wrapped_tokens_with_relay(
    ctx: Context<TransferWrappedWithRelay>,
    amount: u64,
    to_native_token_amount: u64,
    recipient_chain: u16,
    recipient_address: [u8; 32],
    batch_id: u32,
) -> Result<()> {
    let config = &ctx.accounts.config;
    let wrapped_mint = &ctx.accounts.token_bridge_wrapped_mint;
    let payer = &ctx.accounts.payer;
    let tmp_token_account = &ctx.accounts.tmp_token_account;
    let token_bridge_authority_signer = &ctx.accounts.token_bridge_authority_signer;
    let token_program = &ctx.accounts.token_program;

    // First transfer tokens from payer to tmp_token_account.
    anchor_spl::token::transfer(
        CpiContext::new(
            token_program.to_account_info(),
            anchor_spl::token::Transfer {
                from: ctx.accounts.from_token_account.to_account_info(),
                to: tmp_token_account.to_account_info(),
                authority: payer.to_account_info(),
            },
        ),
        amount,
    )?;

    let msg = prepare_transfer(
        PrepareTransfer {
            config,
            mint: wrapped_mint,
            registered_token: &ctx.accounts.registered_token,
            foreign_contract: &ctx.accounts.foreign_contract,
            tmp_token_account,
            token_bridge_authority_signer,
            token_program,
        },
        amount,
        to_native_token_amount,
        recipient_chain,
        recipient_address,
    )?;

    let config_seeds = &[SenderConfig::SEED_PREFIX, &[config.bump]];

    // Bridge wrapped token with encoded payload.
    token_bridge::transfer_wrapped_with_payload(
        CpiContext::new_with_signer(
            ctx.accounts.token_bridge_program.to_account_info(),
            token_bridge::TransferWrappedWithPayload {
                payer: payer.to_account_info(),
                config: ctx.accounts.token_bridge_config.to_account_info(),
                from: tmp_token_account.to_account_info(),
                from_owner: ctx.accounts.config.to_account_info(),
                wrapped_mint: ctx.accounts.token_bridge_wrapped_mint.to_account_info(),
                wrapped_metadata: ctx.accounts.token_bridge_wrapped_meta.to_account_info(),
                authority_signer: ctx.accounts.token_bridge_authority_signer.to_account_info(),
                wormhole_bridge: ctx.accounts.wormhole_bridge.to_account_info(),
                wormhole_message: ctx.accounts.wormhole_message.to_account_info(),
                wormhole_emitter: ctx.accounts.token_bridge_emitter.to_account_info(),
                wormhole_sequence: ctx.accounts.token_bridge_sequence.to_account_info(),
                wormhole_fee_collector: ctx.accounts.wormhole_fee_collector.to_account_info(),
                clock: ctx.accounts.clock.to_account_info(),
                sender: ctx.accounts.config.to_account_info(),
                rent: ctx.accounts.rent.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: token_program.to_account_info(),
                wormhole_program: ctx.accounts.wormhole_program.to_account_info(),
            },
            &[
                config_seeds,
                &[
                    SEED_PREFIX_BRIDGED,
                    payer.key().as_ref(),
                    &ctx.accounts.payer_sequence.take_and_uptick()[..],
                    &[ctx.bumps["wormhole_message"]],
                ],
            ],
        ),
        batch_id,
        amount,
        ctx.accounts.foreign_contract.address,
        recipient_chain,
        msg.try_to_vec()?,
        &crate::ID,
    )?;

    // Finish instruction by closing tmp_token_account.
    anchor_spl::token::close_account(CpiContext::new_with_signer(
        token_program.to_account_info(),
        anchor_spl::token::CloseAccount {
            account: tmp_token_account.to_account_info(),
            destination: payer.to_account_info(),
            authority: config.to_account_info(),
        },
        &[config_seeds],
    ))
}
