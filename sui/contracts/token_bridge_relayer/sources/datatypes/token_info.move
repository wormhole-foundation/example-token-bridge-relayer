module token_bridge_relayer::token_info {
    struct TokenInfo<phantom C> has store {
        swap_rate: u64,
        max_native_swap_amount: u64
    }

    public fun new<C>(
        swap_rate: u64,
        max_native_swap_amount: u64
    ): TokenInfo<C> {
        TokenInfo {
            swap_rate,
            max_native_swap_amount
        }
    }

    public fun destroy<C>(
        self: TokenInfo<C>
    ) {
        let TokenInfo<C>{
            swap_rate: _,
            max_native_swap_amount: _
        } = self;
    }

    public fun update_swap_rate<C>(
        self: &mut TokenInfo<C>,
        new_swap_rate: u64
    ) {
        self.swap_rate = new_swap_rate;
    }

    public fun update_max_native_swap_amount<C>(
        self: &mut TokenInfo<C>,
        max_native_swap_amount: u64
    ) {
        self.max_native_swap_amount = max_native_swap_amount;
    }

    public fun swap_rate<C>(self: &TokenInfo<C>): u64 {
        self.swap_rate
    }

    public fun max_native_swap_amount<C>(self: &TokenInfo<C>): u64 {
        self.max_native_swap_amount
    }
}

#[test_only]
module token_bridge_relayer::token_info_tests {
    use token_bridge_relayer::token_info::{Self, TokenInfo};

    // Example coins.
    use example_coins::coin_8::{COIN_8};

    // Test consts.
    const TEST_MAX_SWAP_AMOUNT: u64 = 69420;
    const TEST_SWAP_RATE: u64 = 6900000000; // $69

    #[test]
    public fun new() {
        // Create coin 8 info struct.
        let info = create_coin_8_info();

        // Verify the struct was set up correctly.
        assert!(TEST_SWAP_RATE == token_info::swap_rate<COIN_8>(&info), 0);
        assert!(
            TEST_MAX_SWAP_AMOUNT ==
                token_info::max_native_swap_amount<COIN_8>(&info),
            0
        );

        // Destroy.
        token_info::destroy<COIN_8>(info);
    }

    #[test]
    public fun update_swap_rate() {
        // Create coin 8 info struct.
        let info = create_coin_8_info();

        // Verify the initial swap rate.
        assert!(TEST_SWAP_RATE == token_info::swap_rate<COIN_8>(&info), 0);

        // Update the swap rate.
        let new_swap_rate: u64 = 6942000000000;

        token_info::update_swap_rate<COIN_8>(
            &mut info,
            new_swap_rate
        );

        // Verify the new swap rate.
        assert!(new_swap_rate == token_info::swap_rate<COIN_8>(&info), 0);

        // Destroy.
        token_info::destroy<COIN_8>(info);
    }

    #[test]
    public fun update_max_native_swap_amount() {
        // Create coin 8 info struct.
        let info = create_coin_8_info();

        // Verify the initial swap rate.
        assert!(
            TEST_MAX_SWAP_AMOUNT ==
                token_info::max_native_swap_amount<COIN_8>(&info),
            0
        );

        // Update the swap rate.
        let new_max_swap_amount: u64 = 123456789;

        token_info::update_max_native_swap_amount<COIN_8>(
            &mut info,
            new_max_swap_amount
        );

        // Verify the new swap rate.
        assert!(
            new_max_swap_amount ==
                token_info::max_native_swap_amount<COIN_8>(&info),
            0
        );

        // Destroy.
        token_info::destroy<COIN_8>(info);
    }

    // Utilities.
    public fun create_coin_8_info(): TokenInfo<COIN_8> {
        token_info::new<COIN_8>(
            TEST_SWAP_RATE,
            TEST_MAX_SWAP_AMOUNT
        )
    }
}
