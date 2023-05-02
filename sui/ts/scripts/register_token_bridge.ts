import {
  Ed25519Keypair,
  JsonRpcProvider,
  RawSigner,
  Connection,
  TransactionBlock,
  SUI_CLOCK_OBJECT_ID,
  builder,
} from "@mysten/sui.js";
import {
  WORMHOLE_ID,
  WORMHOLE_STATE_ID,
  TOKEN_BRIDGE_ID,
  TOKEN_BRIDGE_STATE_ID,
  RPC,
  KEY,
} from "./consts";
import {getObjectFields} from "../src";
import {executeTransactionBlock, pollTransactionForEffectsCert} from "./poll";
import yargs from "yargs";

export function getArgs() {
  const argv = yargs.options({
    vaa: {
      alias: "v",
      describe: "VAA",
      require: true,
      type: "string",
    },
  }).argv;

  if ("vaa" in argv) {
    return {
      vaa: argv.vaa,
    };
  } else {
    throw Error("Invalid arguments");
  }
}

const MAX_PURE_ARGUMENT_SIZE = 16 * 1024;

/**
 * Registers a foreign token bridge contract.
 */
async function submit_vaa(
  provider: JsonRpcProvider,
  wallet: RawSigner,
  vaa: string
) {
  // Register an emitter from Ethereum on the token bridge.
  const tx = new TransactionBlock();

  // Parse and verify the vaa.
  const [verifiedVaa] = tx.moveCall({
    target: `${WORMHOLE_ID}::vaa::parse_and_verify`,
    arguments: [
      tx.object(WORMHOLE_STATE_ID),
      tx.pure(
        builder
          .ser("vector<u8>", Uint8Array.from(Buffer.from(vaa, "hex")), {
            maxSize: MAX_PURE_ARGUMENT_SIZE,
          })
          .toBytes()
      ),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  // Authorize the governance.
  const [decreeTicket] = tx.moveCall({
    target: `${TOKEN_BRIDGE_ID}::register_chain::authorize_governance`,
    arguments: [tx.object(TOKEN_BRIDGE_STATE_ID)],
  });

  // Fetch the governance message.
  const [decreeReceipt] = tx.moveCall({
    target: `${WORMHOLE_ID}::governance_message::verify_vaa`,
    arguments: [tx.object(WORMHOLE_STATE_ID), verifiedVaa, decreeTicket],
    typeArguments: [`${TOKEN_BRIDGE_ID}::register_chain::GovernanceWitness`],
  });

  // Register the chain.
  tx.moveCall({
    target: `${TOKEN_BRIDGE_ID}::register_chain::register_chain`,
    arguments: [tx.object(TOKEN_BRIDGE_STATE_ID), decreeReceipt],
  });

  const {digest} = await executeTransactionBlock(wallet, tx);
  await pollTransactionForEffectsCert(wallet, digest);

  // // Confirm that the bridge was registered.
  const tokenBridgeState = await getObjectFields(
    provider,
    TOKEN_BRIDGE_STATE_ID
  );

  const id = tokenBridgeState!.emitter_registry.fields.id.id;

  const keys = await provider
    .getDynamicFields({parentId: id})
    .then((result) => result.data);

  const tableTuples = await Promise.all(
    keys.map(async (key) => {
      // Fetch the value
      const valueObject = await getObjectFields(provider, key.objectId);
      return [key.name.value, valueObject!.value.fields.value.fields.data];
    })
  );

  console.log(tableTuples);
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

  // Submit the registration VAA.
  await submit_vaa(provider, wallet, args.vaa);
}

main();
