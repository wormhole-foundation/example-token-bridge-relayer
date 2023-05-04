import {
  Ed25519Keypair,
  JsonRpcProvider,
  RawSigner,
  Connection,
  TransactionBlock,
} from "@mysten/sui.js";
import {RPC, KEY} from "./consts";
import {executeTransactionBlock, pollTransactionForEffectsCert} from "./poll";
import yargs from "yargs";

export function getArgs() {
  const argv = yargs.options({
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
    };
  } else {
    throw Error("Invalid arguments");
  }
}

/**
 * Mint specified token.
 */
async function mint_token(
  wallet: RawSigner,
  walletAddress: string,
  coinType: string,
  treasuryId: string,
  amount: string
) {
  // Deregister the token.
  const tx = new TransactionBlock();
  tx.moveCall({
    target: "0x2::coin::mint_and_transfer",
    arguments: [tx.object(treasuryId), tx.pure(amount), tx.pure(walletAddress)],
    typeArguments: [coinType],
  });
  const {digest} = await executeTransactionBlock(wallet, tx);
  await pollTransactionForEffectsCert(wallet, digest);
}

async function main() {
  // Fetch args.
  const args = getArgs();

  // Set up provider.
  const connection = new Connection({fullnode: RPC});
  const provider = new JsonRpcProvider(connection);

  // Owner wallet.
  const key = Ed25519Keypair.fromSecretKey(
    Buffer.from(KEY, "base64").subarray(1)
  );
  const wallet = new RawSigner(key, provider);

  // Create state.
  await mint_token(
    wallet,
    await wallet.getAddress(),
    args.coinType,
    args.treauryId,
    args.amount
  );
}

main();
