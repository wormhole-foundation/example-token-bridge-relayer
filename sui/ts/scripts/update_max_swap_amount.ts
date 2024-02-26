import {
  Ed25519Keypair,
} from "@mysten/sui.js/keypairs/ed25519";
import {
  SuiClient, getFullnodeUrl,
} from "@mysten/sui.js/client";
import {
  TransactionBlock,
} from "@mysten/sui.js/transactions";

import { getTokenInfo, getRelayerState } from "../src";

import {
  RELAYER_ID,
  RELAYER_STATE_ID,
  RELAYER_OWNER_CAP_ID,
  KEY,
} from "./consts";
import {executeTransactionBlock, pollTransactionForEffectsCert} from "./poll";
import { createParser } from "./cli_args";

export async function getArgs() {
  const argv = await createParser().options({
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
      network: argv.network as "mainnet" | "testnet",
    };
  } else {
    throw Error("Invalid arguments");
  }
}

/**
 * Updates the max native swap amount for the specified coin type.
 */
async function update_max_native_swap_amount(
  client: SuiClient,
  wallet: Ed25519Keypair,
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
  const {digest} = await executeTransactionBlock(client, wallet, tx);
  await pollTransactionForEffectsCert(client, digest);

  // Fetch state.
  const state = await getRelayerState(client, RELAYER_STATE_ID);

  // Verify state.
  const tokenInfo = await getTokenInfo(client, state, coinType);
  const coinName = coinType.split("::", 3)[2];

  console.log(
    `Max native swap amount updated to ${tokenInfo.value.fields.max_native_swap_amount} for ${coinName}.`
  );
}

async function main() {
  const args = await getArgs();

  const client = new SuiClient({
    url: getFullnodeUrl(args.network)
  });

  const wallet = Ed25519Keypair.fromSecretKey(
    Buffer.from(KEY, "base64")
  );

  await update_max_native_swap_amount(
    client,
    wallet,
    args.coinType,
    args.maxSwapAmount
  );
}

main();
