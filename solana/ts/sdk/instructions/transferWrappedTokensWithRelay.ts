import { Connection, PublicKey, PublicKeyInitData, TransactionInstruction } from "@solana/web3.js";
import { getTransferWrappedWithPayloadCpiAccounts } from "@certusone/wormhole-sdk/lib/cjs/solana";
import { createTokenBridgeRelayerProgramInterface } from "../program";
import {
  deriveForeignContractKey,
  deriveSenderConfigKey,
  deriveTokenTransferMessageKey,
  deriveTmpTokenAccountKey,
  deriveRegisteredTokenKey,
  deriveSignerSequence,
} from "../accounts";
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
  const program = createTokenBridgeRelayerProgramInterface(connection, programId);

  // Fetch the signer sequence.
  const signerSequence = deriveSignerSequence(programId, payer);
  const payerSequenceValue = await program.account.signerSequence
    .fetch(signerSequence)
    .then((acct) => acct.value)
    .catch(() => new BN(0));

  const message = deriveTokenTransferMessageKey(
    programId,
    payer,
    BigInt(payerSequenceValue.toString())
  );
  const fromTokenAccount = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(payer));

  const wrappedMeta = await getWrappedMeta(connection, tokenBridgeProgramId, mint);
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
      payerSequence: signerSequence,
      foreignContract: deriveForeignContractKey(programId, params.recipientChain),
      registeredToken: deriveRegisteredTokenKey(program.programId, new PublicKey(mint)),
      tmpTokenAccount: tmpTokenAccount,
      tokenBridgeProgram: new PublicKey(tokenBridgeProgramId),
      ...tokenBridgeAccounts,
    })
    .instruction();
}
