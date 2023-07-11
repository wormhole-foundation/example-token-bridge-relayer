use anchor_lang::prelude::constant;

#[constant]
// AKA `b"bridged"`.
pub const SEED_PREFIX_BRIDGED: &[u8] = b"bridged";

#[constant]
/// AKA `b"tmp"`.
pub const SEED_PREFIX_TMP: &[u8] = b"tmp";
