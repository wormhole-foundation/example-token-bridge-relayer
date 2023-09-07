import { Connection, PublicKey, PublicKeyInitData, TransactionInstruction } from "@solana/web3.js";
import { ChainId } from "@certusone/wormhole-sdk";
import { deriveEndpointKey } from "@certusone/wormhole-sdk/lib/cjs/solana/tokenBridge";
import { createTokenBridgeRelayerProgramInterface } from "../program";
import { deriveSenderConfigKey, deriveForeignContractKey } from "../accounts";
import { BN } from "@project-serum/anchor";

export async function createRegisterForeignContractInstruction(
  connection: Connection,
  programId: PublicKeyInitData,
  payer: PublicKeyInitData,
  tokenBridgeProgramId: PublicKeyInitData,
  chain: ChainId,
  contractAddress: Buffer,
  tokenBridgeForeignAddress: string,
  initialRelayerFee: BN
): Promise<TransactionInstruction> {
  const program = createTokenBridgeRelayerProgramInterface(connection, programId);

  if (contractAddress.length !== 32) {
    throw new Error("Invalid contract address");
  }

  return program.methods
    .registerForeignContract(chain, [...contractAddress], initialRelayerFee)
    .accounts({
      owner: new PublicKey(payer),
      config: deriveSenderConfigKey(program.programId),
      foreignContract: deriveForeignContractKey(program.programId, chain),
      tokenBridgeForeignEndpoint: deriveEndpointKey(
        tokenBridgeProgramId,
        chain,
        Uint8Array.from(Buffer.from(tokenBridgeForeignAddress.substring(2), "hex"))
      ),
      tokenBridgeProgram: new PublicKey(tokenBridgeProgramId),
    })
    .instruction();
}
