import { Connection, PublicKey, PublicKeyInitData, TransactionInstruction } from "@solana/web3.js";
import { getTransferNativeWithPayloadCpiAccounts } from "@certusone/wormhole-sdk/lib/cjs/solana";
import { createTokenBridgeRelayerProgramInterface } from "../program";
import {
  deriveForeignContractKey,
  deriveSenderConfigKey,
  deriveTokenTransferMessageKey,
  deriveRegisteredTokenKey,
  deriveTmpTokenAccountKey,
  deriveSignerSequence,
} from "../accounts";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SendTokensParams } from "./types";
import { BN } from "@coral-xyz/anchor";

export async function createTransferNativeTokensWithRelayInstruction(
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
  const tmpTokenAccount = deriveTmpTokenAccountKey(programId, mint);
  const tokenBridgeAccounts = getTransferNativeWithPayloadCpiAccounts(
    programId,
    tokenBridgeProgramId,
    wormholeProgramId,
    payer,
    message,
    fromTokenAccount,
    mint
  );

  return program.methods
    .transferNativeTokensWithRelay(
      new BN(params.amount.toString()),
      new BN(params.toNativeTokenAmount.toString()),
      params.recipientChain,
      [...params.recipientAddress],
      params.batchId,
      params.wrapNative
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
