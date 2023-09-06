use anchor_lang::prelude::*;
use crate::constants::SWAP_RATE_PRECISION;

use crate::PostedTokenBridgeRelayerMessage;

#[account]
#[derive(Default, InitSpace)]
/// Foreign emitter account data.
pub struct ForeignContract {
    /// Emitter chain. Cannot equal `1` (Solana's Chain ID).
    pub chain: u16,
    /// Emitter address. Cannot be zero address.
    pub address: [u8; 32],
    /// Token Bridge program's foreign endpoint account key.
    pub token_bridge_foreign_endpoint: Pubkey,
    /// The fee that is paid to the `fee_recipient` upon redeeming a transfer.
    /// This value is set in terms of USD and scaled by the `relayer_fee_precision`. 
    /// For example, if the `relayer_fee_precision` is `100000000` and the intended
    /// fee is $5, then the `fee` value should be `500000000`.
    pub fee: u64,
}

impl ForeignContract {
    pub const SEED_PREFIX: &'static [u8; 16] = b"foreign_contract";

    /// Convenience method to check whether an address equals the one saved in
    /// this account.
    pub fn verify(&self, vaa: &PostedTokenBridgeRelayerMessage) -> bool {
        vaa.emitter_chain() == self.chain &&
            *vaa.data().from_address() == self.address
    }

    pub fn checked_token_fee(
        &self,
        decimals: u8,
        swap_rate: u64,
        relayer_fee_precision: u32,
    ) -> Option<u64> {
        // Compute the numerator.
        let numerator = u128::from(self.fee)
            .checked_mul(u128::checked_pow(10, decimals.into())?)?
            .checked_mul(SWAP_RATE_PRECISION.into())?;

        // Compute the denominator.
        let denominator = u128::from(swap_rate).checked_mul(relayer_fee_precision.into())?;

        // Calculate the fee in token terms.
        let token_fee = numerator.checked_div(denominator)?;

        u64::try_from(token_fee).ok()
    }
}

#[cfg(test)]
pub mod test {
    use super::*;
    use anchor_lang::prelude::Result;

    #[test]
    fn test_checked_token_fee() -> Result<()> {
        // Test variables.
        let relayer_fee_precision: u32 = 100000000;
        let swap_rate: u64 = 6900000000;

        // Create test RelayerFee.
        let mut relayer_fee = ForeignContract {
            chain: 2,         // target chain Ethereum
            address: [0; 32], // target address
            token_bridge_foreign_endpoint: Pubkey::new_unique(),
            fee: 42000000000, // $420.00
        };

        // Calculate the token fee for 10 decimals.
        let expected_token_fee = 60869565217;
        let token_fee = relayer_fee.checked_token_fee(
            10, // decimals
            swap_rate,
            relayer_fee_precision,
        );
        assert_eq!(token_fee.unwrap(), expected_token_fee);

        // Calculate the token fee for 9 decimals.
        let expected_token_fee = 6086956521;
        let token_fee = relayer_fee.checked_token_fee(
            9, // decimals
            swap_rate,
            relayer_fee_precision,
        );
        assert_eq!(token_fee.unwrap(), expected_token_fee);

        // Calculate the token fee for 8 decimals.
        let expected_token_fee = 608695652;
        let token_fee = relayer_fee.checked_token_fee(
            8, // decimals
            swap_rate,
            relayer_fee_precision,
        );
        assert_eq!(token_fee.unwrap(), expected_token_fee);

        // Calculate the token fee with an increased swap rate.
        let swap_rate: u64 = 100000000000000; // $100000.00
        let expected_token_fee = 42000;
        let token_fee = relayer_fee.checked_token_fee(
            8, // decimals
            swap_rate,
            relayer_fee_precision,
        );
        assert_eq!(token_fee.unwrap(), expected_token_fee);

        // Calculate the token fee with an decreased swap rate.
        let swap_rate: u64 = 1000000; // $0.01
        let expected_token_fee = 4200000000000;
        let token_fee = relayer_fee.checked_token_fee(
            8, // decimals
            swap_rate,
            relayer_fee_precision,
        );
        assert_eq!(token_fee.unwrap(), expected_token_fee);

        // Calculate the token fee when the USD fee is zero.
        relayer_fee.fee = 0;
        let expected_token_fee = 0;
        let token_fee = relayer_fee.checked_token_fee(
            8, // decimals
            swap_rate,
            relayer_fee_precision,
        );
        assert_eq!(token_fee.unwrap(), expected_token_fee);

        // Cause an overflow.
        relayer_fee.fee = u64::MAX;
        let swap_rate = 1;
        let relayer_fee_precision = 1;
        let token_fee = relayer_fee.checked_token_fee(
            8, // decimals
            swap_rate,
            relayer_fee_precision,
        );
        assert!(token_fee.is_none());

        Ok(())
    }
}
