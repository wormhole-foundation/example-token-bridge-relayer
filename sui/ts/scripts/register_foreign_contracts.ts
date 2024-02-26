import {
  Ed25519Keypair,
} from "@mysten/sui.js/keypairs/ed25519";
import {
  TransactionBlock,
} from "@mysten/sui.js/transactions";
import {
  SuiClient, getFullnodeUrl,
} from "@mysten/sui.js/client";
import * as fs from "fs";

import { getRelayerRegistrations } from "../src";

import {
  RELAYER_ID,
  RELAYER_STATE_ID,
  RELAYER_OWNER_CAP_ID,
  KEY,
} from "./consts";
import {executeTransactionBlock, pollTransactionForEffectsCert} from "./poll";
import { createParser } from "./cli_args";
import { ChainId } from "@certusone/wormhole-sdk";

function validateContractAddress(address: string) {
  if (address.length != 64 || address.substring(0, 2) == "0x") {
    throw Error("Invalid contract address");
  }
}

export async function getArgs() {
  const argv = await createParser().argv;

  return {
    network: argv.network as "mainnet" | "testnet",
    config: argv.config,
  };
}

/**
 * Registers a foreign Token Bridge Relayer contract on the SUI contract.
 */
async function register_foreign_contracts(
  client: SuiClient,
  wallet: Ed25519Keypair,
  config: Config[]
) {
  // Fetch the current registered contracts table.
  const currentRegisteredContracts = await getRelayerRegistrations(
    client,
    RELAYER_STATE_ID
  );

  const tx = new TransactionBlock();
  // Register each contract address.
  for (const contractMap of config) {
    validateContractAddress(contractMap.address);
    const chainId = Number(contractMap.chain) as ChainId;

    const currentRegistration = currentRegisteredContracts[chainId];
    if (currentRegistration?.toLowerCase() === contractMap.address.toLowerCase()) {
      console.log(`Contract already registered for chainId=${contractMap.chain}`);
      continue;
    }

    // Do the registration.
    tx.moveCall({
      target: `${RELAYER_ID}::owner::register_foreign_contract`,
      arguments: [
        tx.object(RELAYER_OWNER_CAP_ID),
        tx.object(RELAYER_STATE_ID),
        tx.pure(contractMap.chain),
        tx.pure("0x" + contractMap.address),
      ],
    });
  }

  if (tx.blockData.transactions.length === 0) {
    return;
  }

  const {digest} = await executeTransactionBlock(client, wallet, tx);
  await pollTransactionForEffectsCert(client, digest);

  // Fetch the registered contracts table.
  const registeredContracts = await getRelayerRegistrations(
    client,
    RELAYER_STATE_ID
  );

  // Loop through and console log registered contracts.
  console.log("Registered contracts list:");
  for (const [chainId, contract] of Object.entries(registeredContracts)) {
    console.log(`ChainId=${chainId}, contract=0x${contract}`);
  }
}
interface Config {
  chain: string;
  address: string;
}

function createConfig(object: any) {
  const config = [] as Config[];

  for (const key of Object.keys(object)) {
    const member = {chain: key, address: object[key]};
    config.push(member);
  }

  return config;
}

async function main() {
  const args = await getArgs();

  const client = new SuiClient({
    url: getFullnodeUrl(args.network)
  });

  const wallet = Ed25519Keypair.fromSecretKey(
    Buffer.from(KEY, "base64")
  );

  // Read in config file.
  const deploymentConfig = JSON.parse(
    fs.readFileSync(args.config, "utf8")
  );

  // Convert to Config type.
  const config = createConfig(deploymentConfig["deployedContracts"]);

  if (config.length === 0) {
    throw Error("Deployed contracts not found");
  }

  // Register all contracts.
  await register_foreign_contracts(client, wallet, config);
}

main();
