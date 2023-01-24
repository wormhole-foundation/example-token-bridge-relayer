import {
  CHAIN_ID_AVAX,
  CHAIN_ID_ETH,
  coalesceChainName,
  getEmitterAddressEth,
  getSignedVAAWithRetry,
  uint8ArrayToHex,
  tryUint8ArrayToNative,
  CHAIN_ID_BSC,
  CHAIN_ID_FANTOM,
  CHAIN_ID_CELO,
  CHAIN_ID_POLYGON,
  ChainId,
  tryNativeToHexString,
} from "@certusone/wormhole-sdk";
import {
  Implementation__factory,
  ITokenBridge__factory,
  IERC20Metadata__factory,
} from "@certusone/wormhole-sdk/lib/cjs/ethers-contracts";
import {TypedEvent} from "@certusone/wormhole-sdk/lib/cjs/ethers-contracts/commons";
import {Contract, ethers, Wallet} from "ethers";
import {WebSocketProvider} from "./websocket";
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

function getRpc(rpcEvnVariable: any): WebSocketProvider {
  const rpc = rpcEvnVariable;
  if (!rpc || !rpc.startsWith("ws")) {
    console.error("RPC is required and must be a websocket!");
    process.exit(1);
  }
  const websocket = new WebSocketProvider(rpc);
  return websocket;
}

// read in config
const configPath = `${__dirname}/../../cfg/tokenBridgeRelayer.json`;
const CONFIG = JSON.parse(fs.readFileSync(configPath, "utf8"));

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
  [CHAIN_ID_ETH]: new Wallet(PK, getRpc(process.env.ETH_RPC)),
  [CHAIN_ID_AVAX]: new Wallet(PK, getRpc(process.env.AVAX_RPC)),
  [CHAIN_ID_BSC]: new Wallet(PK, getRpc(process.env.BSC_RPC)),
  [CHAIN_ID_FANTOM]: new Wallet(PK, getRpc(process.env.FTM_RPC)),
  [CHAIN_ID_CELO]: new Wallet(PK, getRpc(process.env.CELO_RPC)),
  [CHAIN_ID_POLYGON]: new Wallet(PK, getRpc(process.env.POLYGON_RPC)),
};

// testnet guardian host
const WORMHOLE_RPC_HOSTS = ["https://wormhole-v2-testnet-api.certus.one"];

async function sleep(timeout: number) {
  return new Promise((resolve) => setTimeout(resolve, timeout));
}

function wormholeContract(
  address: string,
  signer: ethers.Signer
): ethers.Contract {
  return Implementation__factory.connect(address, signer);
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
      "function completeTransferWithRelay(bytes) payable",
      "function calculateNativeSwapAmountOut(address,uint256) view returns (uint256)",
      "function maxNativeSwapAmount(address) view returns (uint256)",
      "function WETH() view returns (address)",
    ],
    signer
  );
  return contract;
}

async function getLocalTokenAddress(
  chainId: SupportedChainId,
  tokenAddress: string,
  tokenChain: number
): Promise<string> {
  const tokenBridge = tokenBridgeContract(
    CONFIG[chainId.toString()].bridge,
    SIGNERS[chainId]
  );

  let localTokenAddress;
  if (tokenChain == chainId) {
    localTokenAddress = tokenAddress;
  } else {
    localTokenAddress = await tokenBridge.wrappedAsset(
      tokenChain,
      "0x" + tryNativeToHexString(tokenAddress, tokenChain as ChainId)
    );
  }

  return localTokenAddress;
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

function getBridgeChainId(config: any, sender: string): ChainId | null {
  let senderChainId: ChainId | null = null;
  for (const chainIdString of Object.keys(config)) {
    const bridgeAddress = ethers.utils.getAddress(sender);
    const configBridgeAddress = ethers.utils.getAddress(
      config[chainIdString].bridge
    );

    if (configBridgeAddress == bridgeAddress) {
      senderChainId = Number(chainIdString) as ChainId;
    }
  }

  return senderChainId;
}

function handleRelayerEvent(
  _sender: string,
  sequence: ethers.BigNumber,
  _nonce: number,
  payload: string,
  _consistencyLevel: number,
  typedEvent: TypedEvent<
    [string, ethers.BigNumber, number, string, number] & {
      sender: string;
      sequence: ethers.BigNumber;
      nonce: number;
      payload: string;
      consistencyLevel: number;
    }
  >
) {
  console.log(`Parsing transaction: ${typedEvent.transactionHash}`);
  (async () => {
    try {
      // create payload buffer
      const payloadArray = Buffer.from(ethers.utils.arrayify(payload));

      // confirm that it's a payload3
      const payloadType = payloadArray.readUint8(0);
      if (payloadType != 3) {
        return;
      }

      // parse to chain/address from the payload
      const toChain = payloadArray.readUInt16BE(99);
      const toAddress = tryUint8ArrayToNative(
        payloadArray.subarray(67, 99),
        toChain as ChainId
      );

      // confirm the destination is a relayer contract
      if (
        ethers.utils.getAddress(toAddress) !=
        ethers.utils.getAddress(CONFIG[toChain.toString()].relayer)
      ) {
        console.warn(
          `Unknown target contract: ${toAddress} for chainId: ${toChain}, terminating relay`
        );
        return;
      }

      // fetch the chainId from the sender name and parse the fromAddress from the payload
      const fromChain = getBridgeChainId(CONFIG, _sender)!;
      const fromAddress = tryUint8ArrayToNative(
        payloadArray.subarray(101, 133),
        fromChain as ChainId
      );

      // confirm the sender is a relayer contract
      if (
        ethers.utils.getAddress(fromAddress) !=
        ethers.utils.getAddress(CONFIG[fromChain.toString()].relayer)
      ) {
        console.warn(
          `Unknown sender: ${fromAddress} for chainId: ${fromChain}, terminating relay`
        );
        return;
      }

      // confirm we were able to get the chainId
      if (fromChain === null) {
        console.warn(`Unable to fetch chainId from sender address: ${_sender}`);
        return;
      }

      // now fetch and parse the wormhole payload
      console.log(
        `Fetching Wormhole message from: ${_sender}, chainId: ${fromChain}`
      );
      const {vaaBytes} = await getSignedVAAWithRetry(
        WORMHOLE_RPC_HOSTS,
        fromChain,
        getEmitterAddressEth(_sender),
        sequence.toString()
      );

      // Parse the token address and find the accepted token
      // address on the target chain.
      const tokenChain = payloadArray.readUInt16BE(65);
      const tokenAddress = tryUint8ArrayToNative(
        payloadArray.subarray(33, 65),
        toChain as ChainId
      );

      // fetch the local token address on the target chain
      const localTokenAddress = await getLocalTokenAddress(
        toChain as SupportedChainId,
        tokenAddress,
        tokenChain
      );

      // fetch the token decimals
      const erc20Meta = IERC20Metadata__factory.connect(
        localTokenAddress,
        SIGNERS[toChain as SupportedChainId]
      );
      const tokenDecimals = await erc20Meta.decimals();

      // parse toNativeSwapAmount from payload and denormalize the value
      const toNativeAmount = ethers.utils.hexlify(
        payloadArray.subarray(166, 198)
      );
      const denormalizedToNativeAmount = tokenBridgeDenormalizeAmount(
        ethers.BigNumber.from(toNativeAmount),
        tokenDecimals
      );
      console.log(
        `Relaying Wormhole message to: ${
          CONFIG[toChain.toString()].relayer
        }, chainId: ${toChain}`
      );

      // create relayer contract instance
      const relayer = relayerContract(
        CONFIG[toChain.toString()].relayer,
        SIGNERS[toChain as SupportedChainId]
      );

      // fetch weth address from the contract
      const targetWethAddress = await relayer.WETH();

      // determine how much native asset to supply to the relayer contract
      let nativeSwapQuote: ethers.BigNumber;
      if (
        ethers.utils.getAddress(targetWethAddress) ===
        ethers.utils.getAddress(localTokenAddress)
      ) {
        console.log("WETH transfer detected, setting nativeSwapQuote to zero.");
        nativeSwapQuote = ethers.BigNumber.from("0");
      } else {
        nativeSwapQuote = await relayer.calculateNativeSwapAmountOut(
          localTokenAddress,
          denormalizedToNativeAmount
        );

        // Fetch the max native swap amount from the contract. Override
        // the nativeSwapQuote with the max if the maxNativeSwapAllowed
        // is less than the nativeSwapQuote. This will reduce the cost
        // of the transaction.
        const maxNativeSwapAllowed = await relayer.maxNativeSwapAmount(
          localTokenAddress
        );
        if (maxNativeSwapAllowed.lt(nativeSwapQuote)) {
          nativeSwapQuote = maxNativeSwapAllowed;
        }
      }

      console.log(
        `Native amount to swap with contract: ${ethers.utils.formatEther(
          nativeSwapQuote
        )}`
      );

      // redeem the transfer on the target chain
      try {
        const tx: ethers.ContractTransaction =
          await relayer.completeTransferWithRelay(
            `0x${uint8ArrayToHex(vaaBytes)}`,
            {
              value: nativeSwapQuote,
            }
          );
        const redeedReceipt: ethers.ContractReceipt = await tx.wait();

        console.log(
          `Redeemed transfer in txhash: ${redeedReceipt.transactionHash}`
        );
      } catch (e) {
        console.error(e);
      }
    } catch (e) {
      console.error(e);
    }
  })();
}

function subscribeToEvents(
  wormhole: ethers.Contract,
  chainId: SupportedChainId
) {
  const chainName = coalesceChainName(chainId);
  const sender = CONFIG[chainId.toString()].bridge;
  if (!wormhole.address) {
    console.error("No known core contract for chain", chainName);
    process.exit(1);
  }

  // unsubscribe and resubscribe to reset websocket connection
  wormhole.off(
    wormhole.filters.LogMessagePublished(sender),
    handleRelayerEvent
  );
  wormhole.on(wormhole.filters.LogMessagePublished(sender), handleRelayerEvent);
  console.log(
    `Subscribed to: ${chainName}, core contract: ${wormhole.address}`
  );
}

async function main() {
  // resubscribe to contract events every 5 minutes
  for (const chainId of SUPPORTED_CHAINS) {
    try {
      subscribeToEvents(
        wormholeContract(CONFIG[chainId.toString()].wormhole, SIGNERS[chainId]),
        chainId
      );
    } catch (e: any) {
      console.log(e);
    }
  }
}

// start the process
main();
