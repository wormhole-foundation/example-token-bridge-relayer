import {
  Ed25519Keypair,
} from "@mysten/sui.js/keypairs/ed25519";
import {
  SuiClient, getFullnodeUrl,
} from "@mysten/sui.js/client";
import {
  TransactionBlock,
} from "@mysten/sui.js/transactions";
import {
  SUI_CLOCK_OBJECT_ID,
} from "@mysten/sui.js/utils";

import { getCoinWithHighestBalance } from "../src";

import {
  RELAYER_ID,
  RELAYER_STATE_ID,
  WORMHOLE_ID,
  WORMHOLE_STATE_ID,
  TOKEN_BRIDGE_ID,
  TOKEN_BRIDGE_STATE_ID,
  KEY,
  SUI_TYPE,
} from "./consts";
import { executeTransactionBlock, pollTransactionForEffectsCert } from "./poll";
import { createParser } from "./cli_args";

export async function getArgs() {
  const argv = await createParser().options({
    coinType: {
      alias: "c",
      describe: "Coin type to mint",
      require: true,
      type: "string",
    },
    amount: {
      alias: "a",
      describe: "Amount to mint",
      require: true,
      type: "string",
    },
    target: {
      alias: "t",
      describe: "Target chain ID",
      require: true,
      type: "string",
    },
    recipient: {
      alias: "r",
      describe: "Recipient wallet",
      rquire: true,
      type: "string",
    },
  }).argv;

  if (
    "coinType" in argv &&
    "target" in argv &&
    "amount" in argv &&
    "recipient" in argv
  ) {
    return {
      coinType: argv.coinType,
      target: argv.target,
      amount: argv.amount,
      recipient: argv.recipient,
      network: argv.network as "mainnet" | "testnet",
    };
  } else {
    throw Error("Invalid arguments");
  }
}

function validateAddress(address: string) {
  if (address.length != 64 || address.substring(0, 2) == "0x") {
    throw Error("Invalid contract address");
  }
}

/**
 * Performs outbound transfer.
 */
async function transfer_sui_with_relay(
  client: SuiClient,
  wallet: Ed25519Keypair,
  targetChain: string,
  recipient: string,
  amount: string
) {
  validateAddress(recipient);

  // Start new transaction.
  const tx = new TransactionBlock();

  // Split.
  const [wormholeFee, coinsToTransfer] = tx.splitCoins(tx.gas, [
    tx.pure(0),
    tx.pure(amount),
  ]);

  // Fetch the asset info.
  const [assetInfo] = tx.moveCall({
    target: `${TOKEN_BRIDGE_ID}::state::verified_asset`,
    arguments: [tx.object(TOKEN_BRIDGE_STATE_ID)],
    typeArguments: [SUI_TYPE],
  });

  // Fetch the transfer ticket.
  const [transferTicket] = tx.moveCall({
    target: `${RELAYER_ID}::transfer::transfer_tokens_with_relay`,
    arguments: [
      tx.object(RELAYER_STATE_ID),
      coinsToTransfer,
      assetInfo,
      tx.pure(0), // swap amount
      tx.pure(targetChain),
      tx.pure("0x" + recipient),
      tx.pure(0),
    ],
    typeArguments: [SUI_TYPE],
  });

  // Transfer the tokens with payload.
  const [messageTicket] = tx.moveCall({
    target: `${TOKEN_BRIDGE_ID}::transfer_tokens_with_payload::transfer_tokens_with_payload`,
    arguments: [tx.object(TOKEN_BRIDGE_STATE_ID), transferTicket],
    typeArguments: [SUI_TYPE],
  });

  // Publish the message.
  tx.moveCall({
    target: `${WORMHOLE_ID}::publish_message::publish_message`,
    arguments: [
      tx.object(WORMHOLE_STATE_ID),
      wormholeFee,
      messageTicket,
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const {digest, balanceChanges} = await executeTransactionBlock(client, wallet, tx);
  await pollTransactionForEffectsCert(client, digest);

  console.log(balanceChanges);
}

/**
 * Performs outbound transfer.
 */
async function transfer_tokens_with_relay(
  client: SuiClient,
  wallet: Ed25519Keypair,
  coinType: string,
  targetChain: string,
  recipient: string,
  amount: string
) {
  validateAddress(recipient);

  // Start new transaction.
  const tx = new TransactionBlock();

  // Wormhole fee coins.
  const [wormholeFee] = tx.splitCoins(tx.gas, [tx.pure(0)]);

  const coin = await getCoinWithHighestBalance(
    client,
    wallet.toSuiAddress(),
    coinType
  );

  // Coins to transfer to the target chain.
  const [coinsToTransfer] = tx.splitCoins(tx.object(coin.coinObjectId), [
    tx.pure(amount),
  ]);

  // Fetch the asset info.
  const [assetInfo] = tx.moveCall({
    target: `${TOKEN_BRIDGE_ID}::state::verified_asset`,
    arguments: [tx.object(TOKEN_BRIDGE_STATE_ID)],
    typeArguments: [coinType],
  });

  // Fetch the transfer ticket.
  const [transferTicket] = tx.moveCall({
    target: `${RELAYER_ID}::transfer::transfer_tokens_with_relay`,
    arguments: [
      tx.object(RELAYER_STATE_ID),
      coinsToTransfer,
      assetInfo,
      tx.pure(0), // swap amount
      tx.pure(targetChain),
      tx.pure("0x" + recipient),
      tx.pure(0),
    ],
    typeArguments: [coinType],
  });

  // Transfer the tokens with payload.
  const [messageTicket] = tx.moveCall({
    target: `${TOKEN_BRIDGE_ID}::transfer_tokens_with_payload::transfer_tokens_with_payload`,
    arguments: [tx.object(TOKEN_BRIDGE_STATE_ID), transferTicket],
    typeArguments: [coinType],
  });

  // Publish the message.
  tx.moveCall({
    target: `${WORMHOLE_ID}::publish_message::publish_message`,
    arguments: [
      tx.object(WORMHOLE_STATE_ID),
      wormholeFee,
      messageTicket,
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const {digest, balanceChanges} = await executeTransactionBlock(client, wallet, tx);
  await pollTransactionForEffectsCert(client, digest);

  console.log(balanceChanges);
}

async function main() {
  const args = await getArgs();

  const client = new SuiClient({
    url: getFullnodeUrl(args.network),
  });

  const wallet = Ed25519Keypair.fromSecretKey(
    Buffer.from(KEY, "base64")
  );

  if (args.coinType == SUI_TYPE) {
    await transfer_sui_with_relay(
      client,
      wallet,
      args.target,
      args.recipient!,
      args.amount
    );
  } else {
    await transfer_tokens_with_relay(
      client,
      wallet,
      args.coinType,
      args.target,
      args.recipient!,
      args.amount
    );
  }
}

main();
