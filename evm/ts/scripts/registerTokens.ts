import { ethers } from "ethers";
import { RELEASE_CHAIN_ID, RELEASE_RPC, RELEASE_BRIDGE_ADDRESS, ZERO_ADDRESS } from "./consts";
import { tryHexToNativeString, tryUint8ArrayToNative } from "@certusone/wormhole-sdk";
import {
  ITokenBridge,
  ITokenBridgeRelayer,
  ITokenBridgeRelayer__factory,
  ITokenBridge__factory,
} from "../src/ethers-contracts";
import { SwapRateUpdate } from "../helpers/interfaces";
import * as fs from "fs";
import {
  Config,
  ConfigArguments,
  SupportedChainId,
  isChain,
  isOperatingChain,
  configArgsParser,
} from "./config";
import { SignerArguments, addSignerArgsParser, getSigner } from "./signer";
import { Check, TxResult, buildOverrides, executeChecks, handleFailure } from "./tx";

interface CustomArguments {
  setSwapRates: boolean;
  setMaxNativeAmounts: boolean;
}

type Arguments = CustomArguments & SignerArguments & ConfigArguments;

async function parseArgs(): Promise<Arguments> {
  const parsed = await addSignerArgsParser(configArgsParser())
    .option("setSwapRates", {
      string: false,
      boolean: true,
      description: "sets swap rates if true",
      required: true,
    })
    .option("setMaxNativeAmount", {
      string: false,
      boolean: true,
      description: "sets max native swap amounts if true",
      required: true,
    }).argv;

  const args: Arguments = {
    useLedger: parsed.ledger,
    derivationPath: parsed.derivationPath,
    config: parsed.config,
    setSwapRates: parsed.setSwapRates,
    setMaxNativeAmounts: parsed.setMaxNativeAmount,
  };

  return args;
}

async function registerToken(
  relayer: ITokenBridgeRelayer,
  chainId: SupportedChainId,
  token: string
): Promise<TxResult> {
  const isAccepted = await relayer.isAcceptedToken(token);
  if (isAccepted) {
    console.log(`Token already registered chainId=${chainId}, token=${token}`);
    return TxResult.Success("");
  }

  const overrides = await buildOverrides(
    () => relayer.estimateGas.registerToken(RELEASE_CHAIN_ID, token),
    RELEASE_CHAIN_ID
  );

  const tx = await relayer.registerToken(RELEASE_CHAIN_ID, token, overrides);
  console.log(`Token register tx sent, chainId=${chainId}, token=${token}, txHash=${tx.hash}`);
  const receipt = await tx.wait();

  const successMessage = `Success: token registered, chainId=${chainId}, token=${token}, txHash=${receipt.transactionHash}`;
  const failureMessage = `Failed: could not register token, chainId=${chainId}`;
  return TxResult.create(receipt, successMessage, failureMessage, () =>
    relayer.isAcceptedToken(token)
  );
}

async function updateSwapRate(
  relayer: ITokenBridgeRelayer,
  batch: SwapRateUpdate[]
): Promise<TxResult> {
  const overrides = await buildOverrides(
    () => relayer.estimateGas.updateSwapRate(RELEASE_CHAIN_ID, batch),
    RELEASE_CHAIN_ID
  );

  const tx = await relayer.updateSwapRate(RELEASE_CHAIN_ID, batch, overrides);
  console.log(`Swap rates update tx sent, txHash=${tx.hash}`);
  const receipt = await tx.wait();
  let successMessage = `Success: swap rates updated, txHash=${receipt.transactionHash}`;
  for (const update of batch) {
    successMessage += `  token: ${update.token}, swap rate: ${update.value.toString()}`;
  }
  const failureMessage = `Failed: could not update swap rates, txHash=${receipt.transactionHash}`;

  return TxResult.create(receipt, successMessage, failureMessage, async () => true);
}

async function updateMaxNativeSwapAmount(
  relayer: ITokenBridgeRelayer,
  chainId: SupportedChainId,
  token: string,
  originalTokenAddress: string,
  maxNativeSwapAmount: string
): Promise<TxResult> {
  const currentMaxNativeSwap = await relayer.maxNativeSwapAmount(token);
  if (currentMaxNativeSwap.eq(maxNativeSwapAmount)) {
    console.log(`Max swap amount already set for chainId=${chainId}, token=${token}`);
    return TxResult.Success("");
  }

  const maxNativeToUpdate = ethers.BigNumber.from(maxNativeSwapAmount);

  const overrides = await buildOverrides(
    () =>
      relayer.estimateGas.updateMaxNativeSwapAmount(RELEASE_CHAIN_ID, token, maxNativeToUpdate),
    RELEASE_CHAIN_ID
  );

  const tx = await relayer.updateMaxNativeSwapAmount(
    RELEASE_CHAIN_ID,
    token,
    maxNativeToUpdate,
    overrides
  );
  console.log(
    `Max swap amount update tx sent, chainId=${chainId}, token=${token}, max=${maxNativeSwapAmount}, txHash=${tx.hash}`
  );
  const receipt = await tx.wait();
  const successMessage = `Success: max swap amount updated, chainId=${chainId}, token=${token}, max=${maxNativeSwapAmount}, txHash=${receipt.transactionHash}`;
  const failureMessage = `Failed: could not update max native swap amount, chainId=${chainId}, token=${originalTokenAddress}`;

  return TxResult.create(receipt, successMessage, failureMessage, async () => {
    const maxNativeInContract = await relayer.maxNativeSwapAmount(token);
    return maxNativeInContract.eq(maxNativeToUpdate);
  });
}

async function getLocalTokenAddress(
  tokenBridge: ITokenBridge,
  chainId: number,
  tokenAddress: string
) {
  const buffer = ethers.utils.arrayify(tokenAddress);
  // fetch the wrapped of native address
  let localTokenAddress: string;
  if (chainId == RELEASE_CHAIN_ID) {
    localTokenAddress = tryUint8ArrayToNative(buffer, chainId);
  } else {
    // fetch the wrapped address
    localTokenAddress = await tokenBridge.wrappedAsset(chainId, buffer);
    if (localTokenAddress === ZERO_ADDRESS) {
      console.log(
        `Failed: token not attested, chainId=${chainId}, token=${Buffer.from(buffer).toString(
          "hex"
        )}`
      );
    }
  }

  return localTokenAddress;
}

async function main() {
  const args = await parseArgs();

  // read config
  const {
    deployedContracts: contracts,
    acceptedTokensList: tokenConfig,
    maxNativeSwapAmount: maxNativeSwapAmounts,
  } = JSON.parse(fs.readFileSync(args.config, "utf8")) as Config;

  if (!isOperatingChain(RELEASE_CHAIN_ID)) {
    throw new Error(`Transaction signing unsupported for wormhole chain id ${RELEASE_CHAIN_ID}`);
  }

  // set up ethers wallet
  const provider = new ethers.providers.StaticJsonRpcProvider(RELEASE_RPC);
  const wallet = await getSigner(args, provider);

  // fetch relayer address from config
  const relayerAddress = tryHexToNativeString(contracts[RELEASE_CHAIN_ID], RELEASE_CHAIN_ID);

  // set up relayer contract
  const relayer = ITokenBridgeRelayer__factory.connect(relayerAddress, wallet);

  // set up token bridge contract
  const tokenBridge = ITokenBridge__factory.connect(RELEASE_BRIDGE_ADDRESS, wallet);

  // placeholder for swap rate batch
  const swapRateUpdates: SwapRateUpdate[] = [];

  const checks: Check[] = [];
  for (const [chainIdString, tokens] of Object.entries(tokenConfig)) {
    const chainIdToRegister = Number(chainIdString);
    if (!isChain(chainIdToRegister)) {
      throw new Error(`Unknown wormhole chain id ${chainIdToRegister}`);
    }
    console.log("\n");
    console.log(`ChainId ${chainIdToRegister}`);

    // loop through tokens and register them
    for (const { contract: tokenContract, swapRate } of tokens) {
      const tokenAddress = "0x" + tokenContract;

      // fetch the address on the target chain
      const localTokenAddress = await getLocalTokenAddress(
        tokenBridge,
        chainIdToRegister,
        tokenAddress
      );

      // Query the contract and see if the token has been registered. If it hasn't,
      // register the token.
      const isTokenRegistered = await relayer.isAcceptedToken(localTokenAddress);
      if (!isTokenRegistered) {
        const result = await registerToken(relayer, chainIdToRegister, localTokenAddress);

        handleFailure(checks, result);
      } else {
        console.log(`Token already registered. token=${tokenAddress}`);
      }

      if (args.setMaxNativeAmounts) {
        const result = await updateMaxNativeSwapAmount(
          relayer,
          chainIdToRegister,
          localTokenAddress,
          tokenAddress,
          maxNativeSwapAmounts[RELEASE_CHAIN_ID]
        );

        handleFailure(checks, result);
      }

      if (args.setSwapRates) {
        swapRateUpdates.push({
          token: localTokenAddress,
          value: ethers.BigNumber.from(swapRate),
        });
      }
    }
  }

  if (args.setSwapRates) {
    console.log("\n");
    const result = await updateSwapRate(relayer, swapRateUpdates);
    handleFailure(checks, result);
  }

  const messages = await executeChecks(checks);
  console.log(messages);

  console.log("\n");
  console.log("Accepted tokens list:");
  console.log(await relayer.getAcceptedTokensList());
}

main();
