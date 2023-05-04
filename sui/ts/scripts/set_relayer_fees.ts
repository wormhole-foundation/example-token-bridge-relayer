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
import {getTableByName} from "../src";
import {executeTransactionBlock, pollTransactionForEffectsCert} from "./poll";
import * as fs from "fs";

/**
 * Sets the relayer fee for a target foreign contract.
 */
async function set_relayer_fees(
  provider: JsonRpcProvider,
  wallet: RawSigner,
  config: Config[]
) {
  const tx = new TransactionBlock();

  // Set the relayer fee for each registered foreign contract.
  for (const feeMap of config) {
    tx.moveCall({
      target: `${RELAYER_ID}::owner::update_relayer_fee`,
      arguments: [
        tx.object(RELAYER_OWNER_CAP_ID),
        tx.object(RELAYER_STATE_ID),
        tx.pure(feeMap.chain),
        tx.pure(feeMap.fee),
      ],
    });
  }
  const {digest} = await executeTransactionBlock(wallet, tx);
  await pollTransactionForEffectsCert(wallet, digest);

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

interface Config {
  chain: string;
  fee: string;
}

function createConfig(object: any) {
  let config = [] as Config[];

  for (let key of Object.keys(object)) {
    let member = {chain: key, fee: object[key]};
    config.push(member);
  }

  return config;
}

async function main() {
  // Set up provider.
  const connection = new Connection({fullnode: RPC});
  const provider = new JsonRpcProvider(connection);

  // Owner wallet.
  const key = Ed25519Keypair.fromSecretKey(
    Buffer.from(KEY, "base64").subarray(1)
  );
  const wallet = new RawSigner(key, provider);

  // Read in config file.
  const deploymentConfig = JSON.parse(
    fs.readFileSync(`${__dirname}/../../cfg/deploymentConfig.json`, "utf8")
  );

  // Convert to Config type.
  const config = createConfig(deploymentConfig["relayerFeesInUsd"]);

  if (config.length == undefined) {
    throw Error("Deployed contracts not found");
  }

  // Create state.
  await set_relayer_fees(provider, wallet, config);
}

main();
