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
import {getTableByName} from "../src";
import yargs from "yargs";

export function getArgs() {
  const argv = yargs.options({
    key: {
      alias: "k",
      describe: "Custom private key to sign txs",
      required: true,
      type: "string",
    },
    chain: {
      alias: "c",
      describe: "Wormhole chain ID of the target contract",
      require: true,
      type: "string",
    },
    fee: {
      alias: "f",
      describe: "Relayer fee denominated in US dollars",
      require: true,
      type: "string",
    },
  }).argv;

  if ("key" in argv && "chain" in argv && "fee" in argv) {
    return {key: argv.key, chain: argv.chain, fee: argv.fee};
  } else {
    throw Error("Invalid arguments");
  }
}

/**
 * Sets the relayer fee for a target foreign contract.
 */
async function set_relayer_fee(
  provider: JsonRpcProvider,
  wallet: RawSigner,
  chainId: string,
  relayerFee: string
) {
  // Set the relayer fee for the registered foreign contract.
  const tx = new TransactionBlock();
  tx.moveCall({
    target: `${RELAYER_ID}::owner::update_relayer_fee`,
    arguments: [
      tx.object(RELAYER_OWNER_CAP_ID),
      tx.object(RELAYER_STATE_ID),
      tx.pure(chainId),
      tx.pure(relayerFee),
    ],
  });
  const result = await wallet.signAndExecuteTransactionBlock({
    transactionBlock: tx,
  });

  if (result.digest === null) {
    return Promise.reject("Failed to set the relayer fee.");
  }

  // Fetch the relayer fees table from state.
  const relayerFees = await getTableByName(
    provider,
    RELAYER_STATE_ID,
    "relayer_fees"
  );

  // Loop through and console log relayer fees.
  console.log("Target relayer fees:");
  for (const mapping of relayerFees) {
    console.log(`ChainId=${mapping[0]}, fee=${mapping[1]}`);
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
  await set_relayer_fee(provider, wallet, args.chain, args.fee);
}

main();
