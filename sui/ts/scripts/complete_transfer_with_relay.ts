import {
  SuiClient,
  getFullnodeUrl,
} from "@mysten/sui.js/client";
import {
  Ed25519Keypair,
} from "@mysten/sui.js/keypairs/ed25519";
import {
  SUI_CLOCK_OBJECT_ID,
} from "@mysten/sui.js/utils";
import {
  TransactionBlock,
} from "@mysten/sui.js/transactions";
import {
  parseVaa,
  parseTransferPayload,
  CHAIN_ID_SUI,
} from "@certusone/wormhole-sdk";
import { uint8ArrayToBCS } from "@certusone/wormhole-sdk/lib/cjs/sui";
import { ethers } from "ethers";

import { createParser } from "./cli_args";
import {
  RELAYER_ID,
  RELAYER_STATE_ID,
  WORMHOLE_ID,
  WORMHOLE_STATE_ID,
  TOKEN_BRIDGE_ID,
  TOKEN_BRIDGE_STATE_ID,
  KEY,
} from "./consts";
import { executeTransactionBlock, pollTransactionForEffectsCert } from "./poll";

import {
  getTokenInfo,
  getTokenCoinType,
  tokenBridgeDenormalizeAmount,
  getIsTransferCompletedSui,
  getRelayerState,
} from "../src";

export async function getArgs() {
  const argv = await createParser().options({
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
      network: argv.network as "mainnet" | "testnet",
    };
  } else {
    throw Error("Invalid arguments");
  }
}

const SUI_TYPE =
  "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

export async function getSwapQuote(
  client: SuiClient,
  wallet: string,
  relayerId: string,
  relayerState: any,
  toNativeTokenAmount: string,
  decimals: number,
  coinType: string
): Promise<number> {
  // Fetch the swap quote by calling the contract.
  const tx = new TransactionBlock();

  tx.moveCall({
    target: `${relayerId}::redeem::calculate_native_swap_amount_out`,
    arguments: [
      tx.object(relayerState!.id.id),
      tx.pure(toNativeTokenAmount),
      tx.pure(decimals),
    ],
    typeArguments: [coinType],
  });

  const swapQuoteResponse = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: wallet,
  });

  const result = swapQuoteResponse.results![0].returnValues!;

  if (result.length != 1) {
    throw Error("Invalid swap quote response");
  }

  const swapQuote = Number(Buffer.from(result[0][0]).readBigUInt64LE(0));

  const tokenInfo = await getTokenInfo(
    client,
    relayerState,
    coinType
  );
  const maxNativeSwapAmount = tokenInfo.value.fields.max_native_swap_amount;

  return Math.min(swapQuote, parseInt(maxNativeSwapAmount));
}

/**
 * Relays a VAA to the Sui Relayer contract.
 */
async function relay(
  client: SuiClient,
  wallet: Ed25519Keypair,
  vaa: Uint8Array
) {
  const state = await getRelayerState(client, RELAYER_STATE_ID);

  // Check to see if the VAA has been redeemed already.
  const isRedeemed = await getIsTransferCompletedSui(
    client,
    TOKEN_BRIDGE_STATE_ID,
    vaa
  );

  if (isRedeemed) {
    console.log("Vaa already redeemed");
    return;
  }

  const parsedVaa = parseVaa(vaa);

  const payloadType = parsedVaa.payload.readUint8(0);
  if (payloadType != 3) {
    console.log("Not a token bridge transfer with payload (TB message id 3)");
    return;
  }

  const transferPayload = parseTransferPayload(parsedVaa.payload);

  // Confirm that the destination is the relayer contract.
  if (
    state.emitter_cap.fields.id.id != transferPayload.targetAddress &&
    transferPayload.targetChain != CHAIN_ID_SUI
  ) {
    console.log("Destination is not a relayer contract");
    return;
  }

  const coinType = await getTokenCoinType(
    client,
    TOKEN_BRIDGE_STATE_ID,
    Buffer.from(transferPayload.originAddress, "hex"),
    transferPayload.originChain
  );

  if (coinType == null) {
    throw Error("Error fetch the coin type. Is the coin registered?");
  }

  let decimals;
  if (coinType == SUI_TYPE) {
    decimals = 9;
  } else {
    decimals = await client
      .getCoinMetadata({
        coinType: coinType,
      })
      .then((result) => result!.decimals);

    if (decimals == null) {
      throw Error("Failed to fetch token decimals");
    }
  }

  // Parse and denormalize the to native token amount (swap amount).
  const denormalizedToNativeAmount = tokenBridgeDenormalizeAmount(
    Number(ethers.utils.hexlify(parsedVaa.payload.subarray(166, 198))),
    decimals
  );

  let swapQuote;
  if (coinType == SUI_TYPE) {
    swapQuote = 0;
  } else {
    swapQuote = await getSwapQuote(
      client,
      wallet.toSuiAddress(),
      RELAYER_ID,
      state,
      denormalizedToNativeAmount.toString(),
      decimals,
      coinType
    );
  }

  const tx = new TransactionBlock();

  // Parse and verify the vaa.
  const [verifiedVaa] = tx.moveCall({
    target: `${WORMHOLE_ID}::vaa::parse_and_verify`,
    arguments: [
      tx.object(WORMHOLE_STATE_ID),
      tx.pure(uint8ArrayToBCS(vaa)),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  // Verify the VAA with the token bridge.
  const [tokenBridgeMessage] = tx.moveCall({
    target: `${TOKEN_BRIDGE_ID}::vaa::verify_only_once`,
    arguments: [tx.object(TOKEN_BRIDGE_STATE_ID), verifiedVaa],
  });

  // Authorize the transfer.
  const [redeemerReceipt] = tx.moveCall({
    target: `${TOKEN_BRIDGE_ID}::complete_transfer_with_payload::authorize_transfer`,
    arguments: [tx.object(TOKEN_BRIDGE_STATE_ID), tokenBridgeMessage],
    typeArguments: [coinType],
  });

  // Native coins to swap.
  const [coinsToTransfer] = tx.splitCoins(tx.gas, [tx.pure(swapQuote)]);

  // Complete the tranfer with relay.
  tx.moveCall({
    target: `${RELAYER_ID}::redeem::complete_transfer_with_relay`,
    arguments: [
      tx.object(RELAYER_STATE_ID),
      tx.object(TOKEN_BRIDGE_STATE_ID),
      redeemerReceipt,
      coinsToTransfer,
    ],
    typeArguments: [coinType],
  });

  const {digest, balanceChanges} = await executeTransactionBlock(client, wallet, tx);
  await pollTransactionForEffectsCert(client, digest);

  console.log(`Digest: ${digest}`);
  console.log(balanceChanges);

  // Check to see if the VAA has been redeemed already.
  {
    const isRedeemed = await getIsTransferCompletedSui(
      client,
      TOKEN_BRIDGE_STATE_ID,
      vaa
    );

    if (isRedeemed) {
      console.log("Vaa redeemed successfully");
      return;
    }
  }
}

async function main() {
  const args = await getArgs();

  const client = new SuiClient({
    url: getFullnodeUrl(args.network)
  });

  const key = Ed25519Keypair.fromSecretKey(
    Buffer.from(KEY, "base64")
  );

  const vaaBuf = Buffer.from(args.vaa, "hex");
  await relay(client, key, vaaBuf);
}

main();
