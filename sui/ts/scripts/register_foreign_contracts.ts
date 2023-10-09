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
import {executeTransactionBlock, pollTransactionForEffectsCert} from "./poll";
import {getTableByName} from "../src";
import * as fs from "fs";

function validateContractAddress(address: string) {
  if (address.length != 64 || address.substring(0, 2) == "0x") {
    throw Error("Invalid contract address");
  }
}

/**
 * Registers a foreign Token Bridge Relayer contract on the SUI contract.
 */
async function register_foreign_contracts(
  provider: JsonRpcProvider,
  wallet: RawSigner,
  config: Config[]
) {
  // Fetch the current registered contracts table.
  const currentRegisteredContracts = await getTableByName(
    provider,
    RELAYER_STATE_ID,
    "foreign_contracts"
  );
  const registrationsDictionary: Record<string, string | undefined> = {};
  for (const [chain, value] of currentRegisteredContracts) {
    const contract = Buffer.from(value.fields.value.fields.data).toString("hex");
    registrationsDictionary[chain] = contract;
  }

  const tx = new TransactionBlock();
  // Register each contract address.
  for (const contractMap of config) {
    validateContractAddress(contractMap.address);

    const currentRegistration = registrationsDictionary[contractMap.chain];
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

  const {digest} = await executeTransactionBlock(wallet, tx);
  await pollTransactionForEffectsCert(wallet, digest);

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
interface Config {
  chain: string;
  address: string;
}

function createConfig(object: any) {
  let config = [] as Config[];

  for (let key of Object.keys(object)) {
    let member = {chain: key, address: object[key]};
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
  const config = createConfig(deploymentConfig["deployedContracts"]);

  if (config.length == undefined) {
    throw Error("Deployed contracts not found");
  }

  // Register all contracts.
  await register_foreign_contracts(provider, wallet, config);
}

main();
