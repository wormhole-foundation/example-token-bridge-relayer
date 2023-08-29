import { deriveAddress } from "@certusone/wormhole-sdk/lib/cjs/solana";
import { Connection, PublicKey, PublicKeyInitData } from "@solana/web3.js";
import { createTokenBridgeRelayerProgramInterface } from "../program";
import { BN } from "@coral-xyz/anchor";

export function deriveSignerSequence(programId: PublicKeyInitData, payerKey: PublicKeyInitData) {
  return deriveAddress([Buffer.from("seq"), new PublicKey(payerKey).toBuffer()], programId);
}

export async function getSignerSequenceData(
  connection: Connection,
  programId: PublicKeyInitData,
  payerKey: PublicKeyInitData
): Promise<BN> {
  const program = createTokenBridgeRelayerProgramInterface(connection, programId);
  return program.account.signerSequence
    .fetch(deriveSignerSequence(programId, payerKey))
    .then((acct) => acct.value)
    .catch(() => new BN(0));
}
