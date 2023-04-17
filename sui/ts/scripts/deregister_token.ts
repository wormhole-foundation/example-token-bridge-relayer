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
import {getDynamicFieldsByType, getObjectFields} from "../src";
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
      describe: "Coin type to deregister",
      require: true,
      type: "string",
    },
  }).argv;

  if ("key" in argv && "coinType" in argv) {
    return {
      key: argv.key,
      coinType: argv.coinType,
    };
  } else {
    throw Error("Invalid arguments");
  }
}

/**
 * Deregister token.
 */
async function deregister_token(
  provider: JsonRpcProvider,
  wallet: RawSigner,
  coinType: string
) {
  // Deregister the token.
  const tx = new TransactionBlock();
  tx.moveCall({
    target: `${RELAYER_ID}::owner::deregister_token`,
    arguments: [tx.object(RELAYER_OWNER_CAP_ID), tx.object(RELAYER_STATE_ID)],
    typeArguments: [coinType],
  });
  const result = await wallet.signAndExecuteTransactionBlock({
    transactionBlock: tx,
  });

  if (result.digest === null) {
    return Promise.reject("Failed to deregister the token.");
  }

  // Fetch state.
  const state = await getObjectFields(provider, RELAYER_STATE_ID);

  // Check to see if the coin type is deregistered by checking if
  // the dynamic field still exists.
  const registeredCoinField = await getDynamicFieldsByType(
    provider,
    state!.registered_tokens.fields.id.id,
    coinType
  );

  if (registeredCoinField.length == 0) {
    console.log(`${coinType.split("::", 3)[2]} has been deregistered.`);
  } else {
    console.log("Failed to deregister the token.");
  }
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
  await deregister_token(provider, wallet, args.coinType);
}

main();
