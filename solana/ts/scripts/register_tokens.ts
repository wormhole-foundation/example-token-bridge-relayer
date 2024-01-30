import {Keypair, Connection, PublicKey} from "@solana/web3.js";
import {BN} from "@coral-xyz/anchor";
import * as tokenBridgeRelayer from "../sdk/";
import {RPC, TOKEN_BRIDGE_RELAYER_PID} from "./helpers/consts";
import {sendAndConfirmIx} from "./helpers/utils";
import yargs from "yargs";
import * as fs from "fs";

export function getArgs() {
  const argv = yargs.options({
    keyPair: {
      alias: "k",
      describe: "Signer Keypair",
      require: true,
      string: true,
    },
    network: {
      alias: "n",
      describe: "Network",
      require: true,
      string: true,
    },
    config: {
      alias: "c",
      string: true,
      boolean: false,
      description: "Configuration filepath.",
      required: true,
    }
  }).argv;

  if ("keyPair" in argv && "network" in argv) {
    const network = argv.network;
    if (network !== "mainnet" && network !== "testnet") {
      throw Error("Invalid network");
    }
    return {
      keyPair: JSON.parse(fs.readFileSync(argv.keyPair, "utf8")),
      network: network,
      configPath: argv.config ?? `${__dirname}/../../cfg/${network}Config.json`,
    };
  } else {
    throw Error("Invalid arguments");
  }
}

async function register_tokens(
  connection: Connection,
  payer: Keypair,
  tokens: TokenConfig[]
) {
  for (const tokenConfig of tokens) {
    // Create registration transaction.
    const registerTokenIx =
      await tokenBridgeRelayer.createRegisterTokenInstruction(
        connection,
        TOKEN_BRIDGE_RELAYER_PID,
        payer.publicKey,
        new PublicKey(tokenConfig.mint),
        new BN(tokenConfig.swapRate),
        new BN(tokenConfig.maxNativeSwapAmount)
      );

    console.log("\n", tokenConfig);

    // Send the transaction.
    const tx = await sendAndConfirmIx(connection, registerTokenIx, payer);
    if (tx === undefined) {
      console.log("Transaction failed");
    } else {
      console.log("Transaction successful:", tx);
    }
  }
}

interface TokenConfig {
  symbol: string;
  mint: string;
  swapRate: string;
  maxNativeSwapAmount: string;
}

function createConfig(object: any) {
  let config = [] as TokenConfig[];

  for (const info of object) {
    let member: TokenConfig = {
      symbol: info.symbol as string,
      mint: info.mint as string,
      swapRate: info.swapRate as string,
      maxNativeSwapAmount: info.maxNativeSwapAmount as string,
    };

    config.push(member);
  }

  return config;
}

async function main() {
  // Set up provider.
  const connection = new Connection(RPC, "confirmed");

  // Owner wallet.
  const {keyPair, network, configPath} = getArgs();
  const payer = Keypair.fromSecretKey(Uint8Array.from(keyPair));

  // Read in config file.
  const deploymentConfig = JSON.parse(
    fs.readFileSync(configPath, "utf8")
  );

  // Convert to Config type.
  const config = createConfig(deploymentConfig["acceptedTokensList"]);
  if (config.length == undefined) {
    throw Error("Tokens list not found");
  }

  // Register tokens.
  await register_tokens(connection, payer, config);
}

main();
