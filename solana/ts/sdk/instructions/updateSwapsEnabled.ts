import {Connection, PublicKey, PublicKeyInitData} from "@solana/web3.js";
import {createTokenBridgeRelayerProgramInterface} from "../program";
import {deriveSenderConfigKey, deriveRegisteredTokenKey} from "../accounts";

export async function createUpdateSwapsEnabledInstruction(
  connection: Connection,
  programId: PublicKeyInitData,
  payer: PublicKeyInitData,
  mint: PublicKeyInitData,
  swapsEnabled: boolean
) {
  const program = createTokenBridgeRelayerProgramInterface(
    connection,
    programId
  );

  return program.methods
    .toggleSwaps(swapsEnabled)
    .accounts({
      owner: new PublicKey(payer),
      config: deriveSenderConfigKey(programId),
      registeredToken: deriveRegisteredTokenKey(
        program.programId,
        new PublicKey(mint)
      ),
      mint: new PublicKey(mint),
    })
    .instruction();
}
