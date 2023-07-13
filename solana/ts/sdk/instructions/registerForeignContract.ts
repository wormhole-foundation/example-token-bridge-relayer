import {
  Connection,
  PublicKey,
  PublicKeyInitData,
  TransactionInstruction,
} from "@solana/web3.js";
import {ChainId} from "@certusone/wormhole-sdk";
import {deriveEndpointKey} from "@certusone/wormhole-sdk/lib/cjs/solana/tokenBridge";
import {createTokenBridgeRelayerProgramInterface} from "../program";
import {deriveSenderConfigKey, deriveForeignContractKey} from "../accounts";

export async function createRegisterForeignContractInstruction(
  connection: Connection,
  programId: PublicKeyInitData,
  payer: PublicKeyInitData,
  tokenBridgeProgramId: PublicKeyInitData,
  chain: ChainId,
  contractAddress: Buffer,
  tokenBridgeForeignAddress: string
): Promise<TransactionInstruction> {
  const program = createTokenBridgeRelayerProgramInterface(
    connection,
    programId
  );

  return program.methods
    .registerForeignContract(chain, [...contractAddress])
    .accounts({
      owner: new PublicKey(payer),
      config: deriveSenderConfigKey(program.programId),
      foreignContract: deriveForeignContractKey(program.programId, chain),
      tokenBridgeForeignEndpoint: deriveEndpointKey(
        tokenBridgeProgramId,
        chain,
        Uint8Array.from(
          Buffer.from(tokenBridgeForeignAddress.substring(2), "hex")
        )
      ),
      tokenBridgeProgram: new PublicKey(tokenBridgeProgramId),
    })
    .instruction();
}
