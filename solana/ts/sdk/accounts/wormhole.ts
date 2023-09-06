import { deriveAddress } from "@certusone/wormhole-sdk/lib/cjs/solana";
import { deriveWormholeEmitterKey } from "@certusone/wormhole-sdk/lib/cjs/solana/wormhole";
import { PublicKey } from "@metaplex-foundation/js";
import { PublicKeyInitData } from "@solana/web3.js";

export { deriveWormholeEmitterKey };

export function deriveTokenTransferMessageKey(
  programId: PublicKeyInitData,
  payer: PublicKeyInitData,
  sequence: bigint
) {
  return deriveAddress(
    [
      Buffer.from("bridged"),
      new PublicKey(payer).toBuffer(),
      (() => {
        const buf = Buffer.alloc(8);
        buf.writeBigUInt64BE(sequence);
        return buf;
      })(),
    ],
    programId
  );
}
