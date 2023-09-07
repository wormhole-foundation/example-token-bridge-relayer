use anchor_lang::{AnchorDeserialize, AnchorSerialize};
use std::io;
use wormhole_anchor_sdk::token_bridge;

const PAYLOAD_ID_TRANSFER_WITH_RELAY: u8 = 1;
pub const PAD_U64: usize = 24;

#[derive(Clone, Copy)]
/// Expected message types for this program. Only valid payloads are:
/// * `TransferWithRelay`: Payload ID == 1.
///
/// Payload IDs are encoded as u8.
pub enum TokenBridgeRelayerMessage {
    TransferWithRelay {
        target_relayer_fee: u64,
        to_native_token_amount: u64,
        recipient: [u8; 32],
    },
}

impl AnchorSerialize for TokenBridgeRelayerMessage {
    fn serialize<W: io::Write>(&self, writer: &mut W) -> io::Result<()> {
        match self {
            TokenBridgeRelayerMessage::TransferWithRelay {
                target_relayer_fee,
                to_native_token_amount,
                recipient,
            } => {
                PAYLOAD_ID_TRANSFER_WITH_RELAY.serialize(writer)?;
                [0u8; PAD_U64].serialize(writer)?;
                target_relayer_fee.to_be_bytes().serialize(writer)?;
                [0u8; PAD_U64].serialize(writer)?;
                to_native_token_amount.to_be_bytes().serialize(writer)?;
                recipient.serialize(writer)
            }
        }
    }
}

impl AnchorDeserialize for TokenBridgeRelayerMessage {
    fn deserialize(buf: &mut &[u8]) -> io::Result<Self> {
        // Validate payload size.
        if buf.len() != 97 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid payload size",
            ));
        }

        // Parse the payload.
        match u8::deserialize(buf)? {
            PAYLOAD_ID_TRANSFER_WITH_RELAY => {
                const ZEROS: [u8; 24] = [0; 24];

                // Target relayer fee.
                let target_relayer_fee = {
                    if <[u8; 24]>::deserialize(buf)? != ZEROS {
                        return Err(io::Error::new(io::ErrorKind::InvalidInput, "u64 overflow"));
                    }

                    let out = <[u8; 8]>::deserialize(buf)?;
                    u64::from_be_bytes(out)
                };

                // To native token amount.
                let to_native_token_amount = {
                    if <[u8; 24]>::deserialize(buf)? != ZEROS {
                        return Err(io::Error::new(io::ErrorKind::InvalidInput, "u64 overflow"));
                    }

                    let out = <[u8; 8]>::deserialize(buf)?;
                    u64::from_be_bytes(out)
                };

                // Recipient.
                let recipient = <[u8; 32]>::deserialize(buf)?;

                Ok(TokenBridgeRelayerMessage::TransferWithRelay {
                    target_relayer_fee,
                    to_native_token_amount,
                    recipient,
                })
            }
            _ => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid payload ID",
            )),
        }
    }
}

pub type PostedTokenBridgeRelayerMessage =
    token_bridge::PostedTransferWith<TokenBridgeRelayerMessage>;

#[cfg(test)]
mod test {
    use super::*;
    use anchor_lang::prelude::{Pubkey, Result};
    use std::mem::size_of;

    #[test]
    fn test_message_alive() -> Result<()> {
        let recipient = Pubkey::new_unique().to_bytes();
        let to_native_token_amount: u64 = 100000000;
        let target_relayer_fee: u64 = 6900000;

        // Create the message.
        let msg = TokenBridgeRelayerMessage::TransferWithRelay {
            target_relayer_fee,
            to_native_token_amount,
            recipient,
        };

        // Serialize program ID above.
        let mut encoded = Vec::new();
        msg.serialize(&mut encoded)?;

        assert_eq!(encoded.len(), size_of::<[u8; 32]>() * 3 + size_of::<u8>());

        // Verify Payload ID.
        assert_eq!(encoded[0], PAYLOAD_ID_TRANSFER_WITH_RELAY);

        // Now deserialize the encoded message.
        let TokenBridgeRelayerMessage::TransferWithRelay {
            target_relayer_fee: decoded_target_relayer_fee,
            to_native_token_amount: decoded_to_native_token_amount,
            recipient: decoded_recipient,
        } = TokenBridgeRelayerMessage::deserialize(&mut encoded.as_slice())?;

        // Verify results.
        assert_eq!(decoded_target_relayer_fee, target_relayer_fee);
        assert_eq!(decoded_to_native_token_amount, to_native_token_amount);
        assert_eq!(decoded_recipient, recipient);

        Ok(())
    }

    #[test]
    fn test_invalid_payload_size() -> Result<()> {
        let recipient = Pubkey::new_unique().to_bytes();
        let to_native_token_amount: u64 = 100000000;
        let target_relayer_fee: u64 = 6900000;

        // Create the message.
        let msg = TokenBridgeRelayerMessage::TransferWithRelay {
            target_relayer_fee,
            to_native_token_amount,
            recipient,
        };

        // Serialize program ID above.
        let mut encoded = Vec::new();
        msg.serialize(&mut encoded)?;

        // Create an array with random bytes and extend `encoded`.
        let mut random_bytes = [0u8; 8];
        random_bytes.copy_from_slice(&encoded[0..8]);
        encoded.extend_from_slice(&random_bytes);

        // Now deserialize the encoded message.
        let result = TokenBridgeRelayerMessage::deserialize(&mut encoded.as_slice());

        // Verify results.
        assert!(result.is_err());

        Ok(())
    }
}
