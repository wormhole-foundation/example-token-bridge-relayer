import {
  Connection,
  PublicKey,
  PublicKeyInitData,
  TransactionInstruction,
} from "@solana/web3.js";
import {BN} from "@coral-xyz/anchor";
import {createTokenBridgeRelayerProgramInterface} from "../program";
import {deriveSenderConfigKey, deriveRegisteredTokenKey} from "../accounts";

export async function createRegisterTokenInstruction(
  connection: Connection,
  programId: PublicKeyInitData,
  payer: PublicKeyInitData,
  mint: PublicKeyInitData,
  swap_rate: BN,
  max_native_swap_amount: BN
): Promise<TransactionInstruction> {
  const program = createTokenBridgeRelayerProgramInterface(
    connection,
    programId
  );

  return program.methods
    .registerToken(swap_rate, max_native_swap_amount)
    .accounts({
      owner: new PublicKey(payer),
      config: deriveSenderConfigKey(program.programId),
      registeredToken: deriveRegisteredTokenKey(
        program.programId,
        new PublicKey(mint)
      ),
      mint: new PublicKey(mint),
    })
    .instruction();
}

export async function createDeregisterTokenInstruction(
  connection: Connection,
  programId: PublicKeyInitData,
  payer: PublicKeyInitData,
  mint: PublicKeyInitData
): Promise<TransactionInstruction> {
  const program = createTokenBridgeRelayerProgramInterface(
    connection,
    programId
  );
  return program.methods
    .deregisterToken()
    .accounts({
      owner: new PublicKey(payer),
      config: deriveSenderConfigKey(program.programId),
      registeredToken: deriveRegisteredTokenKey(
        program.programId,
        new PublicKey(mint)
      ),
      mint: new PublicKey(mint),
    })
    .instruction();
}
