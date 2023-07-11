import {deriveAddress} from "@certusone/wormhole-sdk/lib/cjs/solana";
import {Connection, PublicKey, PublicKeyInitData} from "@solana/web3.js";
import {createTokenBridgeRelayerProgramInterface} from "../program";

export function deriveOwnerConfigKey(programId: PublicKeyInitData) {
  return deriveAddress([Buffer.from("owner")], programId);
}

export interface OwnerConfigData {
  owner: PublicKey;
  assistant: PublicKey;
  pendingOwner: PublicKey | null;
}

export async function getOwnerConfigData(
  connection: Connection,
  programId: PublicKeyInitData
): Promise<OwnerConfigData> {
  return createTokenBridgeRelayerProgramInterface(
    connection,
    programId
  ).account.ownerConfig.fetch(deriveOwnerConfigKey(programId));
}
