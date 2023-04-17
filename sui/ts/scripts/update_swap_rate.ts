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
  }).argv;

  if ("key" in argv && "coinType" in argv && "swapRate" in argv) {
    return {
      key: argv.key,
      coinType: argv.coinType,
      swapRate: argv.swapRate,
    };
  } else {
    throw Error("Invalid arguments");
  }
}

/**
 * Updates the swap rate for the specified coin type.
 */
async function update_swap_rate(
  provider: JsonRpcProvider,
  wallet: RawSigner,
  coinType: string,
  swapRate: string
) {
  // Update the swap rate.
  const tx = new TransactionBlock();
  tx.moveCall({
    target: `${RELAYER_ID}::owner::update_swap_rate`,
    arguments: [
      tx.object(RELAYER_OWNER_CAP_ID),
      tx.object(RELAYER_STATE_ID),
      tx.pure(swapRate),
    ],
    typeArguments: [coinType],
  });
  const result = await wallet.signAndExecuteTransactionBlock({
    transactionBlock: tx,
  });

  if (result.digest === null) {
    return Promise.reject("Failed to update the swap rate.");
  }

  // Fetch state.
  const state = await getObjectFields(provider, RELAYER_STATE_ID);

  // Verify state.
  const tokenInfo = await getTokenInfo(provider, state, coinType);
  const coinName = coinType.split("::", 3)[2];

  console.log(`Swap rate updated to ${tokenInfo.swap_rate} for ${coinName}.`);
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
  await update_swap_rate(provider, wallet, args.coinType, args.swapRate);
}

main();
