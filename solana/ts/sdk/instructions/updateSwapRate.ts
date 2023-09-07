import { Connection, PublicKey, PublicKeyInitData } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { createTokenBridgeRelayerProgramInterface } from "../program";
import { deriveOwnerConfigKey, deriveRegisteredTokenKey } from "../accounts";

export async function createUpdateSwapRateInstruction(
  connection: Connection,
  programId: PublicKeyInitData,
  owner: PublicKeyInitData,
  mint: PublicKeyInitData,
  relayerFee: BN
) {
  const program = createTokenBridgeRelayerProgramInterface(connection, programId);

  return program.methods
    .updateSwapRate(relayerFee)
    .accounts({
      owner: new PublicKey(owner),
      ownerConfig: deriveOwnerConfigKey(programId),
      registeredToken: deriveRegisteredTokenKey(program.programId, new PublicKey(mint)),
      mint: new PublicKey(mint),
    })
    .instruction();
}
