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
  // RPC and Key
  const argv = yargs.options({
    key: {
      alias: "k",
      describe: "Custom private key to sign txs",
      required: true,
      type: "string",
    },
    chain: {
      alias: "c",
      describe: "Wormhole chain ID of foreign contract",
      require: true,
      type: "string",
    },
    addr: {
      alias: "a",
      describe: "Foreign contract address to register",
      require: true,
      type: "string",
    },
  }).argv;

  if ("key" in argv && "chain" in argv && "addr" in argv) {
    return {key: argv.key, chain: argv.chain, addr: argv.addr};
  } else {
    throw Error("Invalid arguments");
  }
}

/**
 * Registers a foreign Token Bridge Relayer contract on the SUI contract.
 */
async function register_foreign_contract(
  provider: JsonRpcProvider,
  wallet: RawSigner,
  chainId: string,
  contractAddress: string
) {
  if (contractAddress.length != 66 || contractAddress.substring(0, 2) != "0x") {
    return Promise.reject("Invalid contract address");
  }

  // Register the foreign contract.
  const tx = new TransactionBlock();
  tx.moveCall({
    target: `${RELAYER_ID}::owner::register_foreign_contract`,
    arguments: [
      tx.object(RELAYER_OWNER_CAP_ID),
      tx.object(RELAYER_STATE_ID),
      tx.pure(chainId),
      tx.pure(contractAddress),
    ],
  });
  const result = await wallet.signAndExecuteTransactionBlock({
    transactionBlock: tx,
  });

  if (result.digest === null) {
    return Promise.reject("Failed to register contract.");
  }

  // Fetch the registered contracts table.
  const registeredContracts = await getTableByName(
    provider,
    RELAYER_STATE_ID,
    "foreign_contracts"
  );

  // Loop through and console log registered contracts.
  console.log("Registered contracts list:");
  for (const mapping of registeredContracts) {
    const contract = Buffer.from(mapping[1].fields.value.fields.data).toString(
      "hex"
    );
    console.log(`ChainId=${mapping[0]}, contract=0x${contract}`);
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
  await register_foreign_contract(provider, wallet, args.chain, args.addr);
}

main();
