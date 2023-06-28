use anchor_lang::{
    prelude::*,
    system_program::{self, Transfer},
};
use anchor_spl::{
    token::{self, spl_token},
};

pub use context::*;
pub use error::*;
pub use message::*;
pub use state::*;

pub mod context;
pub mod error;
pub mod message;
pub mod state;

declare_id!("5S5LeEiouw4AdyUXBoDThpsepQha2HH8Qt5AMDn9zsk1");

#[program]
pub mod token_bridge_relayer {
    use super::*;
    use wormhole_anchor_sdk::{token_bridge, wormhole};

    /// This instruction can be used to generate your program's config.
    /// And for convenience, we will store Wormhole-related PDAs in the
    /// config so we can verify these accounts with a simple == constraint.
    pub fn initialize(
        ctx: Context<Initialize>,
        fee_recipient: Pubkey,
        assistant: Pubkey
    ) -> Result<()> {
        require_keys_neq!(
            fee_recipient,
            Pubkey::default(),
            TokenBridgeRelayerError::InvalidPublicKey
        );
        require_keys_neq!(
            assistant,
            Pubkey::default(),
            TokenBridgeRelayerError::InvalidPublicKey
        );

        // Initial precision value for both relayer fees and swap rates.
        let initial_precision: u32 = 100000000;

        // Initialize program's sender config
        let sender_config = &mut ctx.accounts.sender_config;

        // Set the owner of the sender config (effectively the owner of the
        // program).
        sender_config.owner = ctx.accounts.owner.key();
        sender_config.bump = *ctx
            .bumps
            .get("sender_config")
            .ok_or(TokenBridgeRelayerError::BumpNotFound)?;
        sender_config.relayer_fee_precision = initial_precision;
        sender_config.swap_rate_precision = initial_precision;

        // Set Token Bridge related addresses.
        {
            let token_bridge = &mut sender_config.token_bridge;
            token_bridge.config = ctx.accounts.token_bridge_config.key();
            token_bridge.authority_signer = ctx.accounts.token_bridge_authority_signer.key();
            token_bridge.custody_signer = ctx.accounts.token_bridge_custody_signer.key();
            token_bridge.emitter = ctx.accounts.token_bridge_emitter.key();
            token_bridge.sequence = ctx.accounts.token_bridge_sequence.key();
            token_bridge.wormhole_bridge = ctx.accounts.wormhole_bridge.key();
            token_bridge.wormhole_fee_collector = ctx.accounts.wormhole_fee_collector.key();
        }

        // Initialize program's redeemer config.
        let redeemer_config = &mut ctx.accounts.redeemer_config;

        // Set the owner of the redeemer config (effectively the owner of the
        // program).
        redeemer_config.owner = ctx.accounts.owner.key();
        redeemer_config.bump = *ctx
            .bumps
            .get("redeemer_config")
            .ok_or(TokenBridgeRelayerError::BumpNotFound)?;
        redeemer_config.relayer_fee_precision = initial_precision;
        redeemer_config.swap_rate_precision = initial_precision;
        redeemer_config.fee_recipient = fee_recipient;

        // Set Token Bridge related addresses.
        {
            let token_bridge = &mut redeemer_config.token_bridge;
            token_bridge.config = ctx.accounts.token_bridge_config.key();
            token_bridge.custody_signer = ctx.accounts.token_bridge_custody_signer.key();
            token_bridge.mint_authority = ctx.accounts.token_bridge_mint_authority.key();
        }

        // Initialize program's owner config.
        let owner_config = &mut ctx.accounts.owner_config;

        // Set the owner and assistant for the owner config.
        owner_config.owner = ctx.accounts.owner.key();
        owner_config.assistant = assistant;
        owner_config.pending_owner = None;

        // Done.
        Ok(())
    }

    /// This instruction registers a new foreign contract (from another
    /// network) and saves the emitter information in a ForeignEmitter account.
    /// This instruction is owner-only, meaning that only the owner of the
    /// program (defined in the [Config] account) can add and update foreign
    /// contracts.
    ///
    /// # Arguments
    ///
    /// * `ctx`     - `RegisterForeignContract` context
    /// * `chain`   - Wormhole Chain ID
    /// * `address` - Wormhole Emitter Address
    pub fn register_foreign_contract(
        ctx: Context<RegisterForeignContract>,
        chain: u16,
        address: [u8; 32],
    ) -> Result<()> {
        // Foreign emitter cannot share the same Wormhole Chain ID as the
        // Solana Wormhole program's. And cannot register a zero address.
        require!(
            chain > wormhole::CHAIN_ID_SOLANA && !address.iter().all(|&x| x == 0),
            TokenBridgeRelayerError::InvalidForeignContract,
        );

        // Save the emitter info into the ForeignEmitter account.
        let emitter = &mut ctx.accounts.foreign_contract;
        emitter.chain = chain;
        emitter.address = address;
        emitter.token_bridge_foreign_endpoint = ctx.accounts.token_bridge_foreign_endpoint.key();

        // Done.
        Ok(())
    }

    pub fn register_token(
        ctx: Context<RegisterToken>,
        swap_rate: u64,
        max_native_swap_amount: u64,
        swaps_enabled: bool
    ) -> Result<()> {
        require!(
            !ctx.accounts.registered_token.is_registered,
            TokenBridgeRelayerError::TokenAlreadyRegistered
        );
        require!(
            swap_rate > 0,
            TokenBridgeRelayerError::ZeroSwapRate
        );

        // Register the token by setting the swap_rate and max_native_swap_amount.
        ctx.accounts.registered_token.set_inner(RegisteredToken {
            swap_rate,
            max_native_swap_amount,
            swaps_enabled,
            is_registered: true
        });

        Ok(())
    }

    pub fn deregister_token(
        ctx: Context<DeregisterToken>
    ) -> Result<()> {
        require!(
            ctx.accounts.registered_token.is_registered,
            TokenBridgeRelayerError::TokenAlreadyRegistered
        );

        // Register the token by setting the swap_rate and max_native_swap_amount.
        ctx.accounts.registered_token.set_inner(RegisteredToken {
            swap_rate: 0,
            max_native_swap_amount: 0,
            swaps_enabled: false,
            is_registered: false
        });

        Ok(())
    }

    pub fn update_relayer_fee(
        ctx: Context<UpdateRelayerFee>,
        chain: u16,
        fee: u64
    ) -> Result<()> {
        // Check that the signer is the owner or assistant.
        require!(
            ctx.accounts.owner_config.is_authorized(&ctx.accounts.payer.key()),
            TokenBridgeRelayerError::OwnerOnly
        );

        // NOTE: We do not have to check if the chainId is valid, or if a chainId
        // has been registered with a foreign emitter. Since the ForeignContract
        // account is required, this means the account has been created and
        // passed the checks required for successfully registering an emitter.

        // Save the chain and fee information in the RelayerFee account.
        let relayer_fee = &mut ctx.accounts.relayer_fee;
        relayer_fee.chain = chain;
        relayer_fee.fee = fee;

        Ok(())
    }

    pub fn update_relayer_fee_precision(
        ctx: Context<UpdatePrecision>,
        relayer_fee_precision: u32,
    ) -> Result<()> {
        require!(
            relayer_fee_precision > 0,
            TokenBridgeRelayerError::InvalidPrecision,
        );

        // Update redeemer config.
        let redeemer_config = &mut ctx.accounts.redeemer_config;
        redeemer_config.relayer_fee_precision = relayer_fee_precision;

        // Update sender config.
        let sender_config = &mut ctx.accounts.sender_config;
        sender_config.relayer_fee_precision = relayer_fee_precision;

        // Done.
        Ok(())
    }

    pub fn update_swap_rate(
        ctx: Context<UpdateSwapRate>,
        swap_rate: u64
    ) -> Result<()> {
        // Check that the signer is the owner or assistant.
        require!(
            ctx.accounts.owner_config.is_authorized(&ctx.accounts.payer.key()),
            TokenBridgeRelayerError::OwnerOnly
        );

        // Confirm that the token is registered and the new swap rate
        // is nonzero.
        require!(
            ctx.accounts.registered_token.is_registered,
            TokenBridgeRelayerError::TokenNotRegistered
        );
        require!(
            swap_rate > 0,
            TokenBridgeRelayerError::ZeroSwapRate
        );

        // Set the new swap rate.
        let registered_token = &mut ctx.accounts.registered_token;
        registered_token.swap_rate = swap_rate;

        Ok(())
    }

    pub fn update_swap_rate_precision(
        ctx: Context<UpdatePrecision>,
        swap_rate_precision: u32,
    ) -> Result<()> {
        require!(
            swap_rate_precision > 0,
            TokenBridgeRelayerError::InvalidPrecision,
        );

        // Update redeemer config.
        let redeemer_config = &mut ctx.accounts.redeemer_config;
        redeemer_config.swap_rate_precision = swap_rate_precision;

        // Update sender config.
        let sender_config = &mut ctx.accounts.sender_config;
        sender_config.swap_rate_precision = swap_rate_precision;

        // Done.
        Ok(())
    }

    pub fn update_max_native_swap_amount(
        ctx: Context<ManageToken>,
        max_native_swap_amount: u64
    ) -> Result<()> {
        require!(
            ctx.accounts.registered_token.is_registered,
            TokenBridgeRelayerError::TokenNotRegistered
        );

        // Set the new max native swap amount.
        let registered_token = &mut ctx.accounts.registered_token;
        registered_token.max_native_swap_amount = max_native_swap_amount;

        Ok(())
    }

    pub fn toggle_swaps(
        ctx: Context<ManageToken>,
        swaps_enabled: bool
    ) -> Result<()> {
        require!(
            ctx.accounts.registered_token.is_registered,
            TokenBridgeRelayerError::TokenNotRegistered
        );

        // Toggle the swaps enabled boolean.
        let registered_token = &mut ctx.accounts.registered_token;
        registered_token.swaps_enabled = swaps_enabled;

        Ok(())
    }

    pub fn submit_ownership_transfer_request(
        ctx: Context<ManageOwnershipTransfer>,
        new_owner: Pubkey
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

        let owner_config= &mut ctx.accounts.owner_config;
        owner_config.pending_owner = Some(new_owner);

        Ok(())
    }

    pub fn cancel_ownership_transfer_request(
        ctx: Context<ManageOwnershipTransfer>
    ) -> Result<()> {
        let owner_config = &mut ctx.accounts.owner_config;
        owner_config.pending_owner = None;

        Ok(())
    }

    pub fn confirm_ownership_transfer_request(
        ctx: Context<ConfirmOwnershipTransfer>
    ) -> Result<()> {
        // Check that the signer is the pending owner.
        require!(
            ctx.accounts.owner_config.is_pending_owner(&ctx.accounts.payer.key()),
            TokenBridgeRelayerError::NotPendingOwner
        );

        // Unwrap the pending owner.
        let pending_owner = ctx.accounts.owner_config.pending_owner.unwrap();

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

    pub fn send_native_tokens_with_payload(
        ctx: Context<SendNativeTokensWithPayload>,
        amount: u64,
        to_native_token_amount: u64,
        recipient_chain: u16,
        recipient_address: [u8; 32],
        batch_id: u32,
        wrap_native: bool
    ) -> Result<()> {
        // Confirm that the mint is a registered token.
        require!(
            ctx.accounts.registered_token.is_registered,
            TokenBridgeRelayerError::TokenNotRegistered
        );

        // Confirm that the user passed a valid target wallet on a registered
        // chain.
        require!(
            recipient_chain > wormhole::CHAIN_ID_SOLANA
            && !recipient_address.iter().all(|&x| x == 0),
            TokenBridgeRelayerError::InvalidRecipient,
        );

        // Token Bridge program truncates amounts to 8 decimals, so there will
        // be a residual amount if decimals of SPL is >8. We need to take into
        // account how much will actually be bridged.
        let truncated_amount = token_bridge::truncate_amount(
            amount,
            ctx.accounts.mint.decimals
        );
        require!(
            truncated_amount > 0,
            TokenBridgeRelayerError::ZeroBridgeAmount
        );

        // Normalize the to_native_token_amount to 8 decimals.
        let normalized_to_native_amount = token_bridge::normalize_amount(
            to_native_token_amount,
            ctx.accounts.mint.decimals
        );
        require!(
            to_native_token_amount == 0 ||
            normalized_to_native_amount > 0,
            TokenBridgeRelayerError::ZeroBridgeAmount
        );

        // Compute the relayer fee in terms of the native token being
        // transfered.
        let token_fee = ctx.accounts.relayer_fee.checked_token_fee(
            ctx.accounts.mint.decimals,
            ctx.accounts.registered_token.swap_rate,
            ctx.accounts.config.swap_rate_precision,
            ctx.accounts.config.relayer_fee_precision
        ).ok_or(TokenBridgeRelayerError::FeeCalculationError)?;

        // Normalize the transfer amount and relayer fee and confirm that the
        // user has sent enough tokens to cover the native swap on the target
        // chain and to pay the relayer fee.
        let normalized_relayer_fee = token_bridge::normalize_amount(
            token_fee,
            ctx.accounts.mint.decimals
        );
        let normalized_amount = token_bridge::normalize_amount(
            amount,
            ctx.accounts.mint.decimals
        );
        require!(
            normalized_amount > normalized_to_native_amount + normalized_relayer_fee,
            TokenBridgeRelayerError::InsufficientFunds
        );

        // These seeds are used to:
        // 1.  Sign the Sender Config's token account to delegate approval
        //     of truncated_amount.
        // 2.  Sign Token Bridge program's transfer_native instruction.
        // 3.  Close tmp_token_account.
        let config_seeds = &[
            SenderConfig::SEED_PREFIX.as_ref(),
            &[ctx.accounts.config.bump],
        ];

        // First transfer tokens from payer to tmp_token_account.
        if wrap_native {
            require!(
                ctx.accounts.mint.key() == spl_token::native_mint::ID,
                TokenBridgeRelayerError::InvalidRecipient
            );

            // Transfer lamports to our token account (these lamports will be our WSOL).
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: ctx.accounts.tmp_token_account.to_account_info(),
                    },
                ),
                truncated_amount,
            )?;

            // Sync the token account based on the lamports we sent it.
            token::sync_native(CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::SyncNative {
                    account: ctx.accounts.tmp_token_account.to_account_info(),
                },
            ))?;
        } else {
            anchor_spl::token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    anchor_spl::token::Transfer {
                        from: ctx.accounts.from_token_account.to_account_info(),
                        to: ctx.accounts.tmp_token_account.to_account_info(),
                        authority: ctx.accounts.payer.to_account_info(),
                    },
                ),
                truncated_amount,
            )?;
        }

        // Delegate spending to Token Bridge program's authority signer.
        anchor_spl::token::approve(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::Approve {
                    to: ctx.accounts.tmp_token_account.to_account_info(),
                    delegate: ctx.accounts.token_bridge_authority_signer.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[&config_seeds[..]],
            ),
            truncated_amount,
        )?;

        // Serialize TokenBridgeRelayerMessage as encoded payload for Token Bridge
        // transfer.
        let payload = TokenBridgeRelayerMessage::TransferWithRelay {
            target_relayer_fee: normalized_relayer_fee,
            to_native_token_amount: normalized_to_native_amount,
            recipient: recipient_address
        }
        .try_to_vec()?;

        // Bridge native token with encoded payload.
        token_bridge::transfer_native_with_payload(
            CpiContext::new_with_signer(
                ctx.accounts.token_bridge_program.to_account_info(),
                token_bridge::TransferNativeWithPayload {
                    payer: ctx.accounts.payer.to_account_info(),
                    config: ctx.accounts.token_bridge_config.to_account_info(),
                    from: ctx.accounts.tmp_token_account.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    custody: ctx.accounts.token_bridge_custody.to_account_info(),
                    authority_signer: ctx.accounts.token_bridge_authority_signer.to_account_info(),
                    custody_signer: ctx.accounts.token_bridge_custody_signer.to_account_info(),
                    wormhole_bridge: ctx.accounts.wormhole_bridge.to_account_info(),
                    wormhole_message: ctx.accounts.wormhole_message.to_account_info(),
                    wormhole_emitter: ctx.accounts.token_bridge_emitter.to_account_info(),
                    wormhole_sequence: ctx.accounts.token_bridge_sequence.to_account_info(),
                    wormhole_fee_collector: ctx.accounts.wormhole_fee_collector.to_account_info(),
                    clock: ctx.accounts.clock.to_account_info(),
                    sender: ctx.accounts.config.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                    wormhole_program: ctx.accounts.wormhole_program.to_account_info(),
                },
                &[
                    &config_seeds[..],
                    &[
                        SEED_PREFIX_BRIDGED,
                        &ctx.accounts
                            .token_bridge_sequence
                            .next_value()
                            .to_le_bytes()[..],
                        &[*ctx
                            .bumps
                            .get("wormhole_message")
                            .ok_or(TokenBridgeRelayerError::BumpNotFound)?],
                    ],
                ],
            ),
            batch_id,
            truncated_amount,
            ctx.accounts.foreign_contract.address,
            recipient_chain,
            payload,
            &ctx.program_id.key(),
        )?;

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

    // pub fn redeem_native_transfer_with_payload(
    //     ctx: Context<RedeemNativeTransferWithPayload>,
    //     _vaa_hash: [u8; 32],
    // ) -> Result<()> {
    //     // The Token Bridge program's claim account is only initialized when
    //     // a transfer is redeemed (and the boolean value `true` is written as
    //     // its data).
    //     //
    //     // The Token Bridge program will automatically fail if this transfer
    //     // is redeemed again. But we choose to short-circuit the failure as the
    //     // first evaluation of this instruction.
    //     require!(
    //         ctx.accounts.token_bridge_claim.data_is_empty(),
    //         TokenBridgeRelayerError::AlreadyRedeemed
    //     );

    //     // The intended recipient must agree with the recipient.
    //     let TokenBridgeRelayerMessage::Hello { recipient } = ctx.accounts.vaa.message().data();
    //     require!(
    //         ctx.accounts.recipient.key().to_bytes() == *recipient,
    //         TokenBridgeRelayerError::InvalidRecipient
    //     );

    //     // These seeds are used to:
    //     // 1.  Redeem Token Bridge program's
    //     //     complete_transfer_native_with_payload.
    //     // 2.  Transfer tokens to relayer if he exists.
    //     // 3.  Transfer remaining tokens to recipient.
    //     // 4.  Close tmp_token_account.
    //     let config_seeds = &[
    //         RedeemerConfig::SEED_PREFIX.as_ref(),
    //         &[ctx.accounts.config.bump],
    //     ];

    //     // Redeem the token transfer.
    //     token_bridge::complete_transfer_native_with_payload(CpiContext::new_with_signer(
    //         ctx.accounts.token_bridge_program.to_account_info(),
    //         token_bridge::CompleteTransferNativeWithPayload {
    //             payer: ctx.accounts.payer.to_account_info(),
    //             config: ctx.accounts.token_bridge_config.to_account_info(),
    //             vaa: ctx.accounts.vaa.to_account_info(),
    //             claim: ctx.accounts.token_bridge_claim.to_account_info(),
    //             foreign_endpoint: ctx.accounts.token_bridge_foreign_endpoint.to_account_info(),
    //             to: ctx.accounts.tmp_token_account.to_account_info(),
    //             redeemer: ctx.accounts.config.to_account_info(),
    //             custody: ctx.accounts.token_bridge_custody.to_account_info(),
    //             mint: ctx.accounts.mint.to_account_info(),
    //             custody_signer: ctx.accounts.token_bridge_custody_signer.to_account_info(),
    //             rent: ctx.accounts.rent.to_account_info(),
    //             system_program: ctx.accounts.system_program.to_account_info(),
    //             token_program: ctx.accounts.token_program.to_account_info(),
    //             wormhole_program: ctx.accounts.wormhole_program.to_account_info(),
    //         },
    //         &[&config_seeds[..]],
    //     ))?;

    //     let amount = token_bridge::denormalize_amount(
    //         ctx.accounts.vaa.data().amount(),
    //         ctx.accounts.mint.decimals,
    //     );

    //     // If this instruction were executed by a relayer, send some of the
    //     // token amount (determined by the relayer fee) to the payer's token
    //     // account.
    //     if ctx.accounts.payer.key() != ctx.accounts.recipient.key() {
    //         // Does the relayer have an aassociated token account already? If
    //         // not, he needs to create one.
    //         require!(
    //             !ctx.accounts.payer_token_account.data_is_empty(),
    //             TokenBridgeRelayerError::NonExistentRelayerAta
    //         );

    //         let relayer_amount = ctx.accounts.config.compute_relayer_amount(amount);

    //         // Pay the relayer if there is anything for him.
    //         if relayer_amount > 0 {
    //             anchor_spl::token::transfer(
    //                 CpiContext::new_with_signer(
    //                     ctx.accounts.token_program.to_account_info(),
    //                     anchor_spl::token::Transfer {
    //                         from: ctx.accounts.tmp_token_account.to_account_info(),
    //                         to: ctx.accounts.payer_token_account.to_account_info(),
    //                         authority: ctx.accounts.config.to_account_info(),
    //                     },
    //                     &[&config_seeds[..]],
    //                 ),
    //                 relayer_amount,
    //             )?;
    //         }

    //         msg!(
    //             "RedeemNativeTransferWithPayload :: relayed by {:?}",
    //             ctx.accounts.payer.key()
    //         );

    //         // Transfer tokens from tmp_token_account to recipient.
    //         anchor_spl::token::transfer(
    //             CpiContext::new_with_signer(
    //                 ctx.accounts.token_program.to_account_info(),
    //                 anchor_spl::token::Transfer {
    //                     from: ctx.accounts.tmp_token_account.to_account_info(),
    //                     to: ctx.accounts.recipient_token_account.to_account_info(),
    //                     authority: ctx.accounts.config.to_account_info(),
    //                 },
    //                 &[&config_seeds[..]],
    //             ),
    //             amount - relayer_amount,
    //         )?;
    //     } else {
    //         // Transfer tokens from tmp_token_account to recipient.
    //         anchor_spl::token::transfer(
    //             CpiContext::new_with_signer(
    //                 ctx.accounts.token_program.to_account_info(),
    //                 anchor_spl::token::Transfer {
    //                     from: ctx.accounts.tmp_token_account.to_account_info(),
    //                     to: ctx.accounts.recipient_token_account.to_account_info(),
    //                     authority: ctx.accounts.config.to_account_info(),
    //                 },
    //                 &[&config_seeds[..]],
    //             ),
    //             amount,
    //         )?;
    //     }

    //     // Finish instruction by closing tmp_token_account.
    //     anchor_spl::token::close_account(CpiContext::new_with_signer(
    //         ctx.accounts.token_program.to_account_info(),
    //         anchor_spl::token::CloseAccount {
    //             account: ctx.accounts.tmp_token_account.to_account_info(),
    //             destination: ctx.accounts.payer.to_account_info(),
    //             authority: ctx.accounts.config.to_account_info(),
    //         },
    //         &[&config_seeds[..]],
    //     ))
    // }

    pub fn send_wrapped_tokens_with_payload(
        ctx: Context<SendWrappedTokensWithPayload>,
        amount: u64,
        to_native_token_amount: u64,
        recipient_chain: u16,
        recipient_address: [u8; 32],
        batch_id: u32
    ) -> Result<()> {
        require!(amount > 0, TokenBridgeRelayerError::ZeroBridgeAmount);

        // Confirm that the mint is a registered token.
        require!(
            ctx.accounts.registered_token.is_registered,
            TokenBridgeRelayerError::TokenNotRegistered
        );

        // Confirm that the user passed a valid target wallet on a registered
        // chain.
        require!(
            recipient_chain > wormhole::CHAIN_ID_SOLANA
            && !recipient_address.iter().all(|&x| x == 0),
            TokenBridgeRelayerError::InvalidRecipient,
        );

        // Compute the relayer fee in terms of the native token being
        // transfered.
        let relayer_fee = ctx.accounts.relayer_fee.checked_token_fee(
            ctx.accounts.token_bridge_wrapped_mint.decimals,
            ctx.accounts.registered_token.swap_rate,
            ctx.accounts.config.swap_rate_precision,
            ctx.accounts.config.relayer_fee_precision
        ).ok_or(TokenBridgeRelayerError::FeeCalculationError)?;

        // Confirm that the user has sent enough tokens to cover the native
        // swap on the target chain and to the pay relayer fee.
        require!(
            amount > to_native_token_amount + relayer_fee,
            TokenBridgeRelayerError::InsufficientFunds
        );

        // These seeds are used to:
        // 1.  Sign the Sender Config's token account to delegate approval
        //     of amount.
        // 2.  Sign Token Bridge program's transfer_wrapped instruction.
        // 3.  Close tmp_token_account.
        let config_seeds = &[
            SenderConfig::SEED_PREFIX.as_ref(),
            &[ctx.accounts.config.bump],
        ];

        // First transfer tokens from payer to tmp_token_account.
        anchor_spl::token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.from_token_account.to_account_info(),
                    to: ctx.accounts.tmp_token_account.to_account_info(),
                    authority: ctx.accounts.payer.to_account_info(),
                },
            ),
            amount,
        )?;

        // Delegate spending to Token Bridge program's authority signer.
        anchor_spl::token::approve(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::Approve {
                    to: ctx.accounts.tmp_token_account.to_account_info(),
                    delegate: ctx.accounts.token_bridge_authority_signer.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[&config_seeds[..]],
            ),
            amount,
        )?;

        // Serialize TokenBridgeRelayerMessage as encoded payload for Token Bridge
        // transfer.
        let payload = TokenBridgeRelayerMessage::TransferWithRelay {
            target_relayer_fee: relayer_fee,
            to_native_token_amount,
            recipient: recipient_address
        }
        .try_to_vec()?;

        // Bridge wrapped token with encoded payload.
        token_bridge::transfer_wrapped_with_payload(
            CpiContext::new_with_signer(
                ctx.accounts.token_bridge_program.to_account_info(),
                token_bridge::TransferWrappedWithPayload {
                    payer: ctx.accounts.payer.to_account_info(),
                    config: ctx.accounts.token_bridge_config.to_account_info(),
                    from: ctx.accounts.tmp_token_account.to_account_info(),
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
                    token_program: ctx.accounts.token_program.to_account_info(),
                    wormhole_program: ctx.accounts.wormhole_program.to_account_info(),
                },
                &[
                    &config_seeds[..],
                    &[
                        SEED_PREFIX_BRIDGED,
                        &ctx.accounts
                            .token_bridge_sequence
                            .next_value()
                            .to_le_bytes()[..],
                        &[*ctx
                            .bumps
                            .get("wormhole_message")
                            .ok_or(TokenBridgeRelayerError::BumpNotFound)?],
                    ],
                ],
            ),
            batch_id,
            amount,
            ctx.accounts.foreign_contract.address,
            recipient_chain,
            payload,
            &ctx.program_id.key(),
        )?;

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

    // pub fn redeem_wrapped_transfer_with_payload(
    //     ctx: Context<RedeemWrappedTransferWithPayload>,
    //     _vaa_hash: [u8; 32],
    // ) -> Result<()> {
    //     // The Token Bridge program's claim account is only initialized when
    //     // a transfer is redeemed (and the boolean value `true` is written as
    //     // its data).
    //     //
    //     // The Token Bridge program will automatically fail if this transfer
    //     // is redeemed again. But we choose to short-circuit the failure as the
    //     // first evaluation of this instruction.
    //     require!(
    //         ctx.accounts.token_bridge_claim.data_is_empty(),
    //         TokenBridgeRelayerError::AlreadyRedeemed
    //     );

    //     // The intended recipient must agree with the recipient.
    //     let TokenBridgeRelayerMessage::Hello { recipient } = ctx.accounts.vaa.message().data();
    //     require!(
    //         ctx.accounts.recipient.key().to_bytes() == *recipient,
    //         TokenBridgeRelayerError::InvalidRecipient
    //     );

    //     // These seeds are used to:
    //     // 1.  Redeem Token Bridge program's
    //     //     complete_transfer_wrapped_with_payload.
    //     // 2.  Transfer tokens to relayer if he exists.
    //     // 3.  Transfer remaining tokens to recipient.
    //     // 4.  Close tmp_token_account.
    //     let config_seeds = &[
    //         RedeemerConfig::SEED_PREFIX.as_ref(),
    //         &[ctx.accounts.config.bump],
    //     ];

    //     // Redeem the token transfer.
    //     token_bridge::complete_transfer_wrapped_with_payload(CpiContext::new_with_signer(
    //         ctx.accounts.token_bridge_program.to_account_info(),
    //         token_bridge::CompleteTransferWrappedWithPayload {
    //             payer: ctx.accounts.payer.to_account_info(),
    //             config: ctx.accounts.token_bridge_config.to_account_info(),
    //             vaa: ctx.accounts.vaa.to_account_info(),
    //             claim: ctx.accounts.token_bridge_claim.to_account_info(),
    //             foreign_endpoint: ctx.accounts.token_bridge_foreign_endpoint.to_account_info(),
    //             to: ctx.accounts.tmp_token_account.to_account_info(),
    //             redeemer: ctx.accounts.config.to_account_info(),
    //             wrapped_mint: ctx.accounts.token_bridge_wrapped_mint.to_account_info(),
    //             wrapped_metadata: ctx.accounts.token_bridge_wrapped_meta.to_account_info(),
    //             mint_authority: ctx.accounts.token_bridge_mint_authority.to_account_info(),
    //             rent: ctx.accounts.rent.to_account_info(),
    //             system_program: ctx.accounts.system_program.to_account_info(),
    //             token_program: ctx.accounts.token_program.to_account_info(),
    //             wormhole_program: ctx.accounts.wormhole_program.to_account_info(),
    //         },
    //         &[&config_seeds[..]],
    //     ))?;

    //     let amount = ctx.accounts.vaa.data().amount();

    //     // If this instruction were executed by a relayer, send some of the
    //     // token amount (determined by the relayer fee) to the payer's token
    //     // account.
    //     if ctx.accounts.payer.key() != ctx.accounts.recipient.key() {
    //         // Does the relayer have an aassociated token account already? If
    //         // not, he needs to create one.
    //         require!(
    //             !ctx.accounts.payer_token_account.data_is_empty(),
    //             TokenBridgeRelayerError::NonExistentRelayerAta
    //         );

    //         let relayer_amount = ctx.accounts.config.compute_relayer_amount(amount);

    //         // Pay the relayer if there is anything for him.
    //         if relayer_amount > 0 {
    //             anchor_spl::token::transfer(
    //                 CpiContext::new_with_signer(
    //                     ctx.accounts.token_program.to_account_info(),
    //                     anchor_spl::token::Transfer {
    //                         from: ctx.accounts.tmp_token_account.to_account_info(),
    //                         to: ctx.accounts.payer_token_account.to_account_info(),
    //                         authority: ctx.accounts.config.to_account_info(),
    //                     },
    //                     &[&config_seeds[..]],
    //                 ),
    //                 relayer_amount,
    //             )?;
    //         }

    //         msg!(
    //             "RedeemWrappedTransferWithPayload :: relayed by {:?}",
    //             ctx.accounts.payer.key()
    //         );

    //         // Transfer tokens from tmp_token_account to recipient.
    //         anchor_spl::token::transfer(
    //             CpiContext::new_with_signer(
    //                 ctx.accounts.token_program.to_account_info(),
    //                 anchor_spl::token::Transfer {
    //                     from: ctx.accounts.tmp_token_account.to_account_info(),
    //                     to: ctx.accounts.recipient_token_account.to_account_info(),
    //                     authority: ctx.accounts.config.to_account_info(),
    //                 },
    //                 &[&config_seeds[..]],
    //             ),
    //             amount - relayer_amount,
    //         )?;
    //     } else {
    //         // Transfer tokens from tmp_token_account to recipient.
    //         anchor_spl::token::transfer(
    //             CpiContext::new_with_signer(
    //                 ctx.accounts.token_program.to_account_info(),
    //                 anchor_spl::token::Transfer {
    //                     from: ctx.accounts.tmp_token_account.to_account_info(),
    //                     to: ctx.accounts.recipient_token_account.to_account_info(),
    //                     authority: ctx.accounts.config.to_account_info(),
    //                 },
    //                 &[&config_seeds[..]],
    //             ),
    //             amount,
    //         )?;
    //     }

    //     // Finish instruction by closing tmp_token_account.
    //     anchor_spl::token::close_account(CpiContext::new_with_signer(
    //         ctx.accounts.token_program.to_account_info(),
    //         anchor_spl::token::CloseAccount {
    //             account: ctx.accounts.tmp_token_account.to_account_info(),
    //             destination: ctx.accounts.payer.to_account_info(),
    //             authority: ctx.accounts.config.to_account_info(),
    //         },
    //         &[&config_seeds[..]],
    //     ))
    // }
}
