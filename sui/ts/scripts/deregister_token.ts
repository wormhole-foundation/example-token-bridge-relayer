import {
  SuiClient, getFullnodeUrl,
} from "@mysten/sui.js/client";
import {
  Ed25519Keypair,
} from "@mysten/sui.js/keypairs/ed25519";
import {
  TransactionBlock,
} from "@mysten/sui.js/transactions";

import { getRelayerState, getDynamicFieldsByType } from "../src";

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
      describe: "Coin type to deregister",
      require: true,
      type: "string",
    },
  }).argv;

  if ("coinType" in argv) {
    return {
      coinType: argv.coinType,
      network: argv.network as "mainnet" | "testnet",
    };
  } else {
    throw Error("Invalid arguments");
  }
}

/**
 * Deregister token.
 */
async function deregister_token(
  client: SuiClient,
  wallet: Ed25519Keypair,
  coinType: string
) {
  // Deregister the token.
  const tx = new TransactionBlock();
  tx.moveCall({
    target: `${RELAYER_ID}::owner::deregister_token`,
    arguments: [tx.object(RELAYER_OWNER_CAP_ID), tx.object(RELAYER_STATE_ID)],
    typeArguments: [coinType],
  });
  const {digest} = await executeTransactionBlock(client, wallet, tx);
  await pollTransactionForEffectsCert(client, digest);

  // Fetch state.
  const state = await getRelayerState(client, RELAYER_STATE_ID);

  // Check to see if the coin type is deregistered by checking if
  // the dynamic field still exists.
  const registeredCoinField = await getDynamicFieldsByType(
    client,
    state.registered_tokens.fields.id.id,
    coinType
  );

  if (registeredCoinField.length == 0) {
    console.log(`${coinType.split("::", 3)[2]} has been deregistered.`);
  } else {
    console.log("Failed to deregister the token.");
  }
}

async function main() {
  const args = await getArgs();

  const client = new SuiClient({
    url: getFullnodeUrl(args.network)
  });

  const wallet = Ed25519Keypair.fromSecretKey(
    Buffer.from(KEY, "base64")
  );

  await deregister_token(client, wallet, args.coinType);
}

main();
