/// This module implements a custom container for storing information about
/// registered coin types.
module token_bridge_relayer::token_info {
    /// Container that warehouses specified attributes of coins registered
    /// with the Token Bridge Relayer contract.
    struct TokenInfo<phantom C> has store {
        /// USD conversion rate of the coin.
        swap_rate: u64,

        /// The max number Sui that can be swapped for this coin.
        max_native_swap_amount: u64,

        /// Determines if native Sui swaps are allowed for this coin.
        swap_enabled: bool
    }

    /// Creates a new `TokenInfo` container.
    public fun new<C>(
        swap_rate: u64,
        max_native_swap_amount: u64,
        swap_enabled: bool
    ): TokenInfo<C> {
        TokenInfo {
            swap_rate,
            max_native_swap_amount,
            swap_enabled
        }
    }

    /// Destroys the specified `TokenInfo` container.
    public fun destroy<C>(
        self: TokenInfo<C>
    ) {
        let TokenInfo<C>{
            swap_rate: _,
            max_native_swap_amount: _,
            swap_enabled: _
        } = self;
    }

    /// Updates the `swap_rate` for the specified `TokenInfo` container.
    public fun update_swap_rate<C>(
        self: &mut TokenInfo<C>,
        new_swap_rate: u64
    ) {
        self.swap_rate = new_swap_rate;
    }

    /// Updates the `max_native_swap_amount` for the specified `TokenInfo`
    /// container.
    public fun update_max_native_swap_amount<C>(
        self: &mut TokenInfo<C>,
        max_native_swap_amount: u64
    ) {
        self.max_native_swap_amount = max_native_swap_amount;
    }

    /// Enables swaps for the specified `TokenInfo` container.
    public fun enable_swap<C>(self: &mut TokenInfo<C>) {
        self.swap_enabled = true;
    }

    /// Disables swaps for the specified `TokenInfo` container.
    public fun disable_swap<C>(self: &mut TokenInfo<C>) {
        self.swap_enabled = false;
    }

    // Getters.

    public fun swap_rate<C>(self: &TokenInfo<C>): u64 {
        self.swap_rate
    }

    public fun max_native_swap_amount<C>(self: &TokenInfo<C>): u64 {
        self.max_native_swap_amount
    }

    public fun is_swap_enabled<C>(self: &TokenInfo<C>): bool {
        self.swap_enabled
    }
}

#[test_only]
module token_bridge_relayer::token_info_tests {
    // Token Bridge Relayer modules.
    use token_bridge_relayer::token_info::{Self, TokenInfo};

    // Example coins.
    use example_coins::coin_8::{COIN_8};

    /// Test consts.
    const TEST_MAX_SWAP_AMOUNT: u64 = 69420;
    const TEST_SWAP_RATE: u64 = 6900000000; // $69

    #[test]
    public fun new() {
        // Create coin 8 info struct.
        let info = create_coin_8_info(false);

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
        let info = create_coin_8_info(false);

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
        let info = create_coin_8_info(false);

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

    #[test]
    public fun enable_swap() {
        // Create coin 8 info struct.
        let info = create_coin_8_info(false);

        // Verify that swapping is disabled.
        let is_swap_enabled = token_info::is_swap_enabled<COIN_8>(&info);
        assert!(!is_swap_enabled, 0);

        // Enable swapping.
        token_info::enable_swap<COIN_8>(&mut info);

        // Verify that swapping is enabled.
        let is_swap_enabled = token_info::is_swap_enabled<COIN_8>(&info);
        assert!(is_swap_enabled, 0);

        // Destroy.
        token_info::destroy<COIN_8>(info);
    }

    #[test]
    public fun disable_swap() {
        // Create coin 8 info struct.
        let info = create_coin_8_info(true);

        // Verify that swapping is enabled.
        let is_swap_enabled = token_info::is_swap_enabled<COIN_8>(&info);
        assert!(is_swap_enabled, 0);

        // Disable swapping.
        token_info::disable_swap<COIN_8>(&mut info);

        // Verify that swapping is disabled.
        let is_swap_enabled = token_info::is_swap_enabled<COIN_8>(&info);
        assert!(!is_swap_enabled, 0);

        // Destroy.
        token_info::destroy<COIN_8>(info);
    }

    // Utilities.

    public fun create_coin_8_info(enable_swap: bool): TokenInfo<COIN_8> {
        token_info::new<COIN_8>(
            TEST_SWAP_RATE,
            TEST_MAX_SWAP_AMOUNT,
            enable_swap
        )
    }
}
