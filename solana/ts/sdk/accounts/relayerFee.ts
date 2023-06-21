import {ChainId} from "@certusone/wormhole-sdk";
import {deriveAddress} from "@certusone/wormhole-sdk/lib/cjs/solana";
import {Connection, PublicKeyInitData} from "@solana/web3.js";
import {createTokenBridgeRelayerProgramInterface} from "../program";
import {BN} from "@coral-xyz/anchor";

export function deriveRelayerFeeKey(
  programId: PublicKeyInitData,
  chain: ChainId
) {
  return deriveAddress(
    [
      Buffer.from("relayer_fee"),
      (() => {
        const buf = Buffer.alloc(2);
        buf.writeUInt16LE(chain);
        return buf;
      })(),
    ],
    programId
  );
}

export interface RelayerFee {
  chain: ChainId;
  fee: BN;
}

export async function getRelayerFeeData(
  connection: Connection,
  programId: PublicKeyInitData,
  chain: ChainId
): Promise<RelayerFee> {
  const {fee} = await createTokenBridgeRelayerProgramInterface(
    connection,
    programId
  ).account.relayerFee.fetch(deriveRelayerFeeKey(programId, chain));

  return {
    chain,
    fee: fee,
  };
}
