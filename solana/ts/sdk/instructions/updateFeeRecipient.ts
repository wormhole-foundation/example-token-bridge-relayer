import {
  Connection,
  PublicKey,
  PublicKeyInitData,
  TransactionInstruction,
} from "@solana/web3.js";
import {createTokenBridgeRelayerProgramInterface} from "../program";
import {deriveRedeemerConfigKey} from "../accounts";

export async function createUpdateFeeRecipientInstruction(
  connection: Connection,
  programId: PublicKeyInitData,
  payer: PublicKeyInitData,
  newFeeRecipient: PublicKeyInitData
): Promise<TransactionInstruction> {
  const program = createTokenBridgeRelayerProgramInterface(
    connection,
    programId
  );

  return program.methods
    .updateFeeRecipient(new PublicKey(newFeeRecipient))
    .accounts({
      owner: new PublicKey(payer),
      redeemerConfig: deriveRedeemerConfigKey(programId),
    })
    .instruction();
}
