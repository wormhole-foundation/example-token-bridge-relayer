import { ChainId } from "@certusone/wormhole-sdk";
import { deriveAddress } from "@certusone/wormhole-sdk/lib/cjs/solana";
import { Connection, PublicKeyInitData } from "@solana/web3.js";
import { createTokenBridgeRelayerProgramInterface } from "../program";
import { BN } from "@coral-xyz/anchor";

export function deriveForeignContractKey(programId: PublicKeyInitData, chain: ChainId) {
  return deriveAddress(
    [
      Buffer.from("foreign_contract"),
      (() => {
        const buf = Buffer.alloc(2);
        buf.writeUInt16BE(chain);
        return buf;
      })(),
    ],
    programId
  );
}

export interface ForeignEmitter {
  chain: ChainId;
  address: Buffer;
  fee: BN;
}

export async function getForeignContractData(
  connection: Connection,
  programId: PublicKeyInitData,
  chain: ChainId
): Promise<ForeignEmitter> {
  const { address, fee } = await createTokenBridgeRelayerProgramInterface(
    connection,
    programId
  ).account.foreignContract.fetch(deriveForeignContractKey(programId, chain));

  return {
    chain,
    address: Buffer.from(address),
    fee,
  };
}
