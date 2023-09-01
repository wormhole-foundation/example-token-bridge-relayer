import { expect, use as chaiUse, config } from "chai";
import chaiAsPromised from "chai-as-promised";
import { ethers } from "ethers";
chaiUse(chaiAsPromised);
import {
  LAMPORTS_PER_SOL,
  Connection,
  TransactionInstruction,
  sendAndConfirmTransaction,
  Transaction,
  Signer,
  PublicKey,
  ComputeBudgetProgram,
  ConfirmOptions,
} from "@solana/web3.js";
import {
  NodeWallet,
  postVaaSolana,
  signSendAndConfirmTransaction,
} from "@certusone/wormhole-sdk/lib/cjs/solana";
import {
  CORE_BRIDGE_PID,
  MOCK_GUARDIANS,
  MINTS_WITH_DECIMALS,
  WETH_ADDRESS,
  TOKEN_BRIDGE_RELAYER_PID,
  SWAP_RATE_PRECISION,
} from "./consts";
import { TOKEN_BRIDGE_PID } from "../helpers";
import {
  tryNativeToHexString,
  CHAIN_ID_ETH,
  parseTokenTransferPayload,
  ChainId,
} from "@certusone/wormhole-sdk";
import * as tokenBridgeRelayer from "../../sdk";
import { deriveWrappedMintKey } from "@certusone/wormhole-sdk/lib/cjs/solana/tokenBridge";
import * as wormhole from "@certusone/wormhole-sdk/lib/cjs/solana/wormhole";
import { NATIVE_MINT, getAccount } from "@solana/spl-token";

export interface Balances {
  recipient: {
    native: number;
    token: number;
  };
  relayer: {
    native: number;
    token: number;
  };
  feeRecipient: {
    native: number;
    token: number;
  };
}

export async function getBalance(
  connection: Connection,
  wallet: PublicKey,
  native: boolean,
  tokenAccount?: PublicKey
) {
  if (native) {
    return connection.getBalance(wallet);
  } else {
    if (tokenAccount === undefined) {
      throw new Error("tokenAccount must be provided");
    } else {
      return Number((await getAccount(connection, tokenAccount)).amount);
    }
  }
}

export function getDescription(decimals: number, isNative: boolean, mint: PublicKey) {
  // Create test description.
  let description = `For ${isNative ? "Native" : "Wrapped"} With ${decimals} Decimals`;

  if (mint == NATIVE_MINT) {
    description = "For Native SOL";
  }

  return description;
}

export function fetchTestTokens() {
  return [
    [
      true, // native = true
      9, // wrapped sol decimals
      NATIVE_MINT.toBuffer().toString("hex"),
      NATIVE_MINT,
      2000000000, // $20 swap rate
    ],
    [
      false,
      8, // wrapped token decimals
      tryNativeToHexString(WETH_ADDRESS, CHAIN_ID_ETH),
      deriveWrappedMintKey(TOKEN_BRIDGE_PID, CHAIN_ID_ETH, WETH_ADDRESS),
      5000000000, // $50 swap rate
    ],
    ...Array.from(MINTS_WITH_DECIMALS.entries()).map(
      ([decimals, { publicKey }]): [boolean, number, string, PublicKey, number] => [
        true,
        decimals,
        publicKey.toBuffer().toString("hex"),
        publicKey,
        200000000, // $2 swap rate
      ]
    ),
  ] as [boolean, number, string, PublicKey, number][];
}

export async function verifyRelayerMessage(
  connection: Connection,
  payer: PublicKey,
  sequence: bigint,
  normalizedAmount: number,
  normalizedRelayerFee: number,
  normalizedSwapAmount: number,
  recipient: Buffer
) {
  const tokenBridgeTransfer = parseTokenTransferPayload(
    (
      await wormhole.getPostedMessage(
        connection,
        tokenBridgeRelayer.deriveTokenTransferMessageKey(TOKEN_BRIDGE_RELAYER_PID, payer, sequence)
      )
    ).message.payload
  );
  const payload = tokenBridgeTransfer.tokenTransferPayload;

  // Verify transfer amount.
  expect(Number(tokenBridgeTransfer.amount)).equals(normalizedAmount);

  // Parse the swap amount and relayer fees.
  const relayerFeeInPayload = Number("0x" + payload.subarray(1, 33).toString("hex"));
  const swapAmountInPayload = Number("0x" + payload.subarray(33, 65).toString("hex"));
  const recipientInPayload = payload.subarray(65, 97);

  // Verify the payload.
  expect(payload.readUint8(0)).equals(1); // payload ID
  expect(relayerFeeInPayload).equals(normalizedRelayerFee);
  expect(swapAmountInPayload).equals(normalizedSwapAmount);
  expect(recipient).deep.equals(recipientInPayload);
}

export function createTransferWithRelayPayload(
  targetRelayerFee: number,
  toNativeTokenAmount: number,
  recipient: string
): string {
  const payloadType = "0x01";
  const encodedRelayerFee = ethers.utils
    .hexZeroPad(ethers.utils.hexlify(targetRelayerFee), 32)
    .substring(2);
  const encodedToNative = ethers.utils
    .hexZeroPad(ethers.utils.hexlify(toNativeTokenAmount), 32)
    .substring(2);

  return payloadType + encodedRelayerFee + encodedToNative + recipient;
}

export async function calculateRelayerFee(
  connection: Connection,
  programId: PublicKey,
  targetChain: ChainId,
  decimals: number,
  mint: PublicKey
) {
  // Fetch the relayer fee.
  const relayerFee = await tokenBridgeRelayer
    .getForeignContractData(connection, programId, targetChain)
    .then((data) => data.fee.toNumber());

  // Fetch the swap rate.
  const swapRate = await tokenBridgeRelayer
    .getRegisteredTokenData(connection, programId, mint)
    .then((data) => data.swapRate.toNumber());

  // Fetch the precision values.
  const relayerFeePrecision = await tokenBridgeRelayer
    .getRedeemerConfigData(connection, TOKEN_BRIDGE_RELAYER_PID)
    .then((data) => data.relayerFeePrecision);

  // Calculate the relayer fee.
  return Math.floor(
    (relayerFee * 10 ** decimals * SWAP_RATE_PRECISION) / (relayerFeePrecision * swapRate)
  );
}

export async function getSwapInputs(
  connection: Connection,
  programId: PublicKey,
  decimals: number,
  mint: PublicKey
) {
  // Fetch the swap rate.
  const [swapRate, maxNativeSwapAmount] = await tokenBridgeRelayer
    .getRegisteredTokenData(connection, programId, mint)
    .then((data) => [data.swapRate.toNumber(), data.maxNativeSwapAmount.toNumber()]);

  // Fetch the SOL swap rate.
  const solSwapRate = await tokenBridgeRelayer
    .getRegisteredTokenData(connection, programId, NATIVE_MINT)
    .then((data) => data.swapRate.toNumber());

  // Calculate the native swap rate.
  const nativeSwapRate = Math.floor((SWAP_RATE_PRECISION * solSwapRate) / swapRate);

  // Calculate the max swap amount.
  let maxNativeSwapAmountInTokens;
  if (decimals > 9) {
    maxNativeSwapAmountInTokens = Math.floor(
      (maxNativeSwapAmount * nativeSwapRate * 10 ** (decimals - 9)) / SWAP_RATE_PRECISION
    );
  } else {
    maxNativeSwapAmountInTokens = Math.floor(
      (maxNativeSwapAmount * nativeSwapRate) / (10 ** (9 - decimals) * SWAP_RATE_PRECISION)
    );
  }

  return [maxNativeSwapAmountInTokens, nativeSwapRate, SWAP_RATE_PRECISION];
}

export async function calculateSwapAmounts(
  connection: Connection,
  programId: PublicKey,
  decimals: number,
  mint: PublicKey,
  toNativeTokenAmount: number
) {
  // Fetch the swap inputs.
  const [maxNativeSwapAmount, nativeSwapRate, swapRatePrecision] = await getSwapInputs(
    connection,
    programId,
    decimals,
    mint
  );

  // Return if a swap is not possible.
  if (toNativeTokenAmount == 0 || maxNativeSwapAmount == 0) {
    return [0, 0];
  }

  // Override the toNativeTokenAmount if it exceeds the maxNativeSwapAmount.
  toNativeTokenAmount =
    toNativeTokenAmount > maxNativeSwapAmount ? maxNativeSwapAmount : toNativeTokenAmount;

  // Calculate the swap amount out.
  if (decimals > 9) {
    return [
      toNativeTokenAmount,
      Math.floor(
        (swapRatePrecision * toNativeTokenAmount) / (nativeSwapRate * 10 ** (decimals - 9))
      ),
    ];
  } else {
    return [
      toNativeTokenAmount,
      Math.floor((swapRatePrecision * toNativeTokenAmount * 10 ** (9 - decimals)) / nativeSwapRate),
    ];
  }
}

export function tokenBridgeNormalizeAmount(amount: number, decimals: number): number {
  if (decimals > 8) {
    amount = amount / 10 ** (decimals - 8);
  }
  return Math.floor(amount);
}

export function tokenBridgeDenormalizeAmount(amount: number, decimals: number): number {
  if (decimals > 8) {
    amount = amount * 10 ** (decimals - 8);
  }
  return Math.floor(amount);
}

export function tokenBridgeTransform(amount: number, decimals: number): number {
  return tokenBridgeDenormalizeAmount(tokenBridgeNormalizeAmount(amount, decimals), decimals);
}

export function getRandomInt(min: number, max: number) {
  min = Math.ceil(min);
  max = Math.floor(max);

  // The maximum is exclusive and the minimum is inclusive.
  return Math.floor(Math.random() * (max - min) + min);
}

// Prevent chai from truncating error messages.
config.truncateThreshold = 0;

export const range = (size: number) => [...Array(size).keys()];

export function programIdFromEnvVar(envVar: string): PublicKey {
  if (!process.env[envVar]) {
    throw new Error(`${envVar} environment variable not set`);
  }
  try {
    return new PublicKey(process.env[envVar]!);
  } catch (e) {
    throw new Error(
      `${envVar} environment variable is not a valid program id - value: ${process.env[envVar]}`
    );
  }
}

class SendIxError extends Error {
  logs: string;

  constructor(originalError: Error & { logs?: string[] }) {
    // The newlines don't actually show up correctly in chai's assertion error, but at least
    // we have all the information and can just replace '\n' with a newline manually to see
    // what's happening without having to change the code.
    const logs = originalError.logs?.join("\n") || "error had no logs";
    super(originalError.message + "\nlogs:\n" + logs);
    this.stack = originalError.stack;
    this.logs = logs;
  }
}

export const boilerPlateReduction = (connection: Connection, defaultSigner: Signer) => {
  // for signing wormhole messages
  const defaultNodeWallet = NodeWallet.fromSecretKey(defaultSigner.secretKey);

  const payerToWallet = (payer?: Signer) =>
    !payer || payer === defaultSigner
      ? defaultNodeWallet
      : NodeWallet.fromSecretKey(payer.secretKey);

  const requestAirdrop = async (account: PublicKey) =>
    connection.confirmTransaction(
      await connection.requestAirdrop(account, 1000 * LAMPORTS_PER_SOL)
    );

  const guardianSign = (message: Buffer) => MOCK_GUARDIANS.addSignatures(message, [0]);

  const postSignedMsgAsVaaOnSolana = async (signedMsg: Buffer, payer?: Signer) => {
    const wallet = payerToWallet(payer);
    await postVaaSolana(
      connection,
      wallet.signTransaction,
      CORE_BRIDGE_PID,
      wallet.key(),
      signedMsg
    );
  };

  const sendAndConfirmIx = async (
    ix: TransactionInstruction | Promise<TransactionInstruction>,
    signerOrSignersOrComputeUnits?: Signer | Signer[] | number,
    computeUnits?: number,
    options?: ConfirmOptions,
    logError: boolean = false
  ) => {
    let [signers, units] = (() => {
      if (!signerOrSignersOrComputeUnits) return [[defaultSigner], computeUnits];

      if (typeof signerOrSignersOrComputeUnits === "number") {
        if (computeUnits !== undefined) throw new Error("computeUnits can't be specified twice");
        return [[defaultSigner], signerOrSignersOrComputeUnits];
      }

      return [
        Array.isArray(signerOrSignersOrComputeUnits)
          ? signerOrSignersOrComputeUnits
          : [signerOrSignersOrComputeUnits],
        computeUnits,
      ];
    })();

    const tx = new Transaction().add(await ix);
    if (units) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units }));
    try {
      return await sendAndConfirmTransaction(connection, tx, signers, options).catch((err) => {
        if (logError) {
          console.log(err);
        }
        throw err;
      });
    } catch (error: any) {
      throw new SendIxError(error);
    }
  };

  const expectIxToSucceed = async (
    ix: TransactionInstruction | Promise<TransactionInstruction>,
    signerOrSignersOrComputeUnits?: Signer | Signer[] | number,
    computeUnits?: number,
    options?: ConfirmOptions
  ) =>
    expect(sendAndConfirmIx(ix, signerOrSignersOrComputeUnits, computeUnits, options, true)).to.be
      .fulfilled;

  const expectIxToFailWithError = async (
    ix: TransactionInstruction | Promise<TransactionInstruction>,
    errorMessage: string,
    signerOrSignersOrComputeUnits?: Signer | Signer[] | number,
    computeUnits?: number
  ) => {
    try {
      await sendAndConfirmIx(ix, signerOrSignersOrComputeUnits, computeUnits);
    } catch (error) {
      expect((error as SendIxError).logs).includes(errorMessage);
      return;
    }
    expect.fail("Expected transaction to fail");
  };

  const expectTxToSucceed = async (tx: Transaction | Promise<Transaction>, payer?: Signer) => {
    const wallet = payerToWallet(payer);
    return expect(
      signSendAndConfirmTransaction(connection, wallet.key(), wallet.signTransaction, await tx)
    ).to.be.fulfilled;
  };

  return {
    requestAirdrop,
    guardianSign,
    postSignedMsgAsVaaOnSolana,
    sendAndConfirmIx,
    expectIxToSucceed,
    expectIxToFailWithError,
    expectTxToSucceed,
  };
};
