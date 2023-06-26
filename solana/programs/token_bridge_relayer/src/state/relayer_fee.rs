use anchor_lang::prelude::*;

#[account]
#[derive(Default, InitSpace)]
/// Outbound relayer fee data.
pub struct RelayerFee {
    /// Emitter chain. Cannot equal `1` (Solana's Chain ID).
    pub chain: u16,
    /// Relayer fee in USD terms.
    pub fee: u64
}

impl RelayerFee {
    pub fn checked_token_fee(
        &self,
        decimals: u8,
        swap_rate: u64,
        swap_rate_precision: u32,
        relayer_fee_precision: u32,
    ) -> Option<u64> {
        // Compute the numerator.
        let numerator = u128::from(self.fee)
            .checked_mul(u128::pow(10, decimals.into()))?
            .checked_mul(swap_rate_precision.into())?;

        // Compute the denominator.
        let denominator = u128::from(swap_rate).checked_mul(
            relayer_fee_precision.into()
        )?;

        // Calculate the fee in token terms.
        let token_fee = numerator.checked_div(denominator)?;

        u64::try_from(token_fee).ok()
    }

    /// AKA `b"relayer_fee"`.
    pub const SEED_PREFIX: &'static [u8; 11] = b"relayer_fee";
}
