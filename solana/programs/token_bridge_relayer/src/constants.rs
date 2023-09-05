use anchor_lang::prelude::constant;

#[constant]
// AKA `b"bridged"`.
pub const SEED_PREFIX_BRIDGED: &[u8] = b"bridged";

#[constant]
/// AKA `b"tmp"`.
pub const SEED_PREFIX_TMP: &[u8] = b"tmp";

#[constant]
/// Swap rate precision. This value should NEVER change, unless other Token
/// Bridge Relayer contracts are deployed with a different precision.
pub const SWAP_RATE_PRECISION: u32 = 100_000_000;