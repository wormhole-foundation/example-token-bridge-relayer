import {
  Connection,
  PublicKey,
  PublicKeyInitData,
  TransactionInstruction,
} from "@solana/web3.js";
import { getTokenBridgeDerivedAccounts } from "@certusone/wormhole-sdk/lib/cjs/solana";
import { createTokenBridgeRelayerProgramInterface } from "../program";
import {
  deriveSenderConfigKey,
  deriveRedeemerConfigKey,
  deriveOwnerConfigKey,
} from "../accounts";

export const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);

export function getProgramData(programId: PublicKeyInitData) {
  const [addr] = PublicKey.findProgramAddressSync(
    [new PublicKey(programId).toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID
  );
  return addr;
}

export async function createInitializeInstruction(
  connection: Connection,
  programId: PublicKeyInitData,
  payer: PublicKeyInitData,
  tokenBridgeProgramId: PublicKeyInitData,
  wormholeProgramId: PublicKeyInitData,
  feeRecipient: PublicKeyInitData,
  assistant: PublicKeyInitData
): Promise<TransactionInstruction> {
  const program = createTokenBridgeRelayerProgramInterface(
    connection,
    programId
  );
  const { tokenBridgeEmitter, tokenBridgeSequence } =
    getTokenBridgeDerivedAccounts(
      program.programId,
      tokenBridgeProgramId,
      wormholeProgramId
    );
  return program.methods
    .initialize(new PublicKey(feeRecipient), new PublicKey(assistant))
    .accounts({
      owner: new PublicKey(payer),
      senderConfig: deriveSenderConfigKey(programId),
      redeemerConfig: deriveRedeemerConfigKey(programId),
      ownerConfig: deriveOwnerConfigKey(programId),
      programData: getProgramData(programId),
      bpfLoaderUpgradeableProgram: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
      tokenBridgeEmitter,
      tokenBridgeSequence,
    })
    .instruction();
}
