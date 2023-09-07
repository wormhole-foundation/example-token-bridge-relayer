use anchor_lang::prelude::*;
use crate::constants::SWAP_RATE_PRECISION;

#[account]
#[derive(InitSpace)]
/// Registered token account data.
pub struct RegisteredToken {
    /// Token swap rate. The swap rate is the USD conversion rate of the token.
    pub swap_rate: u64,
    /// Maximum amount of native SOL the contract will swap for each transfer.
    pub max_native_swap_amount: u64
}

impl RegisteredToken {
    pub const SEED_PREFIX: &'static [u8] = b"mint";
    pub const NATIVE_DECIMALS: u8 = 9;

    fn native_swap_rate(&self, sol_swap_rate: u64) -> Option<u64> {
        let native_swap_rate = u128::from(SWAP_RATE_PRECISION)
            .checked_mul(sol_swap_rate.into())?
            .checked_div(self.swap_rate.into())?;

        // NOTE: The native_swap_rate should not be zero. If it is, the contract's
        // state is grossly misconfigured.
        if native_swap_rate == 0 {
            msg!("WARNING: native_swap_rate is zero");
            None
        } else {
            u64::try_from(native_swap_rate).ok()
        }
    }

    fn calculate_max_swap_amount_in(
        &self,
        decimals: u8,
        native_swap_rate: u64
    ) -> Option<u64> {
        let max_swap_amount_in = if decimals > Self::NATIVE_DECIMALS {
            u128::from(self.max_native_swap_amount)
                .checked_mul(native_swap_rate.into())?
                .checked_mul(u128::checked_pow(10, (decimals - Self::NATIVE_DECIMALS).into())?)?
                .checked_div(SWAP_RATE_PRECISION.into())?
        } else {
            u128::from(self.max_native_swap_amount)
                .checked_mul(native_swap_rate.into())?
                .checked_div(
                    u128::checked_pow(10, (Self::NATIVE_DECIMALS - decimals).into())?
                        .checked_mul(u128::from(SWAP_RATE_PRECISION))?,
                )?
        };

        // If an overflow occurs, it is very likely that the contract owner
        // has misconfigured one (or many) of the state variables. The owner
        // should reconfigure the contract.
        u64::try_from(max_swap_amount_in).ok()
    }

    pub fn calculate_native_swap_amounts(
        &self,
        decimals: u8,
        sol_swap_rate: u64,
        to_native_token_amount: u64,
    ) -> Option<(u64, u64)> {
        // Return if the to_native_token_amount is zero.
        if to_native_token_amount == 0 || self.max_native_swap_amount == 0 {
            return Some((0, 0));
        }

        // Calculate the native swap rate.
        let native_swap_rate = self.native_swap_rate(sol_swap_rate)?;

        // Calculate the maximum amount of native tokens that can be swapped in.
        let max_native_swap_amount_in =
            self.calculate_max_swap_amount_in(decimals, native_swap_rate)?;

        // Override the to_native_token_amout if it's value is larger than the
        // maximum amount of native tokens that can be swapped in.
        let to_native_token_amount = if to_native_token_amount > max_native_swap_amount_in {
            max_native_swap_amount_in
        } else {
            to_native_token_amount
        };

        // Calculate the native_swap_amount_out.
        let native_swap_amount_out = if decimals > Self::NATIVE_DECIMALS {
            u128::from(SWAP_RATE_PRECISION)
                .checked_mul(to_native_token_amount.into())?
                .checked_div(
                    u128::from(native_swap_rate)
                        .checked_mul(u128::checked_pow(10, (decimals - Self::NATIVE_DECIMALS).into())?)?,
                )?
        } else {
            u128::from(SWAP_RATE_PRECISION)
                .checked_mul(to_native_token_amount.into())?
                .checked_mul(u128::checked_pow(10, (Self::NATIVE_DECIMALS - decimals).into())?)?
                .checked_div(native_swap_rate.into())?
        };

        // Handle the case where the native_swap_amount_out is zero due to
        // the compiler rounding towards zero.
        if native_swap_amount_out > 0 {
            Some((
                to_native_token_amount,
                u64::try_from(native_swap_amount_out).ok()?,
            ))
        } else {
            Some((0, 0))
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use anchor_lang::prelude::Result;

    #[test]
    fn test_native_swap_rate() -> Result<()> {
        // Create test RegisteredToken struct.
        let mut registered_token = RegisteredToken {
            swap_rate: 1000000000,
            max_native_swap_amount: 1000000000
        };

        // Calculate the native swap rate.
        let expected_native_swap_rate: u64 = 42000000000;
        let native_swap_rate = registered_token.native_swap_rate(
            420000000000, // sol swap rate
        );
        assert_eq!(expected_native_swap_rate, native_swap_rate.unwrap());

        // Increase the swap rate.
        registered_token.swap_rate = 6900000000;
        let expected_native_swap_rate: u64 = 6086956521;
        let native_swap_rate = registered_token.native_swap_rate(
            420000000000 // sol swap rate
        );
        assert_eq!(expected_native_swap_rate, native_swap_rate.unwrap());

        // Set the sol swap rate to 1, which should cause the function to return None.
        let native_swap_rate = registered_token.native_swap_rate(
            1 // sol swap rate
        );
        assert_eq!(None, native_swap_rate);

        // Set the sol swap rate to a very large number and the token swap rate to a
        // very small number. This should cause an overflow and the function should
        // return None.
        registered_token.swap_rate = 1;
        let native_swap_rate = registered_token.native_swap_rate(
            u64::MAX // sol swap rate
        );
        assert_eq!(None, native_swap_rate);

        Ok(())
    }

    #[test]
    fn test_calculate_max_swap_amount_in() -> Result<()> {
        // Test variables.
        let native_swap_rate: u64 = 42000000000;

        // Create test RegisteredToken struct.
        let mut registered_token = RegisteredToken {
            swap_rate: 1000000000,              // $10.00
            max_native_swap_amount: 1000000000 // 1 SOL
        };

        // Calculate the max swap amount in for decimals 10.
        let expected_max_swap_amount_in: u64 = 4200000000000;
        let max_swap_amount_in = registered_token.calculate_max_swap_amount_in(
            10, // decimals
            native_swap_rate
        );
        assert_eq!(expected_max_swap_amount_in, max_swap_amount_in.unwrap());

        // Calculate the max swap amount in for decimals 9.
        let expected_max_swap_amount_in: u64 = 420000000000;
        let max_swap_amount_in = registered_token.calculate_max_swap_amount_in(
            9, // decimals
            native_swap_rate
        );
        assert_eq!(expected_max_swap_amount_in, max_swap_amount_in.unwrap());

        // Calculate the max swap amount in for decimals 8.
        let expected_max_swap_amount_in: u64 = 42000000000;
        let max_swap_amount_in = registered_token.calculate_max_swap_amount_in(
            8, // decimals
            native_swap_rate
        );
        assert_eq!(expected_max_swap_amount_in, max_swap_amount_in.unwrap());

        // Increase the native swap rate.
        let expected_max_swap_amount_in: u64 = 6900000000000000;
        let max_swap_amount_in = registered_token.calculate_max_swap_amount_in(
            9, // decimals
            690000000000000
        );
        assert_eq!(expected_max_swap_amount_in, max_swap_amount_in.unwrap());

        // Decrease the max native swap amount.
        registered_token.max_native_swap_amount = 1000000;
        let expected_max_swap_amount_in: u64 = 420000000;
        let max_swap_amount_in = registered_token.calculate_max_swap_amount_in(
            9, // decimals
            native_swap_rate
        );
        assert_eq!(expected_max_swap_amount_in, max_swap_amount_in.unwrap());

        Ok(())
    }

    #[test]
    fn test_calculate_native_swap_amounts() -> Result<()> {
        // Test variables.
        let sol_swap_rate: u64 = 42000000000; // $42.00

        // Create test RegisteredToken struct.
        let mut registered_token = RegisteredToken {
            swap_rate: 1000000000,               // $10.00
            max_native_swap_amount: 10000000000 // 10 SOL
        };

        // Calculate the native swap amounts for decimals 10.
        let to_native_token_amount: u64 = 10000000000; // 1 token
        let expected_swap_amount = 23809523;
        let native_swap_amounts = registered_token.calculate_native_swap_amounts(
            10, // decimals
            sol_swap_rate,
            to_native_token_amount
        );
        assert_eq!(to_native_token_amount, native_swap_amounts.unwrap().0);
        assert_eq!(expected_swap_amount, native_swap_amounts.unwrap().1);

        // Calculate the native swap amounts for decimals 9.
        let to_native_token_amount: u64 = 10000000000; // 1 token
        let expected_swap_amount = 238095238;
        let native_swap_amounts = registered_token.calculate_native_swap_amounts(
            9, // decimals
            sol_swap_rate,
            to_native_token_amount
        );
        assert_eq!(to_native_token_amount, native_swap_amounts.unwrap().0);
        assert_eq!(expected_swap_amount, native_swap_amounts.unwrap().1);

        // Calculate the native swap amounts for decimals 8.
        let to_native_token_amount: u64 = 10000000000; // 1 token
        let expected_swap_amount = 2380952380;
        let native_swap_amounts = registered_token.calculate_native_swap_amounts(
            8, // decimals
            sol_swap_rate,
            to_native_token_amount
        );
        assert_eq!(to_native_token_amount, native_swap_amounts.unwrap().0);
        assert_eq!(expected_swap_amount, native_swap_amounts.unwrap().1);

        // Calculate the native swap amounts when the to native token amount
        // is zero. Both return values should be zero.
        let to_native_token_amount: u64 = 0;
        let expected_swap_amount = 0;
        let native_swap_amounts = registered_token.calculate_native_swap_amounts(
            10, // decimals
            sol_swap_rate,
            to_native_token_amount
        );
        assert_eq!(to_native_token_amount, native_swap_amounts.unwrap().0);
        assert_eq!(expected_swap_amount, native_swap_amounts.unwrap().1);

        // Set the max native swap amount to zero. Both return values should be zero.
        registered_token.max_native_swap_amount = 0;
        let expected_swap_amount_out = 0;
        let expected_swap_amount_in = 0;
        let native_swap_amounts = registered_token.calculate_native_swap_amounts(
            10, // decimals
            sol_swap_rate,
            10000000000 // to native token amount is nonzero
        );
        assert_eq!(expected_swap_amount_in, native_swap_amounts.unwrap().0);
        assert_eq!(expected_swap_amount_out, native_swap_amounts.unwrap().1);

        // Set the to native token amount to a value larger than the max native
        // swap amount. The to native token amount should be overridden to the
        // max native swap amount.
        registered_token.max_native_swap_amount = 1000000000; // 1 SOL
        let to_native_token_amount = 6900000000000; // larger than max native swap amount
        let expected_swap_amount_out = 1000000000;
        let expected_swap_amount_in = 420000000000; // 42 tokens
        let native_swap_amounts = registered_token.calculate_native_swap_amounts(
            10, // decimals
            sol_swap_rate,
            to_native_token_amount
        );
        assert_eq!(expected_swap_amount_in, native_swap_amounts.unwrap().0);
        assert_eq!(expected_swap_amount_out, native_swap_amounts.unwrap().1);

        // Set the to_native_token_amount to a very small number. The
        // resulting swap amounts shuld be zero due to the compiler
        // rounding towards zero (similar to solidity).
        let to_native_token_amount = 1;
        let expected_swap_amount_out = 0;
        let expected_swap_amount_in = 0;
        let native_swap_amounts = registered_token.calculate_native_swap_amounts(
            10, // decimals
            sol_swap_rate,
            to_native_token_amount
        );
        assert_eq!(expected_swap_amount_in, native_swap_amounts.unwrap().0);
        assert_eq!(expected_swap_amount_out, native_swap_amounts.unwrap().1);

        // Cause an overflow for a token with 10 decimals.
        registered_token.max_native_swap_amount = u64::MAX;
        registered_token.swap_rate = 100000000; // $1.00
        let sol_swap_rate = 100000000; // $1.00
        let native_swap_amounts = registered_token.calculate_native_swap_amounts(
            10, // decimals
            sol_swap_rate,
            u64::MAX // to_native_token_amount
        );
        assert_eq!(None, native_swap_amounts);

        // Cause an overflow for a token with 8 decimals by setting the
        // swap_rate_precision to the minimum.
        let sol_swap_rate = u64::MAX;
        let native_swap_amounts = registered_token.calculate_native_swap_amounts(
            8, // decimals
            sol_swap_rate,
            u64::MAX // to_native_token_amount
        );
        assert_eq!(None, native_swap_amounts);

        Ok(())
    }
}
