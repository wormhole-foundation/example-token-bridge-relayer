import {
  Ed25519Keypair,
  JsonRpcProvider,
  RawSigner,
  Connection,
  TransactionBlock,
} from "@mysten/sui.js";
import {
  RELAYER_ID,
  WORMHOLE_STATE_ID,
  RELAYER_OWNER_CAP_ID,
  RELAYER_UPGRADE_CAP_ID,
  RPC,
  KEY,
} from "./consts";
import {executeTransactionBlock, pollTransactionForEffectsCert} from "./poll";

/**
 * Creates the state object for the specified Token Bridge Relayer contract.
 */
async function create_state(wallet: RawSigner) {
  // Call `owner::create_state` on the Token Bridge Relayer.
  const tx = new TransactionBlock();

  tx.moveCall({
    target: `${RELAYER_ID}::owner::create_state`,
    arguments: [
      tx.object(WORMHOLE_STATE_ID),
      tx.object(RELAYER_OWNER_CAP_ID),
      tx.object(RELAYER_UPGRADE_CAP_ID),
    ],
  });
  const {digest, objectChanges} = await executeTransactionBlock(wallet, tx);
  await pollTransactionForEffectsCert(wallet, digest); // Log the state ID.

  for (const objectEvent of objectChanges!) {
    if (
      objectEvent["type"] == "created" &&
      objectEvent["objectType"].includes("state::State")
    ) {
      console.log(`State created at id: ${objectEvent["objectId"]}`);
    }
  }
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

  // Create state.
  await create_state(wallet);
}

main();
