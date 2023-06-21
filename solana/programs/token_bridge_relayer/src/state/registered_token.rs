use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct RegisteredToken {
    pub swap_rate: u64,
    pub max_native_swap_amount: u64,
    pub swaps_enabled: bool,
    pub is_registered: bool
}
