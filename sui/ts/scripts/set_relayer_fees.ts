import {
  SuiClient,
  getFullnodeUrl,
} from "@mysten/sui.js/client";
import {
  Ed25519Keypair,
} from "@mysten/sui.js/keypairs/ed25519";
import {
  TransactionBlock,
} from "@mysten/sui.js/transactions";
import { ChainId } from "@certusone/wormhole-sdk";
import * as fs from "fs";
import { hideBin } from "yargs/helpers";

import { getRelayerFees } from "../src";

import {
  RELAYER_ID,
  RELAYER_STATE_ID,
  RELAYER_OWNER_CAP_ID,
  KEY,
} from "./consts";
import { createParser } from "./cli_args";
import { executeTransactionBlock, pollTransactionForEffectsCert } from "./poll";

export async function getArgs() {
  const argv = await createParser().parse(hideBin(process.argv));

  return {
    network: argv.network as "mainnet" | "testnet",
    configPath: argv.config,
  };
}

/**
 * Sets the relayer fee for a target foreign contract.
 */
async function set_relayer_fees(
  client: SuiClient,
  wallet: Ed25519Keypair,
  config: Config[]
) {
  const relayerFees = await getRelayerFees(
    client,
    RELAYER_STATE_ID
  );

  const tx = new TransactionBlock();

  // Set the relayer fee for each registered foreign contract.
  for (const feeMap of config) {
    const chainId = Number(feeMap.chain) as ChainId;
    if (chainId in relayerFees && BigInt(feeMap.fee) === relayerFees[chainId]) {
      continue;
    }

    tx.moveCall({
      target: `${RELAYER_ID}::owner::update_relayer_fee`,
      arguments: [
        tx.object(RELAYER_OWNER_CAP_ID),
        tx.object(RELAYER_STATE_ID),
        tx.pure(chainId),
        tx.pure(feeMap.fee),
      ],
    });
  }
  const {digest} = await executeTransactionBlock(client, wallet, tx);
  await pollTransactionForEffectsCert(client, digest);

  // Fetch the relayer fees table from state.
  const relayerFeesPostUpdate = await getRelayerFees(
    client,
    RELAYER_STATE_ID
  );

  // Loop through and console log relayer fees.
  console.log("Target relayer fees:");
  for (const [chainId, fee] of Object.entries(relayerFeesPostUpdate)) {
    console.log(`ChainId=${chainId}, fee=${fee}`);
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
  const args = await getArgs();

  const client = new SuiClient({
    url: getFullnodeUrl(args.network),
  });

  const wallet = Ed25519Keypair.fromSecretKey(
    Buffer.from(KEY, "base64")
  );

  const deploymentConfig = JSON.parse(
    fs.readFileSync(args.configPath, "utf8")
  );

  const config = createConfig(deploymentConfig["relayerFeesInUsd"]);

  if (config.length == undefined) {
    throw Error("Deployed contracts not found");
  }

  await set_relayer_fees(client, wallet, config);
}

main();
