use anchor_lang::prelude::*;

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
}

impl ForeignContract {
    /// AKA `b"foreign_contract"`.
    pub const SEED_PREFIX: &'static [u8; 16] = b"foreign_contract";

    /// Convenience method to check whether an address equals the one saved in
    /// this account.
    pub fn verify(&self, vaa: &PostedTokenBridgeRelayerMessage) -> bool {
        vaa.emitter_chain() == self.chain &&
            *vaa.data().from_address() == self.address
    }
}

#[cfg(test)]
pub mod test {
    use super::*;

    use crate::TokenBridgeRelayerMessage;
    use wormhole_anchor_sdk::{token_bridge, wormhole};

    #[test]
    fn test_foreign_emitter() -> Result<()> {
        let chain: u16 = 2;
        let address = Pubkey::new_unique().to_bytes();
        let token_bridge_foreign_endpoint = Pubkey::new_unique();
        let foreign_contract = ForeignContract {
            chain,
            address,
            token_bridge_foreign_endpoint,
        };

        let vaa = PostedTokenBridgeRelayerMessage {
            meta: wormhole::PostedVaaMeta {
                version: 1,
                finality: 200,
                timestamp: 0,
                signature_set: Pubkey::new_unique(),
                posted_timestamp: 1,
                batch_id: 69,
                sequence: 420,
                emitter_chain: chain,
                emitter_address: Pubkey::new_unique().to_bytes(),
            },
            payload: (
                0,
                token_bridge::TransferWith::new(
                    &token_bridge::TransferWithMeta {
                        amount: 1,
                        token_chain: 2,
                        token_address: Pubkey::new_unique().to_bytes(),
                        to_chain: chain,
                        to_address: Pubkey::new_unique().to_bytes(),
                        from_address: address,
                    },
                    &TokenBridgeRelayerMessage::Hello {
                        recipient: Pubkey::new_unique().to_bytes(),
                    },
                ),
            ),
        };
        assert!(
            foreign_contract.verify(&vaa),
            "foreign_contract.verify(&vaa) failed"
        );

        Ok(())
    }
}
