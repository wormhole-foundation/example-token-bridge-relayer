import {
  Ed25519Keypair,
} from "@mysten/sui.js/keypairs/ed25519";
import {
  TransactionBlock,
} from "@mysten/sui.js/transactions";
import {
  SuiClient, getFullnodeUrl,
} from "@mysten/sui.js/client";

import {KEY} from "./consts";
import {executeTransactionBlock, pollTransactionForEffectsCert} from "./poll";
import { createParser } from "./cli_args";

export async function getArgs() {
  const argv = await createParser().options({
    coinType: {
      alias: "c",
      describe: "Coin type to mint",
      require: true,
      type: "string",
    },
    treasuryId: {
      alias: "t",
      describe: "Treasury cap Id",
      require: true,
      type: "string",
    },
    amount: {
      alias: "a",
      describe: "Amount to mint",
      require: true,
      type: "string",
    },
  }).argv;

  if ("coinType" in argv && "amount" in argv && "treasuryId" in argv) {
    return {
      coinType: argv.coinType,
      amount: argv.amount,
      treauryId: argv.treasuryId,
      network: argv.network as "mainnet" | "testnet",
    };
  } else {
    throw Error("Invalid arguments");
  }
}

/**
 * Mint specified token.
 */
async function mint_token(
  client: SuiClient,
  wallet: Ed25519Keypair,
  coinType: string,
  treasuryId: string,
  amount: string
) {
  const tx = new TransactionBlock();
  tx.moveCall({
    target: "0x2::coin::mint_and_transfer",
    arguments: [tx.object(treasuryId), tx.pure(amount), tx.pure(wallet.toSuiAddress())],
    typeArguments: [coinType],
  });
  const {digest} = await executeTransactionBlock(client, wallet, tx);
  await pollTransactionForEffectsCert(client, digest);
}

async function main() {
  const args = await getArgs();

  const client = new SuiClient({
    url: getFullnodeUrl(args.network),
  });

  const wallet = Ed25519Keypair.fromSecretKey(
    Buffer.from(KEY, "base64")
  );

  await mint_token(
    client,
    wallet,
    args.coinType,
    args.treauryId,
    args.amount
  );
}

main();
