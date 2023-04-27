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
import {executeTransactionBlock, pollTransactionForEffectsCert} from "./poll";
import yargs from "yargs";

export function getArgs() {
  const argv = yargs.options({
    coinType: {
      alias: "c",
      describe: "Coin type",
      require: true,
      type: "string",
    },
    maxSwapAmount: {
      alias: "m",
      describe: "Max native swap amount for the registered token",
      require: true,
      type: "string",
    },
  }).argv;

  if ("coinType" in argv && "maxSwapAmount" in argv) {
    return {
      coinType: argv.coinType,
      maxSwapAmount: argv.maxSwapAmount,
    };
  } else {
    throw Error("Invalid arguments");
  }
}

/**
 * Updates the max native swap amount for the specified coin type.
 */
async function update_max_native_swap_amount(
  provider: JsonRpcProvider,
  wallet: RawSigner,
  coinType: string,
  maxSwapAmount: string
) {
  // Update max native swap amount.
  const tx = new TransactionBlock();
  tx.moveCall({
    target: `${RELAYER_ID}::owner::update_max_native_swap_amount`,
    arguments: [
      tx.object(RELAYER_OWNER_CAP_ID),
      tx.object(RELAYER_STATE_ID),
      tx.pure(maxSwapAmount),
    ],
    typeArguments: [coinType],
  });
  const {digest} = await executeTransactionBlock(wallet, tx);
  await pollTransactionForEffectsCert(wallet, digest);

  // Fetch state.
  const state = await getObjectFields(provider, RELAYER_STATE_ID);

  // Verify state.
  const tokenInfo = await getTokenInfo(provider, state, coinType);
  const coinName = coinType.split("::", 3)[2];

  console.log(
    `Max native swap amount updated to ${tokenInfo.max_native_swap_amount} for ${coinName}.`
  );
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
  await update_max_native_swap_amount(
    provider,
    wallet,
    args.coinType,
    args.maxSwapAmount
  );
}

main();
