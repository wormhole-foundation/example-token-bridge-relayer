import {ethers} from "ethers";
import {
  RELEASE_CHAIN_ID,
  RELEASE_RPC,
  WALLET_PRIVATE_KEY,
  RELEASE_BRIDGE_ADDRESS,
  ZERO_ADDRESS,
} from "./consts";
import {
  tryHexToNativeString,
  ChainId,
  tryUint8ArrayToNative,
} from "@certusone/wormhole-sdk";
import {
  ITokenBridgeRelayer__factory,
  ITokenBridge__factory,
} from "../src/ethers-contracts";
import * as fs from "fs";
import yargs from "yargs";

interface Arguments {
  setSwapRates: boolean;
  setMaxNativeAmounts: boolean;
}

// parsed command-line arguments
function parseArgs(): Arguments {
  const parsed: any = yargs(process.argv.slice(1))
    .option("setSwapRates", {
      string: false,
      boolean: true,
      description: "sets swaps rates if true",
      required: true,
    })
    .option("setMaxNativeAmount", {
      string: false,
      boolean: true,
      description: "sets max native swap amounts if true",
      required: true,
    })
    .help("h")
    .alias("h", "help").argv;

  const args: Arguments = {
    setSwapRates: parsed.setSwapRates,
    setMaxNativeAmounts: parsed.setMaxNativeAmount,
  };

  return args;
}

async function registerToken(
  relayer: ethers.Contract,
  chainId: Number,
  contract: ethers.BytesLike
): Promise<boolean> {
  let result: boolean = false;

  // register the token
  let receipt: ethers.ContractReceipt;
  try {
    receipt = await relayer
      .registerToken(RELEASE_CHAIN_ID, contract)
      .then((tx: ethers.ContractTransaction) => tx.wait())
      .catch((msg: any) => {
        // should not happen
        console.log(msg);
        return null;
      });
    console.log(
      `Token registered for chainId=${chainId}, token=${contract}, txHash=${receipt.transactionHash}`
    );
  } catch (e: any) {
    console.log(e);
  }

  // query the contract and see if the token was registered successfully
  const isAcceptedToken: ethers.BytesLike = await relayer.isAcceptedToken(
    contract
  );
  if (isAcceptedToken) {
    result = true;
  }

  return result;
}

async function updateSwapRate(
  relayer: ethers.Contract,
  chainId: number,
  contract: ethers.BytesLike,
  swapRate: string
): Promise<boolean> {
  let result: boolean = false;

  // convert swap rate into BigNumber
  const swapRateToUpdate = ethers.BigNumber.from(swapRate);

  // register the emitter
  let receipt: ethers.ContractReceipt;
  try {
    receipt = await relayer
      .updateSwapRate(RELEASE_CHAIN_ID, contract, swapRateToUpdate)
      .then((tx: ethers.ContractTransaction) => tx.wait())
      .catch((msg: any) => {
        // should not happen
        console.log(msg);
        return null;
      });
    console.log(
      `Token swapRate updated for chainId=${chainId}, token=${contract}, swapRate=${swapRate}, txHash=${receipt.transactionHash}`
    );
  } catch (e: any) {
    console.log(e);
  }

  // query the contract and see if the token swap rate was set properly
  const swapRateInContract: ethers.BigNumber = await relayer.swapRate(contract);
  if (swapRateInContract.eq(swapRateToUpdate)) {
    result = true;
  }

  return result;
}

async function updateMaxNativeSwapAmount(
  relayer: ethers.Contract,
  chainId: number,
  contract: ethers.BytesLike,
  maxNativeSwapAmount: string
): Promise<boolean> {
  let result: boolean = false;

  // convert max native into BigNumber
  const maxNativeToUpdate = ethers.BigNumber.from(maxNativeSwapAmount);

  // set the max native swap amount
  let receipt: ethers.ContractReceipt;
  try {
    receipt = await relayer
      .updateMaxNativeSwapAmount(RELEASE_CHAIN_ID, contract, maxNativeToUpdate)
      .then((tx: ethers.ContractTransaction) => tx.wait())
      .catch((msg: any) => {
        // should not happen
        console.log(msg);
        return null;
      });
    console.log(
      `Native swap amount updated for chainId=${chainId}, token=${contract}, max=${maxNativeSwapAmount}, txHash=${receipt.transactionHash}`
    );
  } catch (e: any) {
    console.log(e);
  }

  // query the contract and see if the max native swap amount was set correctly
  const maxNativeInContract: ethers.BigNumber =
    await relayer.maxNativeSwapAmount(contract);

  if (maxNativeInContract.eq(maxNativeToUpdate)) {
    result = true;
  }

  return result;
}

async function main() {
  const args = parseArgs();

  // read config
  const configPath = `${__dirname}/../../../cfg/deploymentConfig.json`;
  const relayerConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const contracts = relayerConfig["deployedContracts"];
  const tokenConfig = relayerConfig["acceptedTokensList"];
  const maxNativeSwapAmounts = relayerConfig["maxNativeSwapAmount"];

  // set up ethers wallet
  const provider = new ethers.providers.StaticJsonRpcProvider(RELEASE_RPC);
  const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

  // fetch relayer address from config
  const relayerAddress = tryHexToNativeString(
    contracts[RELEASE_CHAIN_ID.toString()],
    RELEASE_CHAIN_ID as ChainId
  );

  // set up relayer contract
  const relayer: ethers.Contract = ITokenBridgeRelayer__factory.connect(
    relayerAddress,
    wallet
  );

  // set up token bridge contract
  const tokenBridge: ethers.Contract = ITokenBridge__factory.connect(
    RELEASE_BRIDGE_ADDRESS,
    wallet
  );

  // loop through configured contracts and register tokens
  for (const chainIdString of Object.keys(tokenConfig)) {
    // chainId as a number
    const chainIdToRegister = Number(chainIdString);

    // array of tokens to register
    const tokens = tokenConfig[chainIdString];

    // loop through tokens and register them
    for (const tokenConfig of tokens) {
      const tokenContract = tokenConfig["contract"];

      // format the token address
      const formattedAddress = ethers.utils.arrayify("0x" + tokenContract);

      // fetch the wrapped of native address
      let localTokenAddress: string;
      if (chainIdToRegister == RELEASE_CHAIN_ID) {
        localTokenAddress = tryUint8ArrayToNative(
          formattedAddress,
          chainIdToRegister as ChainId
        );
      } else {
        // fetch the wrapped address
        localTokenAddress = await tokenBridge.wrappedAsset(
          chainIdToRegister,
          formattedAddress
        );
        if (localTokenAddress == ZERO_ADDRESS) {
          console.log(
            `Token not attested: chainId=${chainIdString}, token=${tokenContract}`
          );
          continue;
        }
      }

      // Query the contract and see if the token has been registered. If it hasn't,
      // register the token.
      const isTokenRegistered: ethers.BytesLike = await relayer.isAcceptedToken(
        localTokenAddress
      );
      if (!isTokenRegistered) {
        // register the token
        const result: boolean = await registerToken(
          relayer,
          chainIdToRegister,
          localTokenAddress
        );

        if (result === false) {
          console.log(`Failed to register chainId=${chainIdToRegister}`);
        }
      }

      // set the token -> USD swap rate
      if (args.setSwapRates) {
        const result: boolean = await updateSwapRate(
          relayer,
          chainIdToRegister,
          localTokenAddress,
          tokenConfig["swapRate"]
        );

        if (result === false) {
          console.log(
            `Failed to update swap rates: chainId=${chainIdToRegister}, token=${tokenContract}`
          );
        }
      }

      // set max native swap amount for each token
      if (args.setMaxNativeAmounts) {
        const result: boolean = await updateMaxNativeSwapAmount(
          relayer,
          chainIdToRegister,
          localTokenAddress,
          maxNativeSwapAmounts[RELEASE_CHAIN_ID]
        );

        if (result === false) {
          console.log(
            `Failed to update max native swap amount: chainId=${chainIdToRegister}, token=${tokenContract}`
          );
        }
      }

      console.log(await relayer.getAcceptedTokensList());
    }
  }
}

main();
