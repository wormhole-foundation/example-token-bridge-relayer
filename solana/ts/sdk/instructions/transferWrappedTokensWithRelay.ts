import {
  Connection,
  PublicKey,
  PublicKeyInitData,
  TransactionInstruction,
} from "@solana/web3.js";
import { getTransferWrappedWithPayloadCpiAccounts } from "@certusone/wormhole-sdk/lib/cjs/solana";
import { createTokenBridgeRelayerProgramInterface } from "../program";
import {
  deriveForeignContractKey,
  deriveSenderConfigKey,
  deriveTokenTransferMessageKey,
  deriveTmpTokenAccountKey,
  deriveRegisteredTokenKey,
  deriveRelayerFeeKey,
  deriveTokenAccountKey,
} from "../accounts";
import { getProgramSequenceTracker } from "@certusone/wormhole-sdk/lib/cjs/solana/wormhole";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SendTokensParams } from "./types";
import { getWrappedMeta } from "@certusone/wormhole-sdk/lib/cjs/solana/tokenBridge";
import { BN } from "@coral-xyz/anchor";

export async function createTransferWrappedTokensWithRelayInstruction(
  connection: Connection,
  programId: PublicKeyInitData,
  payer: PublicKeyInitData,
  tokenBridgeProgramId: PublicKeyInitData,
  wormholeProgramId: PublicKeyInitData,
  mint: PublicKeyInitData,
  params: SendTokensParams
): Promise<TransactionInstruction> {
  const program = createTokenBridgeRelayerProgramInterface(
    connection,
    programId
  );

  return getProgramSequenceTracker(
    connection,
    tokenBridgeProgramId,
    wormholeProgramId
  )
    .then((tracker) =>
      deriveTokenTransferMessageKey(programId, tracker.sequence)
    )
    .then(async (message) => {
      const fromTokenAccount = getAssociatedTokenAddressSync(
        new PublicKey(mint),
        new PublicKey(payer)
      );

      const wrappedMeta = await getWrappedMeta(
        connection,
        tokenBridgeProgramId,
        mint
      );
      const tmpTokenAccount = deriveTmpTokenAccountKey(programId, mint);
      const tokenBridgeAccounts = getTransferWrappedWithPayloadCpiAccounts(
        programId,
        tokenBridgeProgramId,
        wormholeProgramId,
        payer,
        message,
        fromTokenAccount,
        wrappedMeta.chain,
        wrappedMeta.tokenAddress
      );

      return program.methods
        .transferWrappedTokensWithRelay(
          new BN(params.amount.toString()),
          new BN(params.toNativeTokenAmount.toString()),
          params.recipientChain,
          [...params.recipientAddress],
          params.batchId
        )
        .accounts({
          config: deriveSenderConfigKey(programId),
          foreignContract: deriveForeignContractKey(
            programId,
            params.recipientChain
          ),
          registeredToken: deriveRegisteredTokenKey(
            program.programId,
            new PublicKey(mint)
          ),
          relayerFee: deriveRelayerFeeKey(programId, params.recipientChain),
          tmpTokenAccount: tmpTokenAccount,
          tokenBridgeProgram: new PublicKey(tokenBridgeProgramId),
          ...tokenBridgeAccounts,
        })
        .instruction();
    });
}
