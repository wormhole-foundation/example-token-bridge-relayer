import {
  Ed25519Keypair,
  JsonRpcProvider,
  RawSigner,
  Connection,
  TransactionBlock,
  SUI_CLOCK_OBJECT_ID,
} from "@mysten/sui.js";
import {
  RELAYER_ID,
  RELAYER_STATE_ID,
  WORMHOLE_ID,
  WORMHOLE_STATE_ID,
  TOKEN_BRIDGE_ID,
  TOKEN_BRIDGE_STATE_ID,
  RPC,
  KEY,
} from "./consts";
import {
  parseVaa,
  parseTransferPayload,
  CHAIN_ID_SUI,
} from "@certusone/wormhole-sdk";
import {ethers} from "ethers";
import {
  getObjectFields,
  getTokenInfo,
  getTokenCoinType,
  getIsTransferCompletedSui,
  tokenBridgeDenormalizeAmount,
} from "../src";
import {executeTransactionBlock, pollTransactionForEffectsCert} from "./poll";
import yargs from "yargs";

export function getArgs() {
  const argv = yargs.options({
    vaa: {
      alias: "v",
      describe: "Redemption VAA",
      require: true,
      type: "string",
    },
  }).argv;

  if ("vaa" in argv) {
    return {
      vaa: argv.vaa,
    };
  } else {
    throw Error("Invalid arguments");
  }
}

// Foreign relayer contracts. (Lazy list).
const REGISTERED_RELAYER_CONTRACTS = [
  "000000000000000000000000e32b14c48e4b7c6825b855f231786fe5ba9ce014",
  "0000000000000000000000008369839932222c1ca3bc7d16f970c56f61993a44",
  "00000000000000000000000049a401f7fa594bc618a7a39b316b78e329620103",
  "0000000000000000000000005122298f68341a088c5370d7678e13912e4ed378",
  "0000000000000000000000005c9da01cbf5088ee660b9701dc526c6e5df1c239",
  "000000000000000000000000953a2342496b15d69dec25c8e62274995e82d243",
  "000000000000000000000000a098368aaadc0fdf3e309cda710d7a5f8bdeecd9",
];

const SUI_TYPE =
  "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

export async function getSwapQuote(
  provider: JsonRpcProvider,
  wallet: string,
  relayerId: string,
  relayerState: any,
  toNativeTokenAmount: string,
  decimals: number,
  coinType: string
): Promise<number> {
  // Fetch the swap quote by calling the contract.
  const tx = new TransactionBlock();

  tx.moveCall({
    target: `${relayerId}::redeem::calculate_native_swap_amount_out`,
    arguments: [
      tx.object(relayerState!.id.id),
      tx.pure(toNativeTokenAmount),
      tx.pure(decimals),
    ],
    typeArguments: [coinType],
  });

  // Fetch the swap quote response.
  const swapQuoteResponse = await provider.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: wallet,
  });

  const result = swapQuoteResponse.results![0].returnValues!;

  if (result.length != 1) {
    throw Error("Invalid swap quote response");
  }

  // Store the swapQuote.
  const swapQuote = Number(Buffer.from(result[0][0]).readBigUInt64LE(0));

  // Fetch the maxNativeSwapAmount.
  const maxNativeSwapAmount = await getTokenInfo(
    provider,
    relayerState,
    coinType
  ).then((result) => result.max_native_swap_amount);

  return Math.min(swapQuote, parseInt(maxNativeSwapAmount));
}

/**
 * Relays a VAA to the Sui Relayer contract.
 */
async function relay(
  provider: JsonRpcProvider,
  wallet: RawSigner,
  vaa: string
) {
  // Fetch relayer state.
  const state = await getObjectFields(provider, RELAYER_STATE_ID);

  // Check to see if the VAA has been redeemed already.
  const isRedeemed = await getIsTransferCompletedSui(
    provider,
    TOKEN_BRIDGE_STATE_ID,
    Uint8Array.from(Buffer.from(vaa, "hex"))
  );

  if (isRedeemed) {
    console.log("Vaa already redeemed");
    return;
  }

  // Parse the VAA.
  const parsedVaa = parseVaa(Buffer.from(vaa, "hex"));

  // Make sure it's a payload 3.
  const payloadType = parsedVaa.payload.readUint8(0);
  if (payloadType != 3) {
    console.log("Not a payload 3");
    return;
  }

  // Parse the transfer payload.
  const transferPayload = parseTransferPayload(parsedVaa.payload);

  // Confirm that the destination is the relayer contract.
  if (
    state!.emitter_cap.fields.id.id != transferPayload.targetAddress &&
    transferPayload.targetChain != CHAIN_ID_SUI
  ) {
    console.log("Destination is not a relayer contract");
    return;
  }

  // Confirm that the sender is a registered contract. This lazily checks an
  // array of addresses. The relayer should have a mapping or check the
  // contract state.
  if (!REGISTERED_RELAYER_CONTRACTS.includes(transferPayload.fromAddress!)) {
    console.log("Sender is not a registered relayer contract");
    return;
  }

  // Fetch the coinType.
  const coinType = await getTokenCoinType(
    provider,
    TOKEN_BRIDGE_STATE_ID,
    Uint8Array.from(Buffer.from(transferPayload.originAddress, "hex")),
    transferPayload.originChain
  );

  if (coinType == null) {
    throw Error("Error fetch the coin type. Is the coin registered?");
  }

  // Fetch the token decimals.
  let decimals;
  if (coinType == SUI_TYPE) {
    decimals = 9;
  } else {
    decimals = await provider
      .getCoinMetadata({
        coinType: coinType,
      })
      .then((result) => result!.decimals);

    if (decimals == null) {
      throw Error("Failed to fetch token decimals");
    }
  }

  // Parse and denormalize the to native token amount (swap amount).
  const denormalizedToNativeAmount = tokenBridgeDenormalizeAmount(
    Number(ethers.utils.hexlify(parsedVaa.payload.subarray(166, 198))),
    decimals
  );

  // Fetch the swap quote.
  let swapQuote;
  if (coinType == SUI_TYPE) {
    swapQuote = 0;
  } else {
    swapQuote = await getSwapQuote(
      provider,
      await wallet.getAddress(),
      RELAYER_ID,
      state,
      denormalizedToNativeAmount.toString(),
      decimals,
      coinType
    );
  }

  // Start new transaction.
  const tx = new TransactionBlock();

  // Parse and verify the vaa.
  const [verifiedVaa] = tx.moveCall({
    target: `${WORMHOLE_ID}::vaa::parse_and_verify`,
    arguments: [
      tx.object(WORMHOLE_STATE_ID),
      tx.pure(Array.from(Buffer.from(vaa, "hex"))),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  // Verify the VAA with the token bridge.
  const [tokenBridgeMessage] = tx.moveCall({
    target: `${TOKEN_BRIDGE_ID}::vaa::verify_only_once`,
    arguments: [tx.object(TOKEN_BRIDGE_STATE_ID), verifiedVaa],
  });

  // Authorize the transfer.
  const [redeemerReceipt] = tx.moveCall({
    target: `${TOKEN_BRIDGE_ID}::complete_transfer_with_payload::authorize_transfer`,
    arguments: [tx.object(TOKEN_BRIDGE_STATE_ID), tokenBridgeMessage],
    typeArguments: [coinType],
  });

  // Native coins to swap.
  const [coinsToTransfer] = tx.splitCoins(tx.gas, [tx.pure(swapQuote)]);

  // Complete the tranfer with relay.
  tx.moveCall({
    target: `${RELAYER_ID}::redeem::complete_transfer_with_relay`,
    arguments: [
      tx.object(RELAYER_STATE_ID),
      tx.object(TOKEN_BRIDGE_STATE_ID),
      redeemerReceipt,
      coinsToTransfer,
    ],
    typeArguments: [coinType],
  });

  const {digest, balanceChanges} = await executeTransactionBlock(wallet, tx);
  await pollTransactionForEffectsCert(wallet, digest);

  console.log(`Digest: ${digest}`);
  console.log(balanceChanges);

  // Check to see if the VAA has been redeemed already.
  {
    const isRedeemed = await getIsTransferCompletedSui(
      provider,
      TOKEN_BRIDGE_STATE_ID,
      Uint8Array.from(Buffer.from(vaa, "hex"))
    );

    if (isRedeemed) {
      console.log("Vaa already redeemed");
      return;
    }
  }
}

async function main() {
  // Fetch args.
  const args = getArgs();

  // Set up provider.
  const connection = new Connection({fullnode: RPC});
  const provider = new JsonRpcProvider(connection);

  // Owner wallet.
  const key = Ed25519Keypair.fromSecretKey(
    Buffer.from(KEY, "base64").subarray(1)
  );
  const wallet = new RawSigner(key, provider);

  // Complete the transfer.
  await relay(provider, wallet, args.vaa);
}

main();
