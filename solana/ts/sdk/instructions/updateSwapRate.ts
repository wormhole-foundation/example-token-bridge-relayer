import {
  Connection,
  PublicKey,
  PublicKeyInitData,
  TransactionInstruction,
} from "@solana/web3.js";
import {BN} from "@coral-xyz/anchor";
import {createTokenBridgeRelayerProgramInterface} from "../program";
import {
  deriveOwnerConfigKey,
  deriveRedeemerConfigKey,
  deriveRegisteredTokenKey,
} from "../accounts";

export async function createUpdateSwapRateInstruction(
  connection: Connection,
  programId: PublicKeyInitData,
  payer: PublicKeyInitData,
  mint: PublicKeyInitData,
  relayerFee: BN
) {
  const program = createTokenBridgeRelayerProgramInterface(
    connection,
    programId
  );

  return program.methods
    .updateSwapRate(relayerFee)
    .accounts({
      payer: new PublicKey(payer),
      ownerConfig: deriveOwnerConfigKey(programId),
      registeredToken: deriveRegisteredTokenKey(
        program.programId,
        new PublicKey(mint)
      ),
      mint: new PublicKey(mint),
    })
    .instruction();
}

export async function createUpdateSwapRatePrecisionInstruction(
  connection: Connection,
  programId: PublicKeyInitData,
  payer: PublicKeyInitData,
  relayerFeePrecision: number
): Promise<TransactionInstruction> {
  const program = createTokenBridgeRelayerProgramInterface(
    connection,
    programId
  );

  return program.methods
    .updateSwapRatePrecision(relayerFeePrecision)
    .accounts({
      owner: new PublicKey(payer),
      config: deriveRedeemerConfigKey(programId),
    })
    .instruction();
}
