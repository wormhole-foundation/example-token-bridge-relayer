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
import * as fs from "fs";
import { hideBin } from "yargs/helpers";

import { getTokenInfo, getRelayerState } from "../src";

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
 * Register token.
 */
async function register_tokens(
  client: SuiClient,
  wallet: Ed25519Keypair,
  config: TokenConfig[]
) {
  const tx = new TransactionBlock();

  // Register each token.
  for (const tokenConfig of config) {
    tx.moveCall({
      target: `${RELAYER_ID}::owner::register_token`,
      arguments: [
        tx.object(RELAYER_OWNER_CAP_ID),
        tx.object(RELAYER_STATE_ID),
        tx.pure(tokenConfig.swapRate),
        tx.pure(tokenConfig.maxNativeSwapAmount),
        tx.pure(tokenConfig.enableSwaps),
      ],
      typeArguments: [tokenConfig.coinType],
    });
  }
  const {digest} = await executeTransactionBlock(client, wallet, tx);
  await pollTransactionForEffectsCert(client, digest);

  // Fetch state.
  const state = await getRelayerState(client, RELAYER_STATE_ID);

  for (const tokenConfig of config) {
    // Verify state.
    const tokenInfo = await getTokenInfo(client, state, tokenConfig.coinType);

    console.log(`${tokenConfig.symbol} has been registered.`);
    console.log(`swapRate: ${tokenInfo.value.fields.swap_rate}`);
    console.log(`maxSwapAmount: ${tokenInfo.value.fields.max_native_swap_amount}`);
    console.log(`swapEnabled: ${tokenInfo.value.fields.swap_enabled}`);
    console.log("\n");
  }
}

interface TokenConfig {
  symbol: string;
  coinType: string;
  swapRate: string;
  maxNativeSwapAmount: string;
  enableSwaps: boolean;
}

function createConfig(object: any) {
  const config = [] as TokenConfig[];

  for (const info of object) {
    const member: TokenConfig = {
      symbol: info.symbol as string,
      coinType: info.coinType as string,
      swapRate: info.swapRate as string,
      maxNativeSwapAmount: info.maxNativeSwapAmount as string,
      enableSwaps: info.enableSwaps,
    };

    config.push(member);
  }

  return config;
}

async function main() {
  const {configPath, network} = await getArgs();
  const client = new SuiClient({
    url: getFullnodeUrl(network),
  });

  const wallet = Ed25519Keypair.fromSecretKey(
    Buffer.from(KEY, "base64")
  );

  const deploymentConfig = JSON.parse(
    fs.readFileSync(configPath, "utf8")
  );
  const config = createConfig(deploymentConfig.acceptedTokensList);

  // TODO: parse and ensure config is correct
  if (config.length == undefined) {
    throw Error("Deployed contracts not found");
  }

  await register_tokens(client, wallet, config);
}

main();
