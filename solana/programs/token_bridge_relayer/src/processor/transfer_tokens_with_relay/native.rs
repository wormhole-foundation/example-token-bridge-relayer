use crate::{
    constants::{SEED_PREFIX_BRIDGED, SEED_PREFIX_TMP},
    error::TokenBridgeRelayerError,
    state::{ForeignContract, RegisteredToken, SenderConfig, SignerSequence},
    token::{self, spl_token, Mint, Token, TokenAccount},
};
use anchor_lang::{
    prelude::*,
    system_program::{self, Transfer},
};
use wormhole_anchor_sdk::{token_bridge, wormhole};

use super::{prepare_transfer, PrepareTransfer};

#[derive(Accounts)]
#[instruction(
    _amount: u64,
    _to_native_token_amount: u64,
    recipient_chain: u16
)]
pub struct TransferNativeWithRelay<'info> {
    /// Payer will pay Wormhole fee to transfer tokens and create temporary
    /// token account.
    #[account(mut)]
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
    /// Sender Config account. Acts as the signer for the Token Bridge token
    /// transfer. Read-only.
    pub config: Box<Account<'info, SenderConfig>>,

    #[account(
        seeds = [
            ForeignContract::SEED_PREFIX,
            &recipient_chain.to_be_bytes()
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
    /// Mint info. This is the SPL token that will be bridged over to the
    /// foreign contract. Mutable.
    pub mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = payer,
    )]
    /// Payer's associated token account. We may want to make this a generic
    /// token account in the future.
    pub from_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        seeds = [RegisteredToken::SEED_PREFIX, mint.key().as_ref()],
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
            mint.key().as_ref(),
        ],
        bump,
        token::mint = mint,
        token::authority = config,
    )]
    /// Program's temporary token account. This account is created before the
    /// instruction is invoked to temporarily take custody of the payer's
    /// tokens. When the tokens are finally bridged out, the token account
    /// will have zero balance and can be closed.
    pub tmp_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: Token Bridge config. Read-only.
    pub token_bridge_config: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Token Bridge custody. This is the Token Bridge program's token
    /// account that holds this mint's balance. This account needs to be
    /// unchecked because a token account may not have been created for this
    /// mint yet. Mutable.
    pub token_bridge_custody: UncheckedAccount<'info>,

    /// CHECK: Token Bridge authority signer. Read-only.
    pub token_bridge_authority_signer: UncheckedAccount<'info>,

    /// CHECK: Token Bridge custody signer. Read-only.
    pub token_bridge_custody_signer: UncheckedAccount<'info>,

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
    /// tokens transferred in this account for our program. Mutable.
    pub wormhole_message: AccountInfo<'info>,

    /// CHECK: Token Bridge emitter.
    pub token_bridge_emitter: UncheckedAccount<'info>,

    /// CHECK: Token Bridge sequence.
    #[account(mut)]
    pub token_bridge_sequence: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Wormhole fee collector. Mutable.
    pub wormhole_fee_collector: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub wormhole_program: Program<'info, wormhole::program::Wormhole>,
    pub token_bridge_program: Program<'info, token_bridge::program::TokenBridge>,

    /// CHECK: Token Bridge program needs clock sysvar.
    pub clock: UncheckedAccount<'info>,

    /// CHECK: Token Bridge program needs rent sysvar.
    pub rent: UncheckedAccount<'info>,
}

pub fn transfer_native_tokens_with_relay(
    ctx: Context<TransferNativeWithRelay>,
    amount: u64,
    to_native_token_amount: u64,
    recipient_chain: u16,
    recipient_address: [u8; 32],
    batch_id: u32,
    wrap_native: bool,
) -> Result<()> {
    let mint = &ctx.accounts.mint;

    // Token Bridge program truncates amounts to 8 decimals, so there will
    // be a residual amount if decimals of the SPL is >8. We need to take
    // into account how much will actually be bridged.
    let truncated_amount = token_bridge::truncate_amount(amount, mint.decimals);
    require!(
        truncated_amount > 0,
        TokenBridgeRelayerError::ZeroBridgeAmount
    );

    let config = &ctx.accounts.config;
    let payer = &ctx.accounts.payer;
    let tmp_token_account = &ctx.accounts.tmp_token_account;
    let token_program = &ctx.accounts.token_program;
    let system_program = &ctx.accounts.system_program;

    // These seeds are used to:
    // 1.  Sign the Sender Config's token account to delegate approval
    //     of truncated_amount.
    // 2.  Sign Token Bridge program's transfer_native instruction.
    // 3.  Close tmp_token_account.
    let config_seeds = &[SenderConfig::SEED_PREFIX, &[config.bump]];

    // If the user wishes to transfer native SOL, we need to transfer the
    // lamports to the tmp_token_account and then convert it to native SOL. Otherwise,
    // we can just transfer the specified token to the tmp_token_account.
    if wrap_native {
        require!(
            mint.key() == spl_token::native_mint::ID,
            TokenBridgeRelayerError::NativeMintRequired
        );

        // Transfer lamports to the tmp_token_account (these lamports will be our WSOL).
        system_program::transfer(
            CpiContext::new(
                system_program.to_account_info(),
                Transfer {
                    from: payer.to_account_info(),
                    to: tmp_token_account.to_account_info(),
                },
            ),
            truncated_amount,
        )?;

        // Sync the token account based on the lamports we sent it,
        // this is where the wrapping takes place.
        token::sync_native(CpiContext::new(
            token_program.to_account_info(),
            token::SyncNative {
                account: tmp_token_account.to_account_info(),
            },
        ))?;
    } else {
        anchor_spl::token::transfer(
            CpiContext::new(
                token_program.to_account_info(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.from_token_account.to_account_info(),
                    to: tmp_token_account.to_account_info(),
                    authority: payer.to_account_info(),
                },
            ),
            truncated_amount,
        )?;
    }

    let token_bridge_authority_signer = &ctx.accounts.token_bridge_authority_signer;

    let msg = prepare_transfer(
        PrepareTransfer {
            config,
            mint,
            registered_token: &ctx.accounts.registered_token,
            foreign_contract: &ctx.accounts.foreign_contract,
            tmp_token_account,
            token_bridge_authority_signer,
            token_program,
        },
        truncated_amount,
        to_native_token_amount,
        recipient_chain,
        recipient_address,
    )?;

    // Bridge native token with encoded payload.
    token_bridge::transfer_native_with_payload(
        CpiContext::new_with_signer(
            ctx.accounts.token_bridge_program.to_account_info(),
            token_bridge::TransferNativeWithPayload {
                payer: payer.to_account_info(),
                config: ctx.accounts.token_bridge_config.to_account_info(),
                from: tmp_token_account.to_account_info(),
                mint: mint.to_account_info(),
                custody: ctx.accounts.token_bridge_custody.to_account_info(),
                authority_signer: token_bridge_authority_signer.to_account_info(),
                custody_signer: ctx.accounts.token_bridge_custody_signer.to_account_info(),
                wormhole_bridge: ctx.accounts.wormhole_bridge.to_account_info(),
                wormhole_message: ctx.accounts.wormhole_message.to_account_info(),
                wormhole_emitter: ctx.accounts.token_bridge_emitter.to_account_info(),
                wormhole_sequence: ctx.accounts.token_bridge_sequence.to_account_info(),
                wormhole_fee_collector: ctx.accounts.wormhole_fee_collector.to_account_info(),
                clock: ctx.accounts.clock.to_account_info(),
                sender: config.to_account_info(),
                rent: ctx.accounts.rent.to_account_info(),
                system_program: system_program.to_account_info(),
                token_program: token_program.to_account_info(),
                wormhole_program: ctx.accounts.wormhole_program.to_account_info(),
            },
            &[
                &config_seeds[..],
                &[
                    SEED_PREFIX_BRIDGED,
                    payer.key().as_ref(),
                    &ctx.accounts.payer_sequence.take_and_uptick()[..],
                    &[ctx.bumps["wormhole_message"]],
                ],
            ],
        ),
        batch_id,
        truncated_amount,
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
        &[&config_seeds[..]],
    ))
}
