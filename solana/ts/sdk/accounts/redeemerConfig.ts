import { deriveAddress } from "@certusone/wormhole-sdk/lib/cjs/solana";
import { Connection, PublicKey, PublicKeyInitData } from "@solana/web3.js";
import { createTokenBridgeRelayerProgramInterface } from "../program";

export function deriveRedeemerConfigKey(programId: PublicKeyInitData) {
  return deriveAddress([Buffer.from("redeemer")], programId);
}

export interface RedeemerConfigData {
  owner: PublicKey;
  bump: number;
  relayerFeePrecision: number;
  feeRecipient: PublicKey;
}

export async function getRedeemerConfigData(
  connection: Connection,
  programId: PublicKeyInitData
): Promise<RedeemerConfigData> {
  return createTokenBridgeRelayerProgramInterface(
    connection,
    programId
  ).account.redeemerConfig.fetch(deriveRedeemerConfigKey(programId));
}
