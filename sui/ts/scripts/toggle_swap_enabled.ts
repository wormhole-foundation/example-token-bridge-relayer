import {
  Ed25519Keypair,
} from "@mysten/sui.js/keypairs/ed25519";
import {
  SuiClient, getFullnodeUrl,
} from "@mysten/sui.js/client";
import {
  TransactionBlock,
} from "@mysten/sui.js/transactions";

import {getTokenInfo, getObjectFields, getRelayerState} from "../src";

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
      network: argv.network as "mainnet" | "testnet",
    };
  } else {
    throw Error("Invalid arguments");
  }
}

/**
 * Toggles if swaps are enabled for the specified coin type.
 */
async function toggle_swaps(
  client: SuiClient,
  wallet: Ed25519Keypair,
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
  const {digest} = await executeTransactionBlock(client, wallet, tx);
  await pollTransactionForEffectsCert(client, digest);

  const state = await getRelayerState(client, RELAYER_STATE_ID);

  // Verify state.
  const tokenInfo = await getTokenInfo(client, state, coinType);
  const coinName = coinType.split("::", 3)[2];

  console.log(`Swaps are enabled=${tokenInfo.value.fields.swap_enabled} for ${coinName}.`);
}

async function main() {
  const args = await getArgs();

  const client = new SuiClient({
    url: getFullnodeUrl(args.network),
  });

  const wallet = Ed25519Keypair.fromSecretKey(
    Buffer.from(KEY, "base64")
  );

  await toggle_swaps(
    client,
    wallet,
    args.coinType,
    args.enableSwaps == "true"
  );
}

main();
