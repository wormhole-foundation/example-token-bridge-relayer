use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct OwnerConfig {
    pub owner: Pubkey,
    pub assistant: Pubkey,
    pub pending_owner: Option<Pubkey>
}

impl OwnerConfig {
    pub fn is_authorized(&self, key: &Pubkey) -> bool {
        self.is_owner(key) || self.assistant == *key
    }

    pub fn is_owner(&self, key: &Pubkey) -> bool {
        self.owner == *key
    }

    pub fn is_pending_owner(&self, key: &Pubkey) -> bool {
        self.pending_owner == Some(*key)
    }

    /// AKA `b"redeemer"`.
    pub const SEED_PREFIX: &'static [u8; 5] = b"owner";
}
