import {
  Connection,
  PublicKey,
  PublicKeyInitData,
  TransactionInstruction,
} from "@solana/web3.js";
import {NATIVE_MINT} from "@solana/spl-token";
import {createTokenBridgeRelayerProgramInterface} from "../program";
import {deriveRegisteredTokenKey, deriveTokenAccountKey} from "../accounts";
import {BN} from "@coral-xyz/anchor";

// export async function createWrapAndTransferWithRelayInstruction(
//   connection: Connection,
//   programId: PublicKeyInitData,
//   payer: PublicKeyInitData,
//   lamports: BN
// ): Promise<TransactionInstruction> {
//   const program = createTokenBridgeRelayerProgramInterface(
//     connection,
//     programId
//   );

//   return program.methods
//     .wrapAndTransfer({lamports: lamports})
//     .accounts({
//       payer: new PublicKey(payer),
//       registeredToken: deriveRegisteredTokenKey(program.programId, NATIVE_MINT),
//       custodyToken: deriveTokenAccountKey(program.programId, NATIVE_MINT),
//     })
//     .instruction();
// }
