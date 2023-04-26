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
import {getTokenInfo, getObjectFields} from "../src";
import * as fs from "fs";

/**
 * Register token.
 */
async function register_token(
  provider: JsonRpcProvider,
  wallet: RawSigner,
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
  const result = await wallet.signAndExecuteTransactionBlock({
    transactionBlock: tx,
  });

  if (result.digest === null) {
    return Promise.reject("Failed to register the token.");
  }

  console.log(`Transaction digest: ${result.digest}`);

  // Fetch state.
  const state = await getObjectFields(provider, RELAYER_STATE_ID);

  for (const tokenConfig of config) {
    // Verify state.
    const tokenInfo = await getTokenInfo(provider, state, tokenConfig.coinType);
    const coinName = tokenConfig.coinType.split("::", 3)[2];

    console.log(`${coinName} has been registered.`);
    console.log(`swapRate: ${tokenInfo.swap_rate}`);
    console.log(`maxSwapAmount: ${tokenInfo.max_native_swap_amount}`);
    console.log(`swapEnabled: ${tokenInfo.swap_enabled}`);
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
  let config = [] as TokenConfig[];

  for (const info of object) {
    let member: TokenConfig = {
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
  const config = createConfig(deploymentConfig["acceptedTokensList"]);

  if (config.length == undefined) {
    throw Error("Deployed contracts not found");
  }

  // Create state.
  await register_token(provider, wallet, config);
}

main();
