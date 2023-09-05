use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
/// Owner account data.
pub struct OwnerConfig {
    /// Program's owner.
    pub owner: Pubkey,
    /// Program's assistant. Can be used to update the relayer fee and swap rate.
    pub assistant: Pubkey,
    /// Intermediate storage for the pending owner. Is used to transfer ownership.
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

    /// AKA `b"owner"`.
    pub const SEED_PREFIX: &'static [u8; 5] = b"owner";
}
