import { deriveAddress } from "@certusone/wormhole-sdk/lib/cjs/solana";
import { Connection, PublicKey, PublicKeyInitData } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { createTokenBridgeRelayerProgramInterface } from "../program";

export function deriveRegisteredTokenKey(programId: PublicKeyInitData, mint: PublicKey) {
  return deriveAddress([Buffer.from("mint"), mint.toBuffer()], programId);
}

export interface RegisteredTokenData {
  swapRate: BN;
  maxNativeSwapAmount: BN;
}

export async function getRegisteredTokenData(
  connection: Connection,
  programId: PublicKeyInitData,
  mint: PublicKey
): Promise<RegisteredTokenData> {
  return createTokenBridgeRelayerProgramInterface(
    connection,
    programId
  ).account.registeredToken.fetch(deriveRegisteredTokenKey(programId, mint));
}
