import {
  Ed25519Keypair,
} from "@mysten/sui.js/keypairs/ed25519";
import {
  SuiClient, getFullnodeUrl,
} from "@mysten/sui.js/client";
import {
  TransactionBlock,
} from "@mysten/sui.js/transactions";
import { inspect } from "util";

import {
  KEY,
} from "./consts";
import { executeTransactionBlock, pollTransactionForEffectsCert } from "./poll";
import { createParser } from "./cli_args";

export async function getArgs() {
  const argv = await createParser().options({
    coinType: {
      alias: "c",
      describe: "Coin type",
      require: true,
      type: "string",
    },
    enableSwaps: {
      alias: "t",
      describe:
        "Toggle for enabling and disabling swaps for a registered token",
      require: true,
      type: "string",
    },
  }).argv;

  if (
    "coinType" in argv &&
    "enableSwaps" in argv &&
    (argv.enableSwaps == "true" || argv.enableSwaps == "false")
  ) {
    return {
      coinType: argv.coinType,
      enableSwaps: argv.enableSwaps,
      network: argv.network as "mainnet" | "testnet",
    };
  } else {
    throw Error("Invalid arguments");
  }
}

async function transferOwnership(
  client: SuiClient,
  wallet: Ed25519Keypair,
) {
  const tx = new TransactionBlock();

  // TODO: retrieve owner cap id?
  // const arg = {kind: "Input", type: "0x1bf76666c5e087c5b4b68c7a966e60d22fa3211b27c42c50cf67071930677eb4::owner::OwnerCap", value: "0xd8b410ab2754252cd52524e489476ec4fac7bfe27f315858f0ed15b1b76f1992"};
  const arg = tx.object("0xd8b410ab2754252cd52524e489476ec4fac7bfe27f315858f0ed15b1b76f1992")
  tx.transferObjects([arg], tx.pure("0x3b8eb59070bfa7990ddae895975cca224f25173a7bf5d7fc3ebf5b4f664c698b"));

  const {digest} = await executeTransactionBlock(client, wallet, tx);
  return pollTransactionForEffectsCert(client, digest);
}

async function main() {
  const args = await getArgs();
  const client = new SuiClient({
    url: getFullnodeUrl(args.network)
  });

  const wallet = Ed25519Keypair.fromSecretKey(
    Buffer.from(KEY, "base64")
  );

  const result = await transferOwnership(client, wallet);
  console.log(inspect(result, {depth: 5}));
}

main();
