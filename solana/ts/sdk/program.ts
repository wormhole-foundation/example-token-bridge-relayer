import {Connection, PublicKeyInitData, PublicKey} from "@solana/web3.js";
import {Program, Provider} from "@coral-xyz/anchor";

import {TokenBridgeRelayer} from "../../target/types/token_bridge_relayer";
import IDL from "../../target/idl/token_bridge_relayer.json";

export function createTokenBridgeRelayerProgramInterface(
  connection: Connection,
  programId: PublicKeyInitData,
  payer?: PublicKeyInitData
): Program<TokenBridgeRelayer> {
  const provider: Provider = {
    connection,
    publicKey: payer == undefined ? undefined : new PublicKey(payer),
  };
  return new Program<TokenBridgeRelayer>(
    IDL as any,
    new PublicKey(programId),
    provider
  );
}
