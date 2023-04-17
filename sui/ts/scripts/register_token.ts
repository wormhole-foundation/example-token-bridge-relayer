import {
  Ed25519Keypair,
  JsonRpcProvider,
  RawSigner,
  Connection,
  TransactionBlock,
} from "@mysten/sui.js";
import {
  RELAYER_ID,
  RELAYER_STATE_ID,
  RELAYER_OWNER_CAP_ID,
  RPC,
} from "./consts";
import {getTokenInfo, getObjectFields} from "../src";
import yargs from "yargs";

export function getArgs() {
  const argv = yargs.options({
    key: {
      alias: "k",
      describe: "Custom private key to sign txs",
      required: true,
      type: "string",
    },
    coinType: {
      alias: "c",
      describe: "Coin type to register",
      require: true,
      type: "string",
    },
    swapRate: {
      alias: "s",
      describe: "Swap rate for registered token",
      require: true,
      type: "string",
    },
    maxNativeSwapAmount: {
      alias: "m",
      describe: "Max native swap amount for registered token",
      require: true,
      type: "string",
    },
    swapsEnabled: {
      alias: "e",
      describe: "Determines if swaps are enabled for the token",
      require: true,
      type: "string",
    },
  }).argv;

  if (
    "key" in argv &&
    "coinType" in argv &&
    "swapRate" in argv &&
    "maxNativeSwapAmount" in argv &&
    "swapsEnabled" in argv &&
    (argv.swapsEnabled == "true" || argv.swapsEnabled == "false")
  ) {
    return {
      key: argv.key,
      coinType: argv.coinType,
      swapRate: argv.swapRate,
      maxNativeSwapAmount: argv.maxNativeSwapAmount,
      swapsEnabled: argv.swapsEnabled,
    };
  } else {
    throw Error("Invalid arguments");
  }
}

/**
 * Register token.
 */
async function register_token(
  provider: JsonRpcProvider,
  wallet: RawSigner,
  coinType: string,
  swapRate: string,
  maxSwapAmount: string,
  swapsEnabled: boolean
) {
  // Register the token.
  const tx = new TransactionBlock();
  tx.moveCall({
    target: `${RELAYER_ID}::owner::register_token`,
    arguments: [
      tx.object(RELAYER_OWNER_CAP_ID),
      tx.object(RELAYER_STATE_ID),
      tx.pure(swapRate),
      tx.pure(maxSwapAmount),
      tx.pure(swapsEnabled),
    ],
    typeArguments: [coinType],
  });
  const result = await wallet.signAndExecuteTransactionBlock({
    transactionBlock: tx,
  });

  if (result.digest === null) {
    return Promise.reject("Failed to register the token.");
  }

  // Fetch state.
  const state = await getObjectFields(provider, RELAYER_STATE_ID);

  // Verify state.
  const tokenInfo = await getTokenInfo(provider, state, coinType);
  const coinName = coinType.split("::", 3)[2];

  console.log(`${coinName} has been registered.`);
  console.log(`swapRate: ${tokenInfo.swap_rate}`);
  console.log(`maxSwapAmount: ${tokenInfo.max_native_swap_amount}`);
  console.log(`swapEnabled: ${tokenInfo.swap_enabled}`);
}

async function main() {
  // Fetch args.
  const args = getArgs();

  // Set up provider.
  const connection = new Connection({fullnode: RPC});
  const provider = new JsonRpcProvider(connection);

  // Owner wallet.
  const key = Ed25519Keypair.fromSecretKey(
    Buffer.from(args.key, "base64").subarray(1)
  );
  const wallet = new RawSigner(key, provider);

  // Create state.
  await register_token(
    provider,
    wallet,
    args.coinType,
    args.swapRate,
    args.maxNativeSwapAmount,
    args.swapsEnabled == "true"
  );
}

main();
