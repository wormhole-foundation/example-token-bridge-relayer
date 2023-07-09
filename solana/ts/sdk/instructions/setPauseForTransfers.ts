import {Connection, PublicKey, PublicKeyInitData} from "@solana/web3.js";
import {createTokenBridgeRelayerProgramInterface} from "../program";
import {deriveSenderConfigKey} from "../accounts";

export async function createSetPauseForTransfersInstruction(
  connection: Connection,
  programId: PublicKeyInitData,
  payer: PublicKeyInitData,
  paused: boolean
) {
  const program = createTokenBridgeRelayerProgramInterface(
    connection,
    programId
  );

  return program.methods
    .setPauseForTransfers(paused)
    .accounts({
      owner: new PublicKey(payer),
      config: deriveSenderConfigKey(programId),
    })
    .instruction();
}
