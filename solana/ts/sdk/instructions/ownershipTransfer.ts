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
  owner: PublicKeyInitData,
  newOwner: PublicKeyInitData
): Promise<TransactionInstruction> {
  const program = createTokenBridgeRelayerProgramInterface(
    connection,
    programId
  );

  return program.methods
    .submitOwnershipTransferRequest(new PublicKey(newOwner))
    .accounts({
      owner: new PublicKey(owner),
      ownerConfig: deriveOwnerConfigKey(programId),
    })
    .instruction();
}

export async function createCancelOwnershipTransferInstruction(
  connection: Connection,
  programId: PublicKeyInitData,
  owner: PublicKeyInitData
): Promise<TransactionInstruction> {
  const program = createTokenBridgeRelayerProgramInterface(
    connection,
    programId
  );

  return program.methods
    .cancelOwnershipTransferRequest()
    .accounts({
      owner: new PublicKey(owner),
      ownerConfig: deriveOwnerConfigKey(programId),
    })
    .instruction();
}

export async function createConfirmOwnershipTransferInstruction(
  connection: Connection,
  programId: PublicKeyInitData,
  pendingOwner: PublicKeyInitData
): Promise<TransactionInstruction> {
  const program = createTokenBridgeRelayerProgramInterface(
    connection,
    programId
  );

  return program.methods
    .confirmOwnershipTransferRequest()
    .accounts({
      pendingOwner: new PublicKey(pendingOwner),
      ownerConfig: deriveOwnerConfigKey(programId),
      senderConfig: deriveSenderConfigKey(programId),
      redeemerConfig: deriveRedeemerConfigKey(programId),
    })
    .instruction();
}

export async function createUpdateAssistantInstruction(
  connection: Connection,
  programId: PublicKeyInitData,
  owner: PublicKeyInitData,
  newAssistant: PublicKeyInitData
) {
  const program = createTokenBridgeRelayerProgramInterface(
    connection,
    programId
  );

  return program.methods
    .updateAssistant(new PublicKey(newAssistant))
    .accounts({
      owner: new PublicKey(owner),
      ownerConfig: deriveOwnerConfigKey(programId),
    })
    .instruction();
}
