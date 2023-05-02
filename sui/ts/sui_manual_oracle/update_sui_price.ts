import {
  Ed25519Keypair,
  JsonRpcProvider,
  RawSigner,
  Connection,
  TransactionBlock,
} from "@mysten/sui.js";
import {getTokenInfo, getObjectFields} from "../src";
import {
  executeTransactionBlock,
  pollTransactionForEffectsCert,
} from "../scripts/poll";
import {
  CHAIN_ID_SUI,
  CHAIN_ID_ETH,
  CHAIN_ID_AVAX,
  CHAIN_ID_BSC,
  CHAIN_ID_FANTOM,
  CHAIN_ID_CELO,
  CHAIN_ID_POLYGON,
  ChainId,
  CHAIN_ID_MOONBEAM,
} from "@certusone/wormhole-sdk";
import yargs from "yargs";
import {ethers} from "ethers";
import * as fs from "fs";
import {ITokenBridge__factory} from "@certusone/wormhole-sdk/lib/cjs/ethers-contracts";

// SUI consts.
const RELAYER_ID = process.env.RELAYER_ID!;
const RELAYER_STATE_ID = process.env.RELAYER_STATE_ID!;
const RELAYER_OWNER_CAP_ID = process.env.RELAYER_OWNER_CAP_ID!;
const SUI_RPC = process.env.SUI_RPC!;
const SUI_KEY = process.env.SUI_KEY!;
const SUI_TYPE = "0x2::sui::SUI";
const SUI_ID =
  "0x9d31091f5decefeb373de2218d634dbe198c72feac6e50fba0a5330cb5e65cff";

// ETH consts.
const ETH_KEY = process.env.ETH_KEY!;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function getRpc(rpcEvnVariable: string): ethers.providers.JsonRpcProvider {
  const provider = new ethers.providers.JsonRpcProvider(rpcEvnVariable);
  return provider;
}

export function getArgs() {
  const argv = yargs.options({
    swapRate: {
      alias: "p",
      describe: "SUI swap rate scaled by 1e8",
      require: true,
      type: "string",
    },
  }).argv;

  if ("swapRate" in argv) {
    return {
      swapRate: argv.swapRate,
    };
  } else {
    throw Error("Invalid arguments");
  }
}

/**
 * Updates the swap rate for the specified coin type.
 */
async function update_swap_rate_on_sui(swapRate: string) {
  // Set up provider.
  const connection = new Connection({fullnode: SUI_RPC});
  const provider = new JsonRpcProvider(connection);

  // Owner wallet.
  const suiKey = Ed25519Keypair.fromSecretKey(
    Buffer.from(SUI_KEY, "base64").subarray(1)
  );
  const wallet = new RawSigner(suiKey, provider);

  // Update the swap rate.
  const tx = new TransactionBlock();
  tx.moveCall({
    target: `${RELAYER_ID}::owner::update_swap_rate`,
    arguments: [
      tx.object(RELAYER_OWNER_CAP_ID),
      tx.object(RELAYER_STATE_ID),
      tx.pure(swapRate),
    ],
    typeArguments: [SUI_TYPE],
  });
  const {digest} = await executeTransactionBlock(wallet, tx);
  await pollTransactionForEffectsCert(wallet, digest);

  // Fetch state.
  const state = await getObjectFields(provider, RELAYER_STATE_ID);

  // Verify state.
  const tokenInfo = await getTokenInfo(provider, state, SUI_TYPE);

  console.log(
    `Swap rate updated to ${tokenInfo.swap_rate} for chain: ${CHAIN_ID_SUI}, hash: ${digest}`
  );
}

async function update_swap_rate_on_eth(
  chainId: number,
  rpc: string,
  relayer: string,
  bridge: string,
  swapRate: string
) {
  // Create wallet.
  const signer = new ethers.Wallet(ETH_KEY, getRpc(rpc));

  // Create contract instance.
  const relayerContract = new ethers.Contract(
    relayer,
    [
      "function swapRate(address) public view returns (uint256)",
      "function updateSwapRate(uint16,address,uint256) public",
    ],
    signer
  );

  // Create token bridge instance.
  const bridgeContract = ITokenBridge__factory.connect(bridge, signer);

  // Grab the local token address for Sui from the token bridge.
  const localTokenAddress = await bridgeContract.wrappedAsset(
    CHAIN_ID_SUI,
    SUI_ID
  );

  if (localTokenAddress == ZERO_ADDRESS) {
    throw Error("Token might not be attested.");
  }

  // Update the swap rate.
  const receipt = await relayerContract
    .updateSwapRate(chainId, localTokenAddress, swapRate, {gasLimit: 50_000})
    .then((tx: ethers.ContractTransaction) => tx.wait())
    .catch((msg: any) => {
      // should not happen
      console.log(msg);
      return null;
    });
  if (receipt !== null) {
    console.log(
      `Swap rate updated to ${swapRate} for chain: ${chainId}, hash: ${receipt.transactionHash}`
    );
  } else {
    console.log("\n");
    console.log(`Failed to update the swap rate: ${chainId}`);
    console.log("\n");
  }
}

interface Config {
  chain: ChainId;
  relayer: string;
  bridge: string;
  rpc: string;
}

function createConfig(object: any) {
  let config = [] as Config[];

  for (let key of Object.keys(object)) {
    let member = {
      chain: Number(key) as ChainId,
      relayer: object[key]["relayer"] as string,
      bridge: object[key]["bridge"] as string,
      rpc: object[key]["rpc"] as string,
    };
    config.push(member);
  }

  return config;
}

async function main() {
  // Fetch args.
  const args = getArgs();

  // Read in config file.
  const deploymentConfig = JSON.parse(
    fs.readFileSync(`${__dirname}/addresses.json`, "utf8")
  );

  // Convert to Config type.
  const config = createConfig(deploymentConfig["deployedContracts"]);

  if (config.length == undefined) {
    throw Error("Deployed contracts not found");
  }

  // Update sui.
  await update_swap_rate_on_sui(args.swapRate);

  //   Loop through RPC connections and set the swap rate.
  for (const info of config) {
    await update_swap_rate_on_eth(
      info.chain,
      info.rpc,
      ethers.utils.getAddress(info.relayer),
      ethers.utils.getAddress(info.bridge),
      args.swapRate
    );
  }
}

main();
