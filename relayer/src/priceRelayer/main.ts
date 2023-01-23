import {
  CHAIN_ID_ETH,
  CHAIN_ID_AVAX,
  CHAIN_ID_BSC,
  CHAIN_ID_FANTOM,
  CHAIN_ID_POLYGON,
  CHAIN_ID_CELO,
  tryUint8ArrayToNative,
} from "@certusone/wormhole-sdk";
import {Contract, ethers, Wallet} from "ethers";
import {PriceConfig, readPriceConfig, RelayerConfig} from "./config";
import {ITokenBridge__factory} from "@certusone/wormhole-sdk/lib/cjs/ethers-contracts";
const axios = require("axios"); // import breaks
import * as fs from "fs";

require("dotenv").config();

const strip0x = (str: string) =>
  str.startsWith("0x") ? str.substring(2) : str;

// shared EVM private key
const ethKey = process.env.ETH_KEY;
if (!ethKey) {
  console.error("ETH_KEY is required!");
  process.exit(1);
}
const PK = new Uint8Array(Buffer.from(strip0x(ethKey), "hex"));

function getRpc(rpcEvnVariable: any): ethers.providers.JsonRpcProvider {
  const rpc = rpcEvnVariable;
  if (!rpc || !rpc.startsWith("https")) {
    console.error("ETH_RPC required!");
    process.exit(1);
  }
  const provider = new ethers.providers.JsonRpcProvider(rpc);
  return provider;
}

// zero address
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// supported chains
const SUPPORTED_CHAINS = [
  CHAIN_ID_ETH,
  CHAIN_ID_AVAX,
  CHAIN_ID_BSC,
  CHAIN_ID_FANTOM,
  CHAIN_ID_CELO,
  CHAIN_ID_POLYGON,
];
type SupportedChainId = typeof SUPPORTED_CHAINS[number];

// signers
const SIGNERS = {
  [CHAIN_ID_ETH]: new Wallet(PK, getRpc(process.env.ETH_RPC_HTTP)),
  [CHAIN_ID_AVAX]: new Wallet(PK, getRpc(process.env.AVAX_RPC_HTTP)),
  [CHAIN_ID_BSC]: new Wallet(PK, getRpc(process.env.BSC_RPC_HTTP)),
  [CHAIN_ID_FANTOM]: new Wallet(PK, getRpc(process.env.FTM_RPC_HTTP)),
  [CHAIN_ID_CELO]: new Wallet(PK, getRpc(process.env.CELO_RPC_HTTP)),
  [CHAIN_ID_POLYGON]: new Wallet(PK, getRpc(process.env.POLYGON_RPC_HTTP)),
};

async function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tokenBridgeContract(
  address: string,
  signer: ethers.Signer
): ethers.Contract {
  return ITokenBridge__factory.connect(address, signer);
}

function relayerContract(
  address: string,
  signer: ethers.Signer
): ethers.Contract {
  const contract = new Contract(
    address,
    [
      "function swapRate(address) public view returns (uint256)",
      "function updateSwapRate(uint16,address,uint256) public",
      "function swapRatePrecision() public view returns (uint256)",
    ],
    signer
  );
  return contract;
}

async function confirmPricePrecision(
  expectedPrecision: number,
  contractConfig: any
) {
  const pricePrecisionBN = ethers.utils.parseUnits("1", expectedPrecision);

  for (const chainId of SUPPORTED_CHAINS) {
    const relayer = relayerContract(
      contractConfig[chainId.toString()].relayer,
      SIGNERS[chainId]
    );

    // fetch the contracts swap rate precision
    const swapRatePrecision: ethers.BigNumber =
      await relayer.swapRatePrecision();
    console.log(swapRatePrecision, pricePrecisionBN);

    // compare it to the configured precision
    if (!swapRatePrecision.eq(pricePrecisionBN)) {
      console.error(
        `Swap Rate Precision does not match config chainId=${chainId}`
      );
      process.exit(1);
    }
  }
}

function createCoingeckoString(relayerConfig: PriceConfig): string {
  // cache variables from relayer config
  let uniqueIds: string[] = [];
  for (const config of relayerConfig.relayers) {
    if (!uniqueIds.includes(config.tokenId)) {
      uniqueIds.push(config.tokenId);
    }
  }
  return uniqueIds.join(",");
}

async function generateTokenMap(config: RelayerConfig[], contractConfig: any) {
  // native -> local token address
  const addressMap = new Map<SupportedChainId, Map<string, string>>();

  for (const chainId of SUPPORTED_CHAINS) {
    // instantiate token bridge contract
    const tokenBridge: ethers.Contract = tokenBridgeContract(
      contractConfig[chainId.toString()].bridge,
      SIGNERS[chainId]
    );

    const nativeToLocalTokenMap = new Map<string, string>();

    for (const tokenConfig of config) {
      const token = ethers.utils.arrayify("0x" + tokenConfig.tokenContract);
      const tokenChain = tokenConfig.chainId;

      // find the token address on each chain (wrapped or native)
      let localTokenAddress: string;
      if (tokenChain == chainId) {
        localTokenAddress = tryUint8ArrayToNative(token, tokenChain);
      } else {
        localTokenAddress = await tokenBridge.wrappedAsset(tokenChain, token);
      }

      // Exit if the relayer can't find the local token address. This means
      // the token is either not attested or not configured correctly.
      if (localTokenAddress == ZERO_ADDRESS) {
        console.error(
          `Failed to find localTokenAddress for chainId=${chainId}, token=${tokenConfig.tokenContract}`
        );
        process.exit(1);
      }
      nativeToLocalTokenMap.set(tokenConfig.tokenContract, localTokenAddress);
    }
    // add to mapping
    addressMap.set(chainId, nativeToLocalTokenMap);
  }
  return addressMap;
}

async function main() {
  // read price relayer config
  const configPath = `${__dirname}/../../cfg/priceRelayer.json`;
  const relayerConfig = readPriceConfig(configPath);

  // read smart contract config
  const contractConfigPath = `${__dirname}/../../cfg/tokenBridgeRelayer.json`;
  const contractConfig = JSON.parse(
    fs.readFileSync(contractConfigPath, "utf8")
  );

  // create coingeckoId string
  const coingeckoIds = createCoingeckoString(relayerConfig);
  console.log(`Coingecko Id string: ${coingeckoIds}`);

  // price update interval and percentage change
  const fetchPricesInterval = relayerConfig.fetchPricesInterval;
  console.log(`New price update interval: ${fetchPricesInterval}`);

  const minPriceChangePercentage = relayerConfig.updatePriceChangePercentage;
  console.log(
    `Price update minimum percentage change: ${minPriceChangePercentage}%`
  );

  // native -> local token address mapping per chain
  const nativeTokenMap = await generateTokenMap(
    relayerConfig.relayers,
    contractConfig
  );

  console.log("Relayer Config");
  console.log(relayerConfig);

  // confirm the price precision on each contract
  await confirmPricePrecision(relayerConfig.pricePrecision, contractConfig);

  // get er done
  while (true) {
    // fetch native and token prices
    const coingeckoPrices = await getCoingeckoPrices(coingeckoIds).catch(
      (_) => null
    );

    if (coingeckoPrices !== null) {
      try {
        // format price updates
        const priceUpdates = formatPriceUpdates(
          relayerConfig.relayers,
          coingeckoPrices,
          relayerConfig.pricePrecision
        );

        // update contract prices for each supported chain / token
        for (const supportedChainId of SUPPORTED_CHAINS) {
          // set up relayer contract
          const relayer = relayerContract(
            contractConfig[supportedChainId.toString()].relayer,
            SIGNERS[supportedChainId]
          );

          for (const config of relayerConfig.relayers) {
            // local token address
            const token = nativeTokenMap
              .get(supportedChainId)
              ?.get(config.tokenContract);
            const tokenId = config.tokenId;

            // query the contract to fetch the current native swap price
            const currentPrice: ethers.BigNumber = await relayer.swapRate(
              token
            );
            const newPrice = priceUpdates.get(tokenId)!;

            // compute percentage change
            const percentageChange =
              ((newPrice.toNumber() - currentPrice.toNumber()) /
                currentPrice.toNumber()) *
              100;

            console.log(
              `Price update, chainId: ${supportedChainId}, nativeAddress: ${config.tokenContract}, localTokenAddress: ${token}, currentPrice: ${currentPrice}, newPrice: ${newPrice}`
            );

            try {
              // update prices if they have changed by the minPriceChangePercentage
              if (Math.abs(percentageChange) > minPriceChangePercentage) {
                const receipt = await relayer
                  .updateSwapRate(supportedChainId, token, newPrice)
                  .then((tx: ethers.ContractTransaction) => tx.wait())
                  .catch((msg: any) => {
                    // should not happen
                    console.log(msg);
                    return null;
                  });
                if (receipt !== null) {
                  console.log(
                    `Updated native price on chainId: ${supportedChainId}, token: ${token}, txhash: ${receipt.transactionHash}`
                  );
                } else {
                  throw Error("Failed to update the swap rate");
                }
              }
            } catch (e) {
              console.error(e);
            }
          }
        }
      } catch (e) {
        console.error(e);
      }
    } else {
      console.error("Failed to fetch coingecko prices!");
    }
    await sleepFor(fetchPricesInterval);
  }
}

function formatPriceUpdates(
  relayerConfigs: RelayerConfig[],
  coingeckoPrices: any,
  pricePrecision: number
) {
  // price mapping
  const priceUpdates = new Map<string, ethers.BigNumber>();

  // loop through each config, compute conversion rates and save results
  for (let i = 0; i < relayerConfigs.length; ++i) {
    const config = relayerConfigs.at(i)!;
    const tokenId = config.tokenId;

    if (tokenId in coingeckoPrices) {
      // cache prices
      const tokenPrice = coingeckoPrices[tokenId].usd;

      // push native -> token swap rate
      priceUpdates.set(
        tokenId,
        ethers.utils.parseUnits(
          tokenPrice.toFixed(pricePrecision),
          pricePrecision
        )
      );
    }
  }
  return priceUpdates;
}

async function getCoingeckoPrices(coingeckoIds: string) {
  const {data, status} = await axios.get(
    `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoIds}&vs_currencies=usd`,
    {
      headers: {
        Accept: "application/json",
      },
    }
  );

  if (status != 200) {
    return Promise.reject("status != 200");
  }

  return data;
}

main();
