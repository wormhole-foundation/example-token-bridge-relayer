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
import { executeTransactionBlock, pollTransactionForEffectsCert } from "./poll";
import { createParser } from "./cli_args";

export async function getArgs() {
  const argv = await createParser().options({
    coinType: {
      alias: "c",
      describe: "Coin type",
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

  if ("coinType" in argv && "swapRate" in argv) {
    return {
      coinType: argv.coinType,
      swapRate: argv.swapRate,
      network: argv.network as "mainnet" | "testnet",
    };
  } else {
    throw Error("Invalid arguments");
  }
}

/**
 * Updates the swap rate for the specified coin type.
 */
async function update_swap_rate(
  client: SuiClient,
  wallet: Ed25519Keypair,
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
  const {digest} = await executeTransactionBlock(client, wallet, tx);
  await pollTransactionForEffectsCert(client, digest);

  const state = await getRelayerState(client, RELAYER_STATE_ID);

  const tokenInfo = await getTokenInfo(client, state, coinType);
  const coinName = coinType.split("::", 3)[2];

  console.log(`Swap rate updated to ${tokenInfo.value.fields.swap_rate} for ${coinName}.`);
}

async function main() {
  const args = await getArgs();

  const client = new SuiClient({
    url: getFullnodeUrl(args.network),
  });

  const wallet = Ed25519Keypair.fromSecretKey(
    Buffer.from(KEY, "base64")
  );

  await update_swap_rate(client, wallet, args.coinType, args.swapRate);
}

main();
