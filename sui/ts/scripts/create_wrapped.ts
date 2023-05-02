import {
  Ed25519Keypair,
  JsonRpcProvider,
  RawSigner,
  Connection,
  getPublishedObjectChanges,
} from "@mysten/sui.js";
import {WORMHOLE_STATE_ID, TOKEN_BRIDGE_STATE_ID, RPC, KEY} from "./consts";
import {
  createWrappedOnSuiPrepare,
  parseAttestMetaVaa,
  createWrappedOnSui,
} from "@certusone/wormhole-sdk";
import {executeTransactionBlock} from "./poll";
import yargs from "yargs";

export function getArgs() {
  const argv = yargs.options({
    vaa: {
      alias: "v",
      describe: "Redemption VAA",
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

/**
 * Relays a VAA to the Sui Relayer contract.
 */
async function createWrapped(
  provider: JsonRpcProvider,
  wallet: RawSigner,
  vaa: string
) {
  const attestVaa = Buffer.from(vaa, "hex");

  // Start create wrapped on Sui
  const suiPrepareRegistrationTxPayload = await createWrappedOnSuiPrepare(
    provider,
    WORMHOLE_STATE_ID,
    TOKEN_BRIDGE_STATE_ID,
    parseAttestMetaVaa(attestVaa).decimals,
    await wallet.getAddress()
  );

  const suiPrepareRegistrationTxRes = await executeTransactionBlock(
    wallet,
    suiPrepareRegistrationTxPayload
  );
  suiPrepareRegistrationTxRes.effects?.status.status === "failure" &&
    console.log(JSON.stringify(suiPrepareRegistrationTxRes.effects, null, 2));

  // Complete create wrapped on Sui
  const wrappedAssetSetupEvent =
    suiPrepareRegistrationTxRes.objectChanges?.find(
      (oc) =>
        oc.type === "created" && oc.objectType.includes("WrappedAssetSetup")
    );
  const wrappedAssetSetupType =
    (wrappedAssetSetupEvent?.type === "created" &&
      wrappedAssetSetupEvent.objectType) ||
    undefined;

  // Complete create wrapped on Sui
  const publishEvents = getPublishedObjectChanges(suiPrepareRegistrationTxRes);

  const coinPackageId = publishEvents[0].packageId;
  const suiCompleteRegistrationTxPayload = await createWrappedOnSui(
    provider,
    WORMHOLE_STATE_ID,
    TOKEN_BRIDGE_STATE_ID,
    await wallet.getAddress(),
    coinPackageId,
    wrappedAssetSetupType!,
    attestVaa
  );
  const suiCompleteRegistrationTxRes = await executeTransactionBlock(
    wallet,
    suiCompleteRegistrationTxPayload
  );
  suiCompleteRegistrationTxRes.effects?.status.status === "failure" &&
    console.log(JSON.stringify(suiCompleteRegistrationTxRes.effects, null, 2));

  console.log(coinPackageId);
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

  // Complete the transfer.
  await createWrapped(provider, wallet, args.vaa);
}

main();
