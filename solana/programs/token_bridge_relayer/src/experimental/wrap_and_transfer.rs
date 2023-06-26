use anchor_lang::{
    prelude::*,
    system_program::{self, Transfer},
};
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, spl_token, Token, TokenAccount},
};

use crate::RegisteredToken;

#[derive(Accounts)]
pub struct WrapAndTransfer<'info> {
    #[account(mut)]
    payer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"mint", spl_token::native_mint::ID.as_ref()],
        bump
    )]
    registered_token: Account<'info, RegisteredToken>,

    #[account(
        mut,
        token::mint = spl_token::native_mint::ID
    )]
    custody_token: Account<'info, TokenAccount>,

    system_program: Program<'info, System>,
    token_program: Program<'info, Token>,
    associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Debug, Clone, AnchorSerialize, AnchorDeserialize)]
pub struct WrapAndTransferArgs {
    lamports: u64,
}

pub fn wrap_and_transfer(ctx: Context<WrapAndTransfer>, args: WrapAndTransferArgs) -> Result<()> {
    let WrapAndTransferArgs { lamports } = args;

    // Transfer lamports to our token account (these lamports will be our WSOL).
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.custody_token.to_account_info(),
            },
        ),
        lamports,
    )?;

    // Sync the token account based on the lamports we sent it.
    token::sync_native(CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        token::SyncNative {
            account: ctx.accounts.custody_token.to_account_info(),
        },
    ))?;

    // TODO
    Ok(())
}
