import {
  Ed25519Keypair,
  JsonRpcProvider,
  RawSigner,
  Connection,
  TransactionBlock,
  SUI_CLOCK_OBJECT_ID,
} from "@mysten/sui.js";
import {
  TOKEN_BRIDGE_ID,
  TOKEN_BRIDGE_STATE_ID,
  WORMHOLE_ID,
  WORMHOLE_STATE_ID,
  RPC,
  KEY,
} from "./consts";
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
    metadata: {
      alias: "m",
      describe: "Metadata ID",
      require: true,
      type: "string",
    },
  }).argv;

  if ("coinType" in argv && "metadata" in argv) {
    return {
      coinType: argv.coinType,
      metadata: argv.metadata,
    };
  } else {
    throw Error("Invalid arguments");
  }
}

/**
 * Mint specified token.
 */
async function attest_token(
  provider: JsonRpcProvider,
  wallet: RawSigner,
  coinType: string,
  metadataId: string
) {
  if (metadataId == "") {
    metadataId = await provider
      .getCoinMetadata({
        coinType: coinType,
      })
      .then((result) => result!.id!);
  }

  // Call `token_bridge::attest_token` on Token Bridge.
  const tx = new TransactionBlock();
  const [wormholeFee] = tx.splitCoins(tx.gas, [tx.pure(0)]);

  // Fetch message ticket.
  const [messageTicket] = tx.moveCall({
    target: `${TOKEN_BRIDGE_ID}::attest_token::attest_token`,
    arguments: [
      tx.object(TOKEN_BRIDGE_STATE_ID),
      tx.object(metadataId),
      tx.pure(0),
    ],
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

  const {digest, events} = await executeTransactionBlock(wallet, tx);
  await pollTransactionForEffectsCert(wallet, digest);

  console.log(events);
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
  await attest_token(provider, wallet, args.coinType, args.metadata);
}

main();
