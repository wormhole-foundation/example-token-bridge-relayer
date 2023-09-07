import { deriveAddress } from "@certusone/wormhole-sdk/lib/cjs/solana";
import { Connection, PublicKey, PublicKeyInitData } from "@solana/web3.js";
import { createTokenBridgeRelayerProgramInterface } from "../program";

export function deriveSenderConfigKey(programId: PublicKeyInitData) {
  return deriveAddress([Buffer.from("sender")], programId);
}
export interface SenderConfigData {
  owner: PublicKey;
  bump: number;
  tokenBridge: any;
  relayerFeePrecision: number;
  paused: boolean;
}

export async function getSenderConfigData(
  connection: Connection,
  programId: PublicKeyInitData
): Promise<SenderConfigData> {
  return createTokenBridgeRelayerProgramInterface(connection, programId).account.senderConfig.fetch(
    deriveSenderConfigKey(programId)
  );
}
