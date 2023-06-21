import {Connection, PublicKey, PublicKeyInitData} from "@solana/web3.js";
import {BN} from "@coral-xyz/anchor";
import {createTokenBridgeRelayerProgramInterface} from "../program";
import {deriveSenderConfigKey, deriveRegisteredTokenKey} from "../accounts";

export async function createUpdateMaxNativeSwapAmountInstruction(
  connection: Connection,
  programId: PublicKeyInitData,
  payer: PublicKeyInitData,
  mint: PublicKeyInitData,
  maxNativeSwapAmount: BN
) {
  const program = createTokenBridgeRelayerProgramInterface(
    connection,
    programId
  );

  return program.methods
    .updateMaxNativeSwapAmount(maxNativeSwapAmount)
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
