import {
  Connection,
  PublicKey,
  PublicKeyInitData,
  TransactionInstruction,
} from "@solana/web3.js";
import {createTokenBridgeRelayerProgramInterface} from "../program";
import {
  deriveSenderConfigKey,
  deriveRedeemerConfigKey,
  deriveOwnerConfigKey,
} from "../accounts";

export async function createSubmitOwnershipTransferInstruction(
  connection: Connection,
  programId: PublicKeyInitData,
  payer: PublicKeyInitData,
  newOwner: PublicKeyInitData
): Promise<TransactionInstruction> {
  const program = createTokenBridgeRelayerProgramInterface(
    connection,
    programId
  );

  return program.methods
    .submitOwnershipTransferRequest(new PublicKey(newOwner))
    .accounts({
      owner: new PublicKey(payer),
      ownerConfig: deriveOwnerConfigKey(programId),
    })
    .instruction();
}

export async function createCancelOwnershipTransferInstruction(
  connection: Connection,
  programId: PublicKeyInitData,
  payer: PublicKeyInitData
): Promise<TransactionInstruction> {
  const program = createTokenBridgeRelayerProgramInterface(
    connection,
    programId
  );

  return program.methods
    .cancelOwnershipTransferRequest()
    .accounts({
      owner: new PublicKey(payer),
      ownerConfig: deriveOwnerConfigKey(programId),
    })
    .instruction();
}

export async function createConfirmOwnershipTransferInstruction(
  connection: Connection,
  programId: PublicKeyInitData,
  payer: PublicKeyInitData
): Promise<TransactionInstruction> {
  const program = createTokenBridgeRelayerProgramInterface(
    connection,
    programId
  );

  return program.methods
    .confirmOwnershipTransferRequest()
    .accounts({
      payer: new PublicKey(payer),
      ownerConfig: deriveOwnerConfigKey(programId),
      senderConfig: deriveSenderConfigKey(programId),
      redeemerConfig: deriveRedeemerConfigKey(programId),
    })
    .instruction();
}
