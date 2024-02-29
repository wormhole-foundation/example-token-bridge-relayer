import { CHAIN_ID_SUI, ChainId, getSignedVAAHash, isChain } from "@certusone/wormhole-sdk";
import { MoveStruct, SuiClient } from "@mysten/sui.js/client";
import { isValidSuiAddress } from "@mysten/sui.js/utils";
import { inspect } from "util";

type SuiObjectId = string;

interface SuiId {
  id: {
    id: SuiObjectId;
  };
}

interface SuiType {
  type: `${SuiObjectId}::${string}::${string}`;
}

/**
 * Valid for TBRv2
 */
export type TbrStateFields = SuiId & {
  emitter_cap: SuiType & {
    fields: SuiId & {
      // This looks like an unused field (value 0 in mainnet)
      // Why?
      sequence: string;
    };
  };
  registered_tokens: SuiType & {
    fields: SuiId & {
      num_tokens: string;
    };
  };
  relayer_fee_precision: string;
  swap_rate_precision: string;
};

export type TbrTokenFields = SuiId & {
  name: SuiType & {
    fields: {
      // 🤔
      dummy_field: false;
    };
  };
  value: SuiType & {
    fields: {
      max_native_swap_amount: string;
      swap_enabled: boolean;
      swap_rate: string;
    };
  };
};

/**
 * Token bridge state fields.
 */
export type TbStateFields = SuiId & {
  consumed_vaas: SuiType & {
    fields: {
      hashes: SuiType & {
        fields: {
          items: SuiType & {
            fields: SuiId & {
              size: string;
            };
          };
        };
      };
    };
  };
  emitter_cap: SuiType & {
    fields: SuiId & {
      sequence: string;
    };
  };
  emitter_registry: SuiType & {
    fields: SuiId & {
      size: string;
    };
  };
  governance_chain: 1;
  governance_contract: SuiType & {
    fields: SuiType & {
      value: SuiType & {
        fields: {
          data: readonly [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4];
        };
      };
    };
  };
  token_registry: SuiType & {
    fields: SuiId & {
      coin_types: SuiType & {
        fields: SuiId & {
          size: string;
        };
      };
      num_native: string;
      num_wrapped: string;
    };
  };
  upgrade_cap: SuiType & {
    fields: SuiId & {
      package: string;
      policy: number;
      version: string;
    };
  };
};

interface RelayerRegistration {
  // type '0x5306f64e312b581766351c07af79c72fcb1cd25147157fdc2f8ad76de9a3fb6a::external_address::ExternalAddress' in mainnet
  value: SuiType & {
    fields: {
      // type '0x5306f64e312b581766351c07af79c72fcb1cd25147157fdc2f8ad76de9a3fb6a::bytes32::Bytes32' in mainnet
      value: SuiType & {
        fields: {
          data: number[];
        };
      };
    };
  };
};

export const getObjectFields = async (client: SuiClient, objectId: string): Promise<MoveStruct> => {
  if (!isValidSuiAddress(objectId)) {
    throw new Error(`Invalid Sui object ID: ${objectId}`);
  }

  const res = await client.getObject({
    id: objectId,
    options: {
      showContent: true,
    },
  });
  if (res.error !== undefined && res.error !== null) {
    throw new Error(`getObjectFields: Sui RPC responded with error code ${res.error.code}
${inspect(res.error)}`);
  }
  if (res.data === undefined || res.data === null) {
    throw new Error(`getObjectFields: Sui RPC response is empty`);
  }
  if (res.data.content === undefined || res.data.content === null) {
    throw new Error(`getObjectFields: object is empty?`);
  }
  // TODO: support other objects?
  // We should only do so if necessary
  if (res.data.content.dataType !== "moveObject") {
    throw new Error(`getObjectFields: ${objectId} is not a moveObject`);
  }
  // TODO: check type field
  // For example, TBR state id has type `0x38035f4c1e1772d43a3535535ea5b29c1c3ab2c0026d4ad639969831bd1d174d::state::State` in mainnet.
  // That's roughly `<package-id>::<module>::<object? method?>`.

  return res.data.content.fields;
};

export async function getRelayerState(client: SuiClient, relayerAddress: string): Promise<TbrStateFields> {
  const relayerState = await getObjectFields(client, relayerAddress);

  if (Array.isArray(relayerState)) {
    throw new Error("getRelayerState: object field is an Array");
  }
  // This is not such a good check.
  // We should parse the rest of the fields instead.
  if ("fields" in relayerState) {
    throw new Error("getRelayerState: object fields is a nested object");
  }

  return relayerState as unknown as TbrStateFields;
}

export async function getTokenInfo(client: SuiClient, tbrState: TbrStateFields, coinType: string): Promise<TbrTokenFields> {
  const targetDynamicField = await getDynamicFieldsByType(client, tbrState.registered_tokens.fields.id.id, coinType);

  if (targetDynamicField.length !== 1) {
    throw new Error("getTokenInfo: unexpected length of dynamic field, ${targetDynamicField.length}");
  }

  // Fetch the `TokenInfo` dynamic field.
  const tokenFields = await getObjectFields(client, targetDynamicField[0].objectId);

  if (Array.isArray(tokenFields)) {
    throw new Error("getRelayerState: object field is an Array");
  }
  // This is not such a good check.
  // We should parse the rest of the fields instead.
  if ("fields" in tokenFields) {
    throw new Error("getRelayerState: object fields is a nested object");
  }

  return tokenFields as unknown as TbrTokenFields;
}

export async function getDynamicFields(client: SuiClient, parentId: string) {
  const dynamicFields = await client.getDynamicFields({ parentId });
  if (dynamicFields.hasNextPage) {
    throw new Error(`Dynamic fields for object ${parentId} has more than one page.
Querying multiple pages is not implemented.`);
  }

  return dynamicFields.data;
}

export async function getDynamicFieldsByType(client: SuiClient, parentId: string, type: string) {
  const dynamicFields = await getDynamicFields(client, parentId);

  // TODO: support querying multiple tokens at once?
  // TODO: what is this "3" magic number?
  return dynamicFields.filter(entry => entry.objectType.includes(type) || entry.objectType.includes(type.substring(3)));
}

export async function getDynamicFieldsByName(client: SuiClient, parentId: string, name: string) {
  const dynamicFields = await getDynamicFields(client, parentId);
  if (!Array.isArray(dynamicFields)) {
    throw new Error(`Unexpected dynamic fields format for object id ${parentId}`);
  }

  return dynamicFields.find(entry => {
    return entry.name.type === "vector<u8>" && Buffer.from(entry.name.value as number[]).toString() === name;
  });
}

export async function getRelayerRegistrations(client: SuiClient, relayerAddress: string): Promise<Partial<Record<ChainId, string>>> {
  // If you need to implement this, look at how `getRelayerFees` is implemented for inspiration.
  // Use a node REPL to inspect RPC responses and parse out the structure.
  const relayerRegistrationsRef = await getDynamicFieldsByName(client, relayerAddress, "foreign_contracts");
  if (relayerRegistrationsRef === undefined) {
    throw new Error(`Relayer fees table not found in relayer state ${relayerAddress}`);
  }

  const relayerRegistrations = await getDynamicFields(client, relayerRegistrationsRef.objectId);
  // Every key should be a wormhole chain id.
  if (relayerRegistrations.some(({ name }) => name.type !== "u16")) {
    throw new Error(`Unexpected type found when parsing relayer fee keys for object ${relayerRegistrationsRef.objectId}`);
  }

  const registeredEmitters: Partial<Record<ChainId, string>> = {};
  for (const { name, objectId } of relayerRegistrations) {
    const chainId = name.value as number;
    if (!isChain(chainId) || chainId === CHAIN_ID_SUI) {
      throw new Error(`Unexpected chain id found ${name.value}`);
    }

    const registrationObjectFields = await getObjectFields(client, objectId);

    if (Array.isArray(registrationObjectFields)) {
      throw new Error("getRelayerFees: fee object field is an Array");
    }
    // This is not such a good check.
    // We should parse the rest of the fields instead.
    if ("fields" in registrationObjectFields) {
      throw new Error("getRelayerFees: fee object fields is a nested object");
    }

    // TODO: create a type safe decoding function for the registration object
    // For example, we should ensure that the types read coincide
    const registrationObject = registrationObjectFields as unknown as RelayerRegistration;
    registeredEmitters[chainId] = `0x${Buffer.from(registrationObject.value.fields.value.fields.data).toString("hex")}`;
  }

  return registeredEmitters as Partial<Record<ChainId, string>>;
}

export async function getRelayerFees(
  client: SuiClient,
  relayerAddress: string,
): Promise<Partial<Record<ChainId, bigint>>> {
  const relayerFeesRef = await getDynamicFieldsByName(client, relayerAddress, "relayer_fees");
  if (relayerFeesRef === undefined) {
    throw new Error(`Relayer fees table not found in relayer state ${relayerAddress}`);
  }

  const relayerFees = await getDynamicFields(client, relayerFeesRef.objectId);
  // Every key should be a wormhole chain id.
  if (relayerFees.some(({ name }) => name.type !== "u16")) {
    throw new Error(`Unexpected type found when parsing relayer fee keys for object ${relayerFeesRef.objectId}`);
  }

  const fees: Partial<Record<ChainId, bigint>> = {};
  for (const { name, objectId } of relayerFees) {
    const chainId = name.value as number;
    if (!isChain(chainId) || chainId === CHAIN_ID_SUI) {
      throw new Error(`Unexpected chain id found ${name.value}`);
    }

    const feeObject = await getObjectFields(client, objectId);

    if (Array.isArray(feeObject)) {
      throw new Error("getRelayerFees: fee object field is an Array");
    }
    // This is not such a good check.
    // We should parse the rest of the fields instead.
    if ("fields" in feeObject) {
      throw new Error("getRelayerFees: fee object fields is a nested object");
    }

    fees[chainId] = BigInt(feeObject.value as string);
  }

  // TODO: should we fill in missing entries with a zero fee?
  // E.g. this could happen upon contract initialization and skipping on fees to test relays.
  return fees as Partial<Record<ChainId, bigint>>;
}

export async function getTokenBridgeStateFields(client: SuiClient, tokenBridgeState: string): Promise<TbStateFields> {
  const tokenBridgeStateFields = await getObjectFields(client, tokenBridgeState);
  if (Array.isArray(tokenBridgeStateFields)) {
    throw new Error("Unexpected array for fields in token bridge state.");
  }
  if ("fields" in tokenBridgeStateFields) {
    throw new Error("Unexpected nested object fields in token bridge state.");
  }
  return tokenBridgeStateFields as unknown as TbStateFields;
}

export async function getIsTransferCompletedSui(
  client: SuiClient,
  tokenBridgeStateObjectId: string,
  transferVAA: Uint8Array,
): Promise<boolean> {
  const tokenBridgeStateFields = await getTokenBridgeStateFields(client, tokenBridgeStateObjectId);

  const hashes = tokenBridgeStateFields.consumed_vaas.fields.hashes;
  const tableObjectId = hashes.fields.items.fields.id.id;

  const keyType = getTableKeyType(hashes.fields.items.type);
  if (keyType === null) {
    throw new Error("Unable to get key type");
  }

  const hash = getSignedVAAHash(transferVAA);
  const response = await client.getDynamicFieldObject({
    parentId: tableObjectId,
    name: {
      type: keyType,
      value: {
        data: [...Buffer.from(hash.slice(2), "hex")],
      },
    },
  });
  if (!response.error) {
    return true;
  }

  if (response.error.code === "dynamicFieldNotFound") {
    return false;
  }

  throw new Error(`Unexpected getDynamicFieldObject response ${response.error}`);
}

/**
 * This method removes leading zeroes for types in order to normalize them
 * since some types returned from the RPC have leading zeroes and others don't.
 */
export const trimSuiType = (type: string): string => type.replace(/(0x)(0*)/g, "0x");

export const getTableKeyType = (tableType: string): string | null => {
  if (!tableType) return null;
  const match = trimSuiType(tableType).match(/0x2::table::Table<(.*)>/);
  if (!match) return null;
  const [keyType] = match[1].split(",");
  if (!isValidSuiType(keyType)) return null;
  return keyType;
};

export const isValidSuiType = (type: string): boolean => {
  const tokens = type.split("::");
  if (tokens.length !== 3) {
    return false;
  }

  return isValidSuiAddress(tokens[0]) && !!tokens[1] && !!tokens[2];
};

export const getTokenCoinType = async (
  client: SuiClient,
  tokenBridgeStateObjectId: string,
  tokenAddress: Uint8Array,
  tokenChain: number,
): Promise<string | null> => {
  const tokenBridgeStateFields = await getTokenBridgeStateFields(client, tokenBridgeStateObjectId);

  const coinTypes = tokenBridgeStateFields.token_registry.fields.coin_types;
  const coinTypesObjectId = coinTypes.fields.id.id;

  const keyType = getTableKeyType(coinTypes?.type);
  if (keyType === null) {
    throw new Error("Unable to get key type");
  }

  const response = await client.getDynamicFieldObject({
    parentId: coinTypesObjectId,
    name: {
      type: keyType,
      value: {
        addr: [...tokenAddress],
        chain: tokenChain,
      },
    },
  });
  if ((response.error !== null && response.error !== undefined) || response.data === null || response.data === undefined) {
    if (response.error?.code === "dynamicFieldNotFound") {
      return null;
    }
    throw new Error(`Unexpected getDynamicFieldObject response ${inspect(response.error, { depth: 5 })}`);
  }
  if (response.data?.content?.dataType !== "moveObject") {
    throw new Error(`Unexpected data type for dynamic fields of coin type object ${coinTypesObjectId}`);
  }
  // if (!("fields" in response.data?.content)) {
  //   throw new Error(`Unexpected layout for dynamic fields of coin type object ${coinTypesObjectId}. Missing "fields" property.`);
  // }
  const fields = response.data?.content.fields;
  if (Array.isArray(fields)) {
    throw new Error("Fields in coin type object is an Array instead of an object");
  }
  if ("fields" in fields) {
    throw new Error("Fields in coin type object is a nested object instead of an object");
  }
  const value = fields.value;
  if (typeof value !== "string" && value !== null) {
    throw new Error(`"value" field in coin type object is not a string but rather ${typeof value}`);
  }
  return value !== null ? trimSuiType(ensureHexPrefix(value)) : null;
};

function ensureHexPrefix(hexdata: string): string {
  if (hexdata.startsWith("0x")) return hexdata;

  return `0x${hexdata}`;
}

export function tokenBridgeNormalizeAmount(
  amount: number,
  decimals: number
): number {
  if (decimals > 8) {
    amount = amount / 10 ** (decimals - 8);
  }
  return Math.floor(amount);
}

export function tokenBridgeDenormalizeAmount(
  amount: number,
  decimals: number
): number {
  if (decimals > 8) {
    amount = amount * 10 ** (decimals - 8);
  }
  return Math.floor(amount);
}

export async function getCoinWithHighestBalance(
  client: SuiClient,
  walletAddress: string,
  coinType: string
) {
  const coins = await client
    .getCoins({
      owner: walletAddress,
      coinType: coinType,
    })
    .then((result) => result.data);

  if (coins.length == 0) {
    throw new Error("No coins with balance found");
  }

  let balanceMax = 0;
  let index = 0;

  // Find the coin with the highest balance.
  for (let i = 0; i < coins.length; i++) {
    let balance = parseInt(coins[i].balance);
    if (balance > balanceMax) {
      balanceMax = balance;
      index = i;
    }
  }

  return coins[index];
}