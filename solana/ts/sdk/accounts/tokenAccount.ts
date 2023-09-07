import {deriveAddress} from "@certusone/wormhole-sdk/lib/cjs/solana";
import {PublicKey, PublicKeyInitData} from "@solana/web3.js";

export function deriveTokenAccountKey(
  programId: PublicKeyInitData,
  mint: PublicKeyInitData
) {
  return deriveAddress(
    [Buffer.from("token"), new PublicKey(mint).toBuffer()],
    programId
  );
}
