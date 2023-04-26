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
  KEY,
} from "./consts";
import {getTokenInfo, getObjectFields} from "../src";
import yargs from "yargs";

export function getArgs() {
  const argv = yargs.options({
    coinType: {
      alias: "c",
      describe: "Coin type",
      require: true,
      type: "string",
    },
    enableSwaps: {
      alias: "t",
      describe:
        "Toggle for enabling and disabling swaps for a registered token",
      require: true,
      type: "string",
    },
  }).argv;

  if (
    "coinType" in argv &&
    "enableSwaps" in argv &&
    (argv.enableSwaps == "true" || argv.enableSwaps == "false")
  ) {
    return {
      coinType: argv.coinType,
      enableSwaps: argv.enableSwaps,
    };
  } else {
    throw Error("Invalid arguments");
  }
}

/**
 * Toggles if swaps are enabled for the specified coin type.
 */
async function toggle_swaps(
  provider: JsonRpcProvider,
  wallet: RawSigner,
  coinType: string,
  enableSwaps: boolean
) {
  // Update if swaps are enabled.
  const tx = new TransactionBlock();
  tx.moveCall({
    target: `${RELAYER_ID}::owner::toggle_swap_enabled`,
    arguments: [
      tx.object(RELAYER_OWNER_CAP_ID),
      tx.object(RELAYER_STATE_ID),
      tx.pure(enableSwaps),
    ],
    typeArguments: [coinType],
  });
  const result = await wallet.signAndExecuteTransactionBlock({
    transactionBlock: tx,
  });

  if (result.digest === null) {
    return Promise.reject("Failed to toggle swaps.");
  }

  console.log(`Transaction digest: ${result.digest}`);

  // Fetch state.
  const state = await getObjectFields(provider, RELAYER_STATE_ID);

  // Verify state.
  const tokenInfo = await getTokenInfo(provider, state, coinType);
  const coinName = coinType.split("::", 3)[2];

  console.log(`Swaps are enabled=${tokenInfo.swap_enabled} for ${coinName}.`);
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

  // Create state.
  await toggle_swaps(
    provider,
    wallet,
    args.coinType,
    args.enableSwaps == "true"
  );
}

main();
