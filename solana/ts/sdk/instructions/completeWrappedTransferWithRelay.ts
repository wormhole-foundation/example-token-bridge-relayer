import {
  Connection,
  PublicKey,
  PublicKeyInitData,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import {CompleteTransferWrappedWithPayloadCpiAccounts} from "@certusone/wormhole-sdk/lib/cjs/solana";
import {createTokenBridgeRelayerProgramInterface} from "../program";
import {
  deriveForeignContractKey,
  deriveTmpTokenAccountKey,
  deriveRedeemerConfigKey,
  deriveRegisteredTokenKey,
} from "../accounts";
import {
  deriveClaimKey,
  derivePostedVaaKey,
} from "@certusone/wormhole-sdk/lib/cjs/solana/wormhole";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} from "@solana/spl-token";
import {
  isBytes,
  ParsedTokenTransferVaa,
  parseTokenTransferVaa,
  SignedVaa,
  ChainId,
} from "@certusone/wormhole-sdk";
import {
  deriveEndpointKey,
  deriveMintAuthorityKey,
  deriveRedeemerAccountKey,
  deriveTokenBridgeConfigKey,
  deriveWrappedMetaKey,
  deriveWrappedMintKey,
} from "@certusone/wormhole-sdk/lib/cjs/solana/tokenBridge";

export async function createCompleteWrappedTransferWithRelayInstruction(
  connection: Connection,
  programId: PublicKeyInitData,
  payer: PublicKeyInitData,
  feeRecipient: PublicKey,
  tokenBridgeProgramId: PublicKeyInitData,
  wormholeProgramId: PublicKeyInitData,
  wormholeMessage: SignedVaa | ParsedTokenTransferVaa,
  recipient: PublicKey
): Promise<TransactionInstruction> {
  const program = createTokenBridgeRelayerProgramInterface(
    connection,
    programId
  );

  const parsed = isBytes(wormholeMessage)
    ? parseTokenTransferVaa(wormholeMessage)
    : wormholeMessage;

  const wrappedMint = deriveWrappedMintKey(
    tokenBridgeProgramId,
    parsed.tokenChain,
    parsed.tokenAddress
  );

  const tmpTokenAccount = deriveTmpTokenAccountKey(programId, wrappedMint);
  const tokenBridgeAccounts = getCompleteTransferWrappedWithPayloadCpiAccounts(
    tokenBridgeProgramId,
    wormholeProgramId,
    payer,
    parsed,
    tmpTokenAccount
  );

  const recipientTokenAccount = getAssociatedTokenAddressSync(
    wrappedMint,
    recipient
  );
  const feeRecipientTokenAccount = getAssociatedTokenAddressSync(
    wrappedMint,
    feeRecipient
  );

  return program.methods
    .completeWrappedTransferWithRelay([...parsed.hash])
    .accounts({
      config: deriveRedeemerConfigKey(programId),
      foreignContract: deriveForeignContractKey(
        programId,
        parsed.emitterChain as ChainId
      ),
      tmpTokenAccount,
      registeredToken: deriveRegisteredTokenKey(
        programId,
        new PublicKey(wrappedMint)
      ),
      nativeRegisteredToken: deriveRegisteredTokenKey(
        programId,
        new PublicKey(NATIVE_MINT)
      ),
      recipientTokenAccount,
      recipient,
      feeRecipientTokenAccount,
      tokenBridgeProgram: new PublicKey(tokenBridgeProgramId),
      ...tokenBridgeAccounts,
    })
    .instruction();
}

// Temporary
export function getCompleteTransferWrappedWithPayloadCpiAccounts(
  tokenBridgeProgramId: PublicKeyInitData,
  wormholeProgramId: PublicKeyInitData,
  payer: PublicKeyInitData,
  vaa: SignedVaa | ParsedTokenTransferVaa,
  toTokenAccount: PublicKeyInitData
): CompleteTransferWrappedWithPayloadCpiAccounts {
  const parsed = isBytes(vaa) ? parseTokenTransferVaa(vaa) : vaa;
  const mint = deriveWrappedMintKey(
    tokenBridgeProgramId,
    parsed.tokenChain,
    parsed.tokenAddress
  );
  const cpiProgramId = new PublicKey(parsed.to);
  return {
    payer: new PublicKey(payer),
    tokenBridgeConfig: deriveTokenBridgeConfigKey(tokenBridgeProgramId),
    vaa: derivePostedVaaKey(wormholeProgramId, parsed.hash),
    tokenBridgeClaim: deriveClaimKey(
      tokenBridgeProgramId,
      parsed.emitterAddress,
      parsed.emitterChain,
      parsed.sequence
    ),
    tokenBridgeForeignEndpoint: deriveEndpointKey(
      tokenBridgeProgramId,
      parsed.emitterChain,
      parsed.emitterAddress
    ),
    toTokenAccount: new PublicKey(toTokenAccount),
    tokenBridgeRedeemer: deriveRedeemerAccountKey(cpiProgramId),
    toFeesTokenAccount: new PublicKey(toTokenAccount),
    tokenBridgeWrappedMint: mint,
    tokenBridgeWrappedMeta: deriveWrappedMetaKey(tokenBridgeProgramId, mint),
    tokenBridgeMintAuthority: deriveMintAuthorityKey(tokenBridgeProgramId),
    rent: SYSVAR_RENT_PUBKEY,
    systemProgram: SystemProgram.programId,
    tokenProgram: TOKEN_PROGRAM_ID,
    wormholeProgram: new PublicKey(wormholeProgramId),
  };
}
