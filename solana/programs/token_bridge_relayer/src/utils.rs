use wormhole_anchor_sdk::wormhole;

pub fn valid_foreign_address(chain: u16, address: &[u8; 32]) -> bool {
    chain != 0 && chain != wormhole::CHAIN_ID_SOLANA && *address != [0; 32]
}