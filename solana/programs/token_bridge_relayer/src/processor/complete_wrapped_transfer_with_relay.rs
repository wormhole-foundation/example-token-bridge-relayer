use crate::{
    error::TokenBridgeRelayerError,
    message::TokenBridgeRelayerMessage,
    state::{RegisteredToken, RedeemerConfig, ForeignContract},
    token::{Token, TokenAccount, spl_token},
    constants::{SEED_PREFIX_TMP},
    PostedTokenBridgeRelayerMessage
};
use anchor_spl::associated_token::{AssociatedToken};
use wormhole_anchor_sdk::{token_bridge, wormhole};
use anchor_lang::{
    prelude::*,
    system_program::{self, Transfer},
};

#[derive(Accounts)]
#[instruction(vaa_hash: [u8; 32])]
pub struct CompleteWrappedWithRelay<'info> {
    #[account(mut)]
    /// Payer will pay Wormhole fee to transfer tokens and create temporary
    /// token account.
    pub payer: Signer<'info>,

    #[account(
        seeds = [RedeemerConfig::SEED_PREFIX],
        bump
    )]
    /// Redeemer Config account. Acts as the Token Bridge redeemer, which signs
    /// for the complete transfer instruction. Read-only.
    pub config: Box<Account<'info, RedeemerConfig>>,

    #[account(
        mut,
        associated_token::mint = token_bridge_wrapped_mint,
        associated_token::authority = config.fee_recipient
    )]
    /// Fee recipient's token account. Must be an associated token account. Mutable.
    pub fee_recipient_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        seeds = [
            ForeignContract::SEED_PREFIX,
            &vaa.emitter_chain().to_le_bytes()[..]
        ],
        bump,
        constraint = foreign_contract.verify(&vaa) @ TokenBridgeRelayerError::InvalidForeignContract
    )]
    /// Foreign Contract account. The registered contract specified in this
    /// account must agree with the target address for the Token Bridge's token
    /// transfer. Read-only.
    pub foreign_contract: Box<Account<'info, ForeignContract>>,

    #[account(
        mut,
        seeds = [
            token_bridge::WrappedMint::SEED_PREFIX,
            &vaa.data().token_chain().to_be_bytes(),
            vaa.data().token_address()
        ],
        bump,
        seeds::program = token_bridge_program
    )]
    /// Token Bridge wrapped mint info. This is the SPL token that will be
    /// bridged from the foreign contract. The wrapped mint PDA must agree
    /// with the native token's metadata in the wormhole message. Mutable.
    pub token_bridge_wrapped_mint: Box<Account<'info, token_bridge::WrappedMint>>,

    #[account(
        mut,
        associated_token::mint = token_bridge_wrapped_mint,
        associated_token::authority = recipient
    )]
    /// Recipient associated token account. The recipient authority check
    /// is necessary to ensure that the recipient is the intended recipient
    /// of the bridged tokens. Mutable.
    pub recipient_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    /// CHECK: recipient may differ from payer if a relayer paid for this
    /// transaction. This instruction verifies that the recipient key
    /// passed in this context matches the intended recipient in the vaa.
    pub recipient: UncheckedAccount<'info>,

    #[account(
        seeds = [b"mint", token_bridge_wrapped_mint.key().as_ref()],
        bump
    )]
    // Registered token account for the specified mint. This account stores
    // information about the token. Read-only.
    pub registered_token: Box<Account<'info, RegisteredToken>>,

    #[account(
        seeds = [b"mint", spl_token::native_mint::ID.as_ref()],
        bump
    )]
    // Registered token account for the native mint. This account stores
    // information about the token and is used for the swap rate. Read-only.
    pub native_registered_token: Box<Account<'info, RegisteredToken>>,

    #[account(
        init,
        payer = payer,
        seeds = [
            SEED_PREFIX_TMP,
            token_bridge_wrapped_mint.key().as_ref(),
        ],
        bump,
        token::mint = token_bridge_wrapped_mint,
        token::authority = config
    )]
    /// Program's temporary token account. This account is created before the
    /// instruction is invoked to temporarily take custody of the payer's
    /// tokens. When the tokens are finally bridged in, the tokens will be
    /// transferred to the destination token accounts. This account will have
    /// zero balance and can be closed.
    pub tmp_token_account: Box<Account<'info, TokenAccount>>,

    /// Wormhole program.
    pub wormhole_program: Program<'info, wormhole::program::Wormhole>,

    /// Token Bridge program.
    pub token_bridge_program: Program<'info, token_bridge::program::TokenBridge>,

    #[account(
        seeds = [
            token_bridge::WrappedMeta::SEED_PREFIX,
            token_bridge_wrapped_mint.key().as_ref()
        ],
        bump,
        seeds::program = token_bridge_program
    )]
    /// Token Bridge program's wrapped metadata, which stores info
    /// about the token from its native chain:
    ///   * Wormhole Chain ID
    ///   * Token's native contract address
    ///   * Token's native decimals
    pub token_bridge_wrapped_meta: Box<Account<'info, token_bridge::WrappedMeta>>,

    #[account(
        address = config.token_bridge.config @ TokenBridgeRelayerError::InvalidTokenBridgeConfig
    )]
    /// CHECK: Token Bridge config. Read-only.
    pub token_bridge_config: UncheckedAccount<'info>,

    #[account(
        seeds = [
            wormhole::SEED_PREFIX_POSTED_VAA,
            &vaa_hash
        ],
        bump,
        seeds::program = wormhole_program,
        constraint = vaa.data().to() == *program_id || vaa.data().to() == config.key() @ TokenBridgeRelayerError::InvalidTransferToAddress,
        constraint = vaa.data().to_chain() == wormhole::CHAIN_ID_SOLANA @ TokenBridgeRelayerError::InvalidTransferToChain,
        constraint = vaa.data().token_chain() != wormhole::CHAIN_ID_SOLANA @ TokenBridgeRelayerError::InvalidTransferTokenChain
    )]
    /// Verified Wormhole message account. The Wormhole program verified
    /// signatures and posted the account data here. Read-only.
    pub vaa: Box<Account<'info, PostedTokenBridgeRelayerMessage>>,

    #[account(mut)]
    /// CHECK: Token Bridge claim account. It stores a boolean, whose value
    /// is true if the bridged assets have been claimed. If the transfer has
    /// not been redeemed, this account will not exist yet.
    pub token_bridge_claim: UncheckedAccount<'info>,

    #[account(
        address = foreign_contract.token_bridge_foreign_endpoint @ TokenBridgeRelayerError::InvalidTokenBridgeForeignEndpoint
    )]
    /// Token Bridge foreign endpoint. This account should really be one
    /// endpoint per chain, but the PDA allows for multiple endpoints for each
    /// chain! We store the proper endpoint for the emitter chain.
    pub token_bridge_foreign_endpoint: Account<'info, token_bridge::EndpointRegistration>,

    #[account(
        address = config.token_bridge.mint_authority @ TokenBridgeRelayerError::InvalidTokenBridgeMintAuthority
    )]
    /// CHECK: Token Bridge custody signer. Read-only.
    pub token_bridge_mint_authority: UncheckedAccount<'info>,

    /// System program.
    pub system_program: Program<'info, System>,

    /// Token program.
    pub token_program: Program<'info, Token>,

    /// Associated Token program.
    pub associated_token_program: Program<'info, AssociatedToken>,

    /// Rent sysvar.
    pub rent: Sysvar<'info, Rent>,
}

pub fn complete_wrapped_transfer_with_relay(
    ctx: Context<CompleteWrappedWithRelay>,
    _vaa_hash: [u8; 32],
) -> Result<()> {
    // The Token Bridge program's claim account is only initialized when
    // a transfer is redeemed (and the boolean value `true` is written as
    // its data).
    //
    // The Token Bridge program will automatically fail if this transfer
    // is redeemed again. But we choose to short-circuit the failure as the
    // first evaluation of this instruction.
    require!(
        ctx.accounts.token_bridge_claim.data_is_empty(),
        TokenBridgeRelayerError::AlreadyRedeemed
    );

    // Confirm that the mint is a registered token.
    require!(
        ctx.accounts.registered_token.is_registered,
        TokenBridgeRelayerError::TokenNotRegistered
    );

    // The intended recipient must agree with the recipient account.
    let TokenBridgeRelayerMessage::TransferWithRelay {
        target_relayer_fee,
        to_native_token_amount,
        recipient,
    } = ctx.accounts.vaa.message().data();
    require!(
        ctx.accounts.recipient.key().to_bytes() == *recipient,
        TokenBridgeRelayerError::InvalidRecipient
    );

    // These seeds are used to:
    // 1.  Redeem Token Bridge program's
    //     complete_transfer_wrapped_with_payload.
    // 2.  Transfer tokens to relayer if it exists.
    // 3.  Transfer remaining tokens to recipient.
    // 4.  Close tmp_token_account.
    let config_seeds = &[
        RedeemerConfig::SEED_PREFIX.as_ref(),
        &[ctx.accounts.config.bump],
    ];

    // Redeem the token transfer to the tmp_token_account.
    token_bridge::complete_transfer_wrapped_with_payload(CpiContext::new_with_signer(
        ctx.accounts.token_bridge_program.to_account_info(),
        token_bridge::CompleteTransferWrappedWithPayload {
            payer: ctx.accounts.payer.to_account_info(),
            config: ctx.accounts.token_bridge_config.to_account_info(),
            vaa: ctx.accounts.vaa.to_account_info(),
            claim: ctx.accounts.token_bridge_claim.to_account_info(),
            foreign_endpoint: ctx.accounts.token_bridge_foreign_endpoint.to_account_info(),
            to: ctx.accounts.tmp_token_account.to_account_info(),
            redeemer: ctx.accounts.config.to_account_info(),
            wrapped_mint: ctx.accounts.token_bridge_wrapped_mint.to_account_info(),
            wrapped_metadata: ctx.accounts.token_bridge_wrapped_meta.to_account_info(),
            mint_authority: ctx.accounts.token_bridge_mint_authority.to_account_info(),
            rent: ctx.accounts.rent.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            wormhole_program: ctx.accounts.wormhole_program.to_account_info(),
        },
        &[&config_seeds[..]],
    ))?;

    // Denormalize the transfer amount and target relayer fee encoded in
    // the VAA.
    let amount = token_bridge::denormalize_amount(
        ctx.accounts.vaa.data().amount(),
        ctx.accounts.token_bridge_wrapped_mint.decimals,
    );
    let denormalized_relayer_fee = token_bridge::denormalize_amount(
        *target_relayer_fee,
        ctx.accounts.token_bridge_wrapped_mint.decimals,
    );

    // Handle self redemptions. If the payer is the recipient, we should
    // send the entire transfer amount.
    if ctx.accounts.payer.key() == ctx.accounts.recipient.key() {
        // Transfer tokens from tmp_token_account to recipient.
        anchor_spl::token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.tmp_token_account.to_account_info(),
                    to: ctx.accounts.recipient_token_account.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[&config_seeds[..]],
            ),
            amount,
        )?;
    } else {
        // Denormalize the to_native_token_amount.
        let denormalized_to_native_token_amount = token_bridge::denormalize_amount(
            *to_native_token_amount,
            ctx.accounts.token_bridge_wrapped_mint.decimals,
        );

        // Calculate the amount of SOL that should be sent to the
        // recipient.
        let (token_amount_in, native_amount_out) = ctx
            .accounts
            .registered_token
            .calculate_native_swap_amounts(
                ctx.accounts.token_bridge_wrapped_mint.decimals,
                ctx.accounts.native_registered_token.swap_rate,
                ctx.accounts.config.swap_rate_precision,
                denormalized_to_native_token_amount,
            )
            .ok_or(TokenBridgeRelayerError::InvalidSwapCalculation)?;

        // Transfer lamports from the payer to the recipient if the
        // native_amount_out is nonzero.
        if native_amount_out > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: ctx.accounts.recipient.to_account_info(),
                    },
                ),
                native_amount_out,
            )?;

            msg!(
                "Swap executed successfully, recipient: {}, relayer: {}, token: {}, tokenAmount: {}, nativeAmount: {}",
                ctx.accounts.recipient.key(),
                ctx.accounts.payer.key(),
                ctx.accounts.token_bridge_wrapped_mint.key(),
                token_amount_in,
                native_amount_out
            );
        }

        // Calculate the amount for the fee recipient.
        let amount_for_fee_recipient = token_amount_in + denormalized_relayer_fee;

        // Transfer tokens from tmp_token_account to the fee recipient.
        if amount_for_fee_recipient > 0 {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    anchor_spl::token::Transfer {
                        from: ctx.accounts.tmp_token_account.to_account_info(),
                        to: ctx.accounts.fee_recipient_token_account.to_account_info(),
                        authority: ctx.accounts.config.to_account_info(),
                    },
                    &[&config_seeds[..]],
                ),
                amount_for_fee_recipient,
            )?;
        }

        // Transfer tokens from tmp_token_account to recipient.
        anchor_spl::token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.tmp_token_account.to_account_info(),
                    to: ctx.accounts.recipient_token_account.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[&config_seeds[..]],
            ),
            amount - amount_for_fee_recipient,
        )?;
    }

    // Finish instruction by closing tmp_token_account.
    anchor_spl::token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        anchor_spl::token::CloseAccount {
            account: ctx.accounts.tmp_token_account.to_account_info(),
            destination: ctx.accounts.payer.to_account_info(),
            authority: ctx.accounts.config.to_account_info(),
        },
        &[&config_seeds[..]],
    ))
}
