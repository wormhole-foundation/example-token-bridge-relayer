#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;
use anchor_spl::token::{self};

mod constants;
pub use constants::*;

mod utils;
pub use utils::*;

mod error;
pub use error::*;

mod message;
pub use message::*;

mod native_program;
pub use native_program::*;

mod processor;
pub(crate) use processor::*;

mod state;
pub use state::*;

declare_id!("Examp1eTokenBridgeRe1ayer1111111111111111111");

#[program]
pub mod token_bridge_relayer {
    use super::*;

    /// This instruction is be used to generate your program's config.
    /// And for convenience, we will store Wormhole-related PDAs in the
    /// config so we can verify these accounts with a simple == constraint.
    /// # Arguments
    ///
    /// * `ctx`           - `Initialize` context
    /// * `fee_recipient` - Recipient of all relayer fees and swap proceeds
    /// * `assistant`     - Privileged key to manage certain accounts
    pub fn initialize(
        ctx: Context<Initialize>,
        fee_recipient: Pubkey,
        assistant: Pubkey,
    ) -> Result<()> {
        processor::initialize(ctx, fee_recipient, assistant)
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
    /// * `relayer_fee` - Relayer fee scaled by the `relayer_fee_precision`
    pub fn register_foreign_contract(
        ctx: Context<RegisterForeignContract>,
        chain: u16,
        address: [u8; 32],
        relayer_fee: u64,
    ) -> Result<()> {
        processor::register_foreign_contract(ctx, chain, address, relayer_fee)
    }

    /// This instruction registers a new token and saves the initial `swap_rate`
    /// and `max_native_token_amount` in a RegisteredToken account.
    /// This instruction is owner-only, meaning that only the owner of the
    /// program (defined in the [Config] account) can register a token.
    ///
    /// # Arguments
    ///
    /// * `ctx` - `RegisterToken` context
    /// * `swap_rate`:
    ///    - USD conversion rate scaled by the `swap_rate_precision`. For example,
    ///    - if the conversion rate is $15 and the `swap_rate_precision` is
    ///    - 1000000, the `swap_rate` should be set to 15000000.
    /// * `max_native_swap_amount`:
    ///    - Maximum amount of native tokens that can be swapped for this token
    ///    - on this chain.
    pub fn register_token(
        ctx: Context<RegisterToken>,
        swap_rate: u64,
        max_native_swap_amount: u64,
    ) -> Result<()> {
        processor::register_token(ctx, swap_rate, max_native_swap_amount)
    }

    /// This instruction deregisters a token by closing the existing
    /// `RegisteredToken` account for a particular mint. This instruction is
    /// owner-only, meaning that only the owner of the program (defined in the
    /// [Config] account) can deregister a token. 
    pub fn deregister_token(ctx: Context<DeregisterToken>) -> Result<()> {
        processor::deregister_token(ctx)
    }

    /// This instruction updates the `relayer_fee` in the `ForeignContract` account.
    /// The `relayer_fee` is scaled by the `relayer_fee_precision`. For example,
    /// if the `relayer_fee` is $15 and the `relayer_fee_precision` is 1000000,
    /// the `relayer_fee` should be set to 15000000. This instruction can
    /// only be called by the owner or assistant, which are defined in the
    /// [OwnerConfig] account.
    ///
    /// # Arguments
    ///
    /// * `ctx`   - `UpdateRelayerFee` context
    /// * `chain` - Wormhole Chain ID
    /// * `fee`   - Relayer fee scaled by the `relayer_fee_precision`
    pub fn update_relayer_fee(ctx: Context<UpdateRelayerFee>, chain: u16, fee: u64) -> Result<()> {
        processor::update_relayer_fee(ctx, chain, fee)
    }

    /// This instruction updates the `relayer_fee_precision` in the
    /// `SenderConfig` and `RedeemerConfig` accounts. The `relayer_fee_precision`
    /// is used to scale the `relayer_fee`. This instruction is owner-only,
    /// meaning that only the owner of the program (defined in the [Config]
    /// account) can register a token.
    ///
    /// # Arguments
    ///
    /// * `ctx` - `UpdatePrecision` context
    /// * `relayer_fee_precision` - Precision used to scale the relayer fee.
    pub fn update_relayer_fee_precision(
        ctx: Context<UpdatePrecision>,
        relayer_fee_precision: u32,
    ) -> Result<()> {
        processor::update_relayer_fee_precision(ctx, relayer_fee_precision)
    }

    /// This instruction updates the `swap_rate` in the `RegisteredToken`
    /// account. This instruction can only be called by the owner or
    /// assistant, which are defined in the [OwnerConfig] account.
    ///
    /// # Arguments
    ///
    /// * `ctx`       - `UpdateSwapRate` context
    /// * `swap_rate` - USD conversion rate for the specified token.
    pub fn update_swap_rate(ctx: Context<UpdateSwapRate>, swap_rate: u64) -> Result<()> {
        processor::update_swap_rate(ctx, swap_rate)
    }

    /// This instruction updates the `max_native_swap_amount` in the
    /// `RegisteredToken` account. This instruction is owner-only,
    /// meaning that only the owner of the program (defined in the [Config]
    /// account) can register a token.
    ///
    /// # Arguments
    ///
    /// * `ctx` - `UpdateMaxNativeSwapAmount` context
    /// * `max_native_swap_amount`:
    ///    - Maximum amount of native tokens that can be swapped for this token
    ///    - on this chain.
    pub fn update_max_native_swap_amount(
        ctx: Context<UpdateMaxNativeSwapAmount>,
        max_native_swap_amount: u64,
    ) -> Result<()> {
        processor::update_max_native_swap_amount(ctx, max_native_swap_amount)
    }

    /// This instruction updates the `paused` boolean in the `SenderConfig`
    /// account. This instruction is owner-only, meaning that only the owner
    /// of the program (defined in the [Config] account) can pause outbound
    /// transfers.
    ///
    /// # Arguments
    ///
    /// * `ctx` - `PauseOutboundTransfers` context
    /// * `paused` - Boolean indicating whether outbound transfers are paused.
    pub fn set_pause_for_transfers(
        ctx: Context<PauseOutboundTransfers>,
        paused: bool,
    ) -> Result<()> {
        processor::set_pause_for_transfers(ctx, paused)
    }

    /// This instruction sets the `pending_owner` field in the `OwnerConfig`
    /// account. This instruction is owner-only, meaning that only the owner
    /// of the program (defined in the [Config] account) can submit an
    /// ownership transfer request.
    ///
    /// # Arguments
    ///
    /// * `ctx`       - `ManageOwnership` context
    /// * `new_owner` - Pubkey of the pending owner.
    pub fn submit_ownership_transfer_request(
        ctx: Context<ManageOwnership>,
        new_owner: Pubkey,
    ) -> Result<()> {
        processor::submit_ownership_transfer_request(ctx, new_owner)
    }

    /// This instruction confirms that the `pending_owner` is the signer of
    /// the transaction and updates the `owner` field in the `SenderConfig`,
    /// `RedeemerConfig`, and `OwnerConfig` accounts.
    pub fn confirm_ownership_transfer_request(
        ctx: Context<ConfirmOwnershipTransfer>,
    ) -> Result<()> {
        processor::confirm_ownership_transfer_request(ctx)
    }

    /// This instruction cancels the ownership transfer request by setting
    /// the `pending_owner` field in the `OwnerConfig` account to `None`.
    /// This instruction is owner-only, meaning that only the owner of the
    /// program (defined in the [Config] account) can cancel an ownership
    /// transfer request.
    pub fn cancel_ownership_transfer_request(ctx: Context<ManageOwnership>) -> Result<()> {
        processor::cancel_ownership_transfer_request(ctx)
    }

    /// This instruction updates the `assistant` field in the `OwnerConfig`
    /// account. This instruction is owner-only, meaning that only the owner
    /// of the program (defined in the [Config] account) can update the
    /// assistant.
    ///
    /// # Arguments
    ///
    /// * `ctx` - `ManageOwnership` context
    /// * `new_assistant` - Pubkey of the new assistant.
    pub fn update_assistant(ctx: Context<ManageOwnership>, new_assistant: Pubkey) -> Result<()> {
        processor::update_assistant(ctx, new_assistant)
    }

    /// This instruction updates the `fee_recipient` field in the `RedeemerConfig`
    /// account. This instruction is owner-only, meaning that only the owner
    /// of the program (defined in the [Config] account) can update the
    /// fee recipient.
    ///
    /// # Arguments
    ///
    /// * `ctx` - `UpdateFeeRecipient` context
    /// * `new_fee_recipient` - Pubkey of the new fee recipient.
    pub fn update_fee_recipient(
        ctx: Context<UpdateFeeRecipient>,
        new_fee_recipient: Pubkey,
    ) -> Result<()> {
        processor::update_fee_recipient(ctx, new_fee_recipient)
    }

    /// This instruction is used to transfer native tokens from Solana to a
    /// foreign blockchain. The user can optionally specify a
    /// `to_native_token_amount` to swap some of the tokens for the native
    /// asset on the target chain. For a fee, an off-chain relayer will redeem
    /// the transfer on the target chain. If the user is transferring native
    /// SOL, the contract will automatically wrap the lamports into a WSOL.
    ///
    /// # Arguments
    ///
    /// * `ctx` - `TransferNativeWithRelay` context
    /// * `amount` - Amount of tokens to send
    /// * `to_native_token_amount`:
    ///     - Amount of tokens to swap for native assets on the target chain
    /// * `recipient_chain` - Chain ID of the target chain
    /// * `recipient_address` - Address of the target wallet on the target chain
    /// * `batch_id` - Nonce of Wormhole message
    /// * `wrap_native` - Whether to wrap native SOL
    pub fn transfer_native_tokens_with_relay(
        ctx: Context<TransferNativeWithRelay>,
        amount: u64,
        to_native_token_amount: u64,
        recipient_chain: u16,
        recipient_address: [u8; 32],
        batch_id: u32,
        wrap_native: bool,
    ) -> Result<()> {
        processor::transfer_native_tokens_with_relay(
            ctx,
            amount,
            to_native_token_amount,
            recipient_chain,
            recipient_address,
            batch_id,
            wrap_native,
        )
    }

    /// This instruction is used to transfer wrapped tokens from Solana to a
    /// foreign blockchain. The user can optionally specify a
    /// `to_native_token_amount` to swap some of the tokens for the native
    /// assets on the target chain. For a fee, an off-chain relayer will redeem
    /// the transfer on the target chain. This instruction should only be called
    /// when the user is transferring a wrapped token.
    ///
    /// # Arguments
    ///
    /// * `ctx` - `TransferWrappedWithRelay` context
    /// * `amount` - Amount of tokens to send
    /// * `to_native_token_amount`:
    ///    - Amount of tokens to swap for native assets on the target chain
    /// * `recipient_chain` - Chain ID of the target chain
    /// * `recipient_address` - Address of the target wallet on the target chain
    /// * `batch_id` - Nonce of Wormhole message
    pub fn transfer_wrapped_tokens_with_relay(
        ctx: Context<TransferWrappedWithRelay>,
        amount: u64,
        to_native_token_amount: u64,
        recipient_chain: u16,
        recipient_address: [u8; 32],
        batch_id: u32,
    ) -> Result<()> {
        processor::transfer_wrapped_tokens_with_relay(
            ctx,
            amount,
            to_native_token_amount,
            recipient_chain,
            recipient_address,
            batch_id,
        )
    }

    /// This instruction is used to redeem token transfers from foreign emitters.
    /// It takes custody of the released native tokens and sends the tokens to the
    /// encoded `recipient`. It pays the `fee_recipient` in the token
    /// denomination. If requested by the user, it will perform a swap with the
    /// off-chain relayer to provide the user with lamports. If the token
    /// being transferred is WSOL, the contract will unwrap the WSOL and send
    /// the lamports to the recipient and pay the relayer in lamports.
    ///
    /// # Arguments
    ///
    /// * `ctx` - `CompleteNativeWithRelay` context
    /// * `vaa_hash` - Hash of the VAA that triggered the transfer
    pub fn complete_native_transfer_with_relay(
        ctx: Context<CompleteNativeWithRelay>,
        _vaa_hash: [u8; 32],
    ) -> Result<()> {
        processor::complete_native_transfer_with_relay(ctx, _vaa_hash)
    }

    /// This instruction is used to redeem token transfers from foreign emitters.
    /// It takes custody of the minted wrapped tokens and sends the tokens to the
    /// encoded `recipient`. It pays the `fee_recipient` in the wrapped-token
    /// denomination. If requested by the user, it will perform a swap with the
    /// off-chain relayer to provide the user with lamports.
    ///
    /// # Arguments
    ///
    /// * `ctx` - `CompleteWrappedWithRelay` context
    /// * `vaa_hash` - Hash of the VAA that triggered the transfer
    pub fn complete_wrapped_transfer_with_relay(
        ctx: Context<CompleteWrappedWithRelay>,
        _vaa_hash: [u8; 32],
    ) -> Result<()> {
        processor::complete_wrapped_transfer_with_relay(ctx, _vaa_hash)
    }
}
