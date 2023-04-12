import {JsonRpcProvider, RawSigner, TransactionBlock} from "@mysten/sui.js";
import {execSync} from "child_process";
import {ethers} from "ethers";
import {WORMHOLE_STATE_ID} from "../tests/helpers";
import * as fs from "fs";

export async function getWormholeFee(provider: JsonRpcProvider) {
  // Fetch the wormhole state fields.
  const fields = await getObjectFields(provider, WORMHOLE_STATE_ID);

  if (fields === null) {
    Promise.reject("State object not found.");
  }

  // Cache wormhole fee.
  return fields!.fee_collector.fields.fee_amount;
}

export function getWormholeEvents(result: any) {
  if ("events" in result) {
    let wormholeEvents = [];
    for (const event of result.events!) {
      if (event.type.includes("WormholeMessage")) {
        wormholeEvents.push(event);
      }
    }
    return wormholeEvents;
  } else {
    return null;
  }
}

export async function getObjectFields(
  provider: JsonRpcProvider,
  objectId: string
) {
  // Fetch object.
  const result = await provider.getObject({
    id: objectId,
    options: {showContent: true},
  });

  if (
    typeof result.data!.content !== "string" &&
    "fields" in result.data!.content!
  ) {
    return result.data!.content.fields;
  } else {
    return null;
  }
}

export async function getDynamicFieldsByType(
  provider: JsonRpcProvider,
  parentId: string,
  type: string
) {
  // Fetch dynamic fields.
  const dynamicFields = await provider
    .getDynamicFields({parentId: parentId})
    .then((result) => result.data);

  // Fetch the target field by type.
  const targetObject = dynamicFields.filter((id) =>
    id.objectType.includes(type)
  );

  return targetObject;
}

export async function getDynamicObjectFields(
  provider: JsonRpcProvider,
  parentId: string,
  childName: any
) {
  const dynamicObjectFieldInfo = await provider
    .getDynamicFieldObject({
      parentId: parentId,
      name: childName,
    })
    .then((result) => {
      if (
        typeof result.data!.content !== "string" &&
        "content" in result.data! &&
        "fields" in result.data!.content!
      ) {
        return result.data?.content;
      } else {
        return null;
      }
    });

  if (dynamicObjectFieldInfo === null) {
    return Promise.reject("invalid dynamic object field");
  }

  return dynamicObjectFieldInfo;
}

export async function getTableFromDynamicObjectField(
  provider: JsonRpcProvider,
  parentId: string,
  childName: any
) {
  const dynamicObjectInfo = await getDynamicObjectFields(
    provider,
    parentId,
    childName
  );

  // Fetch the table's keys
  const keys = await provider
    .getDynamicFields({parentId: dynamicObjectInfo!.fields.id.id})
    .then((result) => result.data);

  if (keys.length == 0) {
    return Promise.reject("dynamic field not found");
  }

  // Create array of key value pairs
  const tableTuples = await Promise.all(
    keys.map(async (key) => {
      // Fetch the value
      const valueObject = await getObjectFields(provider, key.objectId);
      return [key.name.value, valueObject!.value];
    })
  );

  return tableTuples;
}

export async function getCoinWithHighestBalance(
  provider: JsonRpcProvider,
  walletAddress: string,
  coinType: string
) {
  const coins = await provider
    .getCoins({
      owner: walletAddress,
      coinType: coinType,
    })
    .then((result) => result.data);

  if (coins.length == 0) {
    return Promise.reject("no coins with balance found");
  }

  let balanceMax = 0;
  let index = 0;

  // Find the coin with the highest balance.
  for (let i = 0; i < coins.length; i++) {
    let balance = coins[i].balance;
    if (balance > balanceMax) {
      balanceMax = balance;
      index = i;
    }
  }

  return coins[index];
}

export function buildAndDeployWrappedCoin(
  wormholeId: string,
  tokenBridgeId: string,
  fullPathToTokenBridgeDependency: string,
  vaa: Uint8Array | Buffer,
  deployCommand: string,
  key?: string
) {
  // Create source
  const buf = Buffer.isBuffer(vaa) ? vaa : Buffer.from(vaa);
  const coinMoveSource = `module template::wrapped_coin {
    use sui::transfer;
    use sui::tx_context::{Self, TxContext};

    use token_bridge::create_wrapped::prepare_registration;

    struct WRAPPED_COIN has drop {}

    fun init(coin_witness: WRAPPED_COIN, ctx: &mut TxContext) {
        let vaa_bytes = x"${buf.toString("hex")}";

        let wrapped = prepare_registration(
          coin_witness,
          vaa_bytes,
          ctx
        );
        transfer::public_transfer(
            wrapped,
            tx_context::sender(ctx)
        );
    }

    #[test_only]
    public fun test_init(ctx: &mut TxContext) {
        init(COIN_WITNESS {}, ctx)
    }
}`;

  // Create Move.toml
  const moveToml = `[package]
name = "Template"
version = "0.69.420"

[dependencies.Sui]
git = "https://github.com/MystenLabs/sui.git"
subdir = "crates/sui-framework/packages/sui-framework"
rev = "ddfc3fa0768a38286787319603a5458a9ff91cc1"

[dependencies.TokenBridge]
local = "${fullPathToTokenBridgeDependency}"

[addresses]
wormhole = "${wormholeId}"
token_bridge = "${tokenBridgeId}"
template = "0x0"`;

  // Make tmp directory
  const homeDir = require("os").homedir();
  const tmpDir = `${homeDir}/template`;
  const tmpSources = `${tmpDir}/sources`;

  fs.mkdirSync(tmpSources, {recursive: true});

  // Write `coinMoveSource` to this sources directory
  fs.writeFileSync(`${tmpSources}/create.move`, coinMoveSource, "utf-8");

  // Write Move.toml
  fs.writeFileSync(`${tmpDir}/Move.toml`, moveToml, "utf-8");
  fs.writeFileSync(`${tmpDir}/Move.devnet.toml`, moveToml, "utf-8");

  // Build and deploy
  let fullDeployCommand = `${deployCommand} ${tmpDir} -n devnet -k ${key}`;

  // Parse deployment output
  const output = execSync(fullDeployCommand, {
    encoding: "utf8",
  });
}

export function tokenBridgeNormalizeAmount(
  amount: ethers.BigNumber,
  decimals: number
): ethers.BigNumber {
  if (decimals > 8) {
    amount = amount.div(10 ** (decimals - 8));
  }
  return amount;
}

export function tokenBridgeDenormalizeAmount(
  amount: ethers.BigNumber,
  decimals: number
): ethers.BigNumber {
  if (decimals > 8) {
    amount = amount.mul(10 ** (decimals - 8));
  }
  return amount;
}

export function tokenBridgeTransform(
  amount: ethers.BigNumber,
  decimals: number
): ethers.BigNumber {
  return tokenBridgeDenormalizeAmount(
    tokenBridgeNormalizeAmount(amount, decimals),
    decimals
  );
}
