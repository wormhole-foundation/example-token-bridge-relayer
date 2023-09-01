import { Connection, PublicKey, PublicKeyInitData, TransactionInstruction } from "@solana/web3.js";
import { ChainId } from "@certusone/wormhole-sdk";
import { BN } from "@coral-xyz/anchor";
import { createTokenBridgeRelayerProgramInterface } from "../program";
import {
  deriveOwnerConfigKey,
  deriveForeignContractKey,
  deriveSenderConfigKey,
  deriveRedeemerConfigKey,
} from "../accounts";

export async function createUpdateRelayerFeeInstruction(
  connection: Connection,
  programId: PublicKeyInitData,
  payer: PublicKeyInitData,
  chain: ChainId,
  relayerFee: BN
): Promise<TransactionInstruction> {
  const program = createTokenBridgeRelayerProgramInterface(connection, programId);

  return program.methods
    .updateRelayerFee(chain, relayerFee)
    .accounts({
      payer: new PublicKey(payer),
      ownerConfig: deriveOwnerConfigKey(program.programId),
      foreignContract: deriveForeignContractKey(program.programId, chain),
    })
    .instruction();
}

export async function createUpdateRelayerFeePrecisionInstruction(
  connection: Connection,
  programId: PublicKeyInitData,
  payer: PublicKeyInitData,
  relayerFeePrecision: number
): Promise<TransactionInstruction> {
  const program = createTokenBridgeRelayerProgramInterface(connection, programId);

  return program.methods
    .updateRelayerFeePrecision(relayerFeePrecision)
    .accounts({
      owner: new PublicKey(payer),
      redeemerConfig: deriveRedeemerConfigKey(programId),
      senderConfig: deriveSenderConfigKey(programId),
    })
    .instruction();
}
