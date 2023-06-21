import {
  Connection,
  PublicKey,
  PublicKeyInitData,
  TransactionInstruction,
} from "@solana/web3.js";
import {getTokenBridgeDerivedAccounts} from "@certusone/wormhole-sdk/lib/cjs/solana";
import {createTokenBridgeRelayerProgramInterface} from "../program";
import {
  deriveSenderConfigKey,
  deriveRedeemerConfigKey,
  deriveOwnerConfigKey,
} from "../accounts";

export async function createInitializeInstruction(
  connection: Connection,
  programId: PublicKeyInitData,
  payer: PublicKeyInitData,
  tokenBridgeProgramId: PublicKeyInitData,
  wormholeProgramId: PublicKeyInitData,
  feeRecipient: PublicKeyInitData,
  assistant: PublicKeyInitData
): Promise<TransactionInstruction> {
  const program = createTokenBridgeRelayerProgramInterface(
    connection,
    programId
  );
  const tokenBridgeAccounts = getTokenBridgeDerivedAccounts(
    program.programId,
    tokenBridgeProgramId,
    wormholeProgramId
  );
  return program.methods
    .initialize(new PublicKey(feeRecipient), new PublicKey(assistant))
    .accounts({
      owner: new PublicKey(payer),
      senderConfig: deriveSenderConfigKey(programId),
      redeemerConfig: deriveRedeemerConfigKey(programId),
      ownerConfig: deriveOwnerConfigKey(programId),
      tokenBridgeProgram: new PublicKey(tokenBridgeProgramId),
      wormholeProgram: new PublicKey(wormholeProgramId),
      ...tokenBridgeAccounts,
    })
    .instruction();
}
