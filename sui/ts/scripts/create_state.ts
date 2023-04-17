import {
  Ed25519Keypair,
  JsonRpcProvider,
  RawSigner,
  Connection,
  TransactionBlock,
} from "@mysten/sui.js";
import {
  RELAYER_ID,
  WORMHOLE_STATE_ID,
  RELAYER_OWNER_CAP_ID,
  RPC,
} from "./consts";
import yargs from "yargs";

export function getArgs() {
  const argv = yargs.options({
    key: {
      alias: "k",
      describe: "Custom private key to sign txs",
      required: true,
      type: "string",
    },
  }).argv;

  if ("key" in argv) {
    return {key: argv.key, rpc: RPC};
  } else {
    throw Error("Invalid arguments");
  }
}

/**
 * Creates the state object for the specified Token Bridge Relayer contract.
 */
async function create_state(wallet: RawSigner) {
  // Call `owner::create_state` on the Token Bridge Relayer.
  const tx = new TransactionBlock();
  tx.moveCall({
    target: `${RELAYER_ID}::owner::create_state`,
    arguments: [tx.object(WORMHOLE_STATE_ID), tx.object(RELAYER_OWNER_CAP_ID)],
  });
  const result = await wallet.signAndExecuteTransactionBlock({
    transactionBlock: tx,
    options: {showObjectChanges: true},
  });

  if (result.digest === null) {
    return Promise.reject("Failed to create state.");
  }

  // Log the state ID.
  for (const objectEvent of result.objectChanges!) {
    if (
      objectEvent["type"] == "created" &&
      objectEvent["objectType"].includes("state::State")
    ) {
      console.log(`State created at id: ${objectEvent["objectId"]}`);
    }
  }
}

async function main() {
  // Fetch args.
  const args = getArgs();

  // Set up provider.
  const connection = new Connection({fullnode: args.rpc});
  const provider = new JsonRpcProvider(connection);

  // Owner wallet.
  const key = Ed25519Keypair.fromSecretKey(
    Buffer.from(args.key, "base64").subarray(1)
  );
  const wallet = new RawSigner(key, provider);

  // Create state.
  await create_state(wallet);
}

main();
