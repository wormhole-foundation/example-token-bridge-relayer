import { ethers } from "ethers";
import { RELEASE_CHAIN_ID, RELEASE_RPC } from "./consts";
import { TokenBridgeRelayer__factory } from "../src/ethers-contracts";
import * as fs from "fs";
import { Config, isOperatingChain, parseArgs } from "./config";
import { getSigner } from "./signer";
import { Check, TxResult, buildOverrides, executeChecks, handleFailure } from "./tx";

async function deployContract(
  wallet: ethers.Signer,
  tokenBridgeAddress: string,
  wethAddress: string,
  feeRecipient: string,
  ownerAssistant: string,
  unwrapWeth: boolean,
): Promise<TxResult> {
  const relayerFactory = new TokenBridgeRelayer__factory(wallet);
  

  const overrides = await buildOverrides(
    () => {
      const deployTx = relayerFactory.getDeployTransaction(tokenBridgeAddress, wethAddress, feeRecipient, ownerAssistant, unwrapWeth);
      return wallet.estimateGas(deployTx);
    },
    RELEASE_CHAIN_ID
  );

  const relayer = await relayerFactory.deploy(tokenBridgeAddress, wethAddress, feeRecipient, ownerAssistant, unwrapWeth, overrides);
  console.log(`Deploy tx sent chainId=${RELEASE_CHAIN_ID}, txHash=${relayer.deployTransaction.hash}`);
  console.log(`Contract address: ${relayer.address}`);
  const receipt = await relayer.deployTransaction.wait();

  const successMessage = `Deployed chainId=${RELEASE_CHAIN_ID}, txHash=${receipt.transactionHash}`;
  const failureMessage = `Failed to deploy chain=${RELEASE_CHAIN_ID}`;
  return TxResult.create(receipt, successMessage, failureMessage, async () => true);
}

async function main() {
  const args = await parseArgs();

  if (!isOperatingChain(RELEASE_CHAIN_ID)) {
    throw new Error(`Transaction signing unsupported for wormhole chain id ${RELEASE_CHAIN_ID}`);
  }

  const { deployedContracts: contracts } = JSON.parse(
    fs.readFileSync(args.config, "utf8")
  ) as Config;
  const relayerAddress = contracts[RELEASE_CHAIN_ID];
  if (relayerAddress !== undefined) {
    throw new Error(`TokenBridgeRelayer contract is already deployed at address ${relayerAddress} in chain ${RELEASE_CHAIN_ID}`);
  }

  const tokenBridgeAddress = process.env.RELEASE_BRIDGE_ADDRESS;
  if (tokenBridgeAddress === undefined || !ethers.utils.isAddress(tokenBridgeAddress)) {
    throw new Error(`The token bridge address for chain ${RELEASE_CHAIN_ID} needs to be set in the RELEASE_BRIDGE_ADDRESS environment variable.
Value found: ${tokenBridgeAddress}`);
  }

  const wethAddress = process.env.RELEASE_WETH_ADDRESS;
  if (wethAddress === undefined || !ethers.utils.isAddress(wethAddress)) {
    throw new Error(`The WETH address for chain ${RELEASE_CHAIN_ID} needs to be set in the RELEASE_BRIDGE_ADDRESS environment variable.
Value found: ${wethAddress}`);
  }

  const feeRecipient = process.env.RELEASE_FEE_RECIPIENT;
  if (feeRecipient === undefined || !ethers.utils.isAddress(feeRecipient)) {
    throw new Error(`The fee recipient address for chain ${RELEASE_CHAIN_ID} needs to be set in the RELEASE_BRIDGE_ADDRESS environment variable.
Value found: ${feeRecipient}`);
  }

  const ownerAssistant = process.env.RELEASE_OWNER_ASSISTANT;
  if (ownerAssistant === undefined || !ethers.utils.isAddress(ownerAssistant)) {
    throw new Error(`The owner assistant address for chain ${RELEASE_CHAIN_ID} needs to be set in the RELEASE_BRIDGE_ADDRESS environment variable.
Value found: ${ownerAssistant}`);
  }

  const shouldUnwrapWeth = JSON.parse(process.env.RELEASE_UNWRAP_WETH ?? "");
  if (typeof shouldUnwrapWeth !== "boolean") {
    throw new Error(`The unwrapWeth flag needs to be set in the RELEASE_UNWRAP_WETH environment variable to either 'true' or 'false'.
Value found: ${shouldUnwrapWeth}`);
  }

  const provider = new ethers.providers.StaticJsonRpcProvider(RELEASE_RPC);
  const wallet = await getSigner(args, provider);

  const checks: Check[] = [];

  const result = await deployContract(wallet, tokenBridgeAddress, wethAddress, feeRecipient, ownerAssistant, shouldUnwrapWeth);

  handleFailure(checks, result);

  const messages = await executeChecks(checks);
  console.log(messages);
}

main();
