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
import {
  RELAYER_ID,
  RELAYER_STATE_ID,
  RELAYER_OWNER_CAP_ID,
  KEY,
} from "./consts";
import {getTokenInfo, getRelayerState} from "../src/utils2";
import {executeTransactionBlock, pollTransactionForEffectsCert} from "./poll";
import * as fs from "fs";
import { hideBin } from "yargs/helpers";

import { createParser } from "./cli_args";

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
  provider: SuiClient,
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
  const {digest} = await executeTransactionBlock(wallet, tx);
  await pollTransactionForEffectsCert(wallet, digest);

  // Fetch state.
  const state = await getRelayerState(provider, RELAYER_STATE_ID);

  for (const tokenConfig of config) {
    // Verify state.
    const tokenInfo = await getTokenInfo(provider, state, tokenConfig.coinType);

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
  // Set up provider.
  const provider = new SuiClient({
    url: getFullnodeUrl(network),
  });

  // Owner wallet.
  const wallet = Ed25519Keypair.fromSecretKey(
    Buffer.from(KEY, "base64")
  );

  // Read in config file.
  const deploymentConfig = JSON.parse(
    fs.readFileSync(configPath, "utf8")
  );

  // Convert to Config type.
  const config = createConfig(deploymentConfig.acceptedTokensList);

  if (config.length == undefined) {
    throw Error("Deployed contracts not found");
  }

  // Create state.
  await register_tokens(provider, wallet, config);
}

main();
