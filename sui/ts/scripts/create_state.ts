import {
  SuiClient, getFullnodeUrl,
} from "@mysten/sui.js/client";
import {
  TransactionBlock,
} from "@mysten/sui.js/transactions";
import {
  Ed25519Keypair,
} from "@mysten/sui.js/keypairs/ed25519";
import {
  RELAYER_ID,
  WORMHOLE_STATE_ID,
  RELAYER_OWNER_CAP_ID,
  RELAYER_UPGRADE_CAP_ID,
  KEY,
} from "./consts";
import {executeTransactionBlock, pollTransactionForEffectsCert} from "./poll";
import { createParser } from "./cli_args";

export async function getArgs() {
  const argv = await createParser().argv;

  return {
    network: argv.network as "mainnet" | "testnet",
  };
}

/**
 * Creates the state object for the specified Token Bridge Relayer contract.
 */
async function create_state(client: SuiClient, wallet: Ed25519Keypair) {
  // Call `owner::create_state` on the Token Bridge Relayer.
  const tx = new TransactionBlock();

  tx.moveCall({
    target: `${RELAYER_ID}::owner::create_state`,
    arguments: [
      tx.object(WORMHOLE_STATE_ID),
      tx.object(RELAYER_OWNER_CAP_ID),
      tx.object(RELAYER_UPGRADE_CAP_ID),
    ],
  });
  const {digest, objectChanges} = await executeTransactionBlock(client, wallet, tx);
  // Log the state ID.
  await pollTransactionForEffectsCert(client, digest);

  for (const objectEvent of objectChanges!) {
    if (
      objectEvent["type"] == "created" &&
      objectEvent["objectType"].includes("state::State")
    ) {
      console.log(`State created at id: ${objectEvent["objectId"]}`);
    }
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

  await create_state(client, wallet);
}

main();
