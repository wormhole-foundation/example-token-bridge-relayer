import { ethers } from "ethers";
import { RELEASE_CHAIN_ID, RELEASE_RPC } from "./consts";
import { tryHexToNativeString } from "@certusone/wormhole-sdk";
import { ITokenBridgeRelayer__factory, ITokenBridgeRelayer } from "../src/ethers-contracts";
import * as fs from "fs";
import { Config, SupportedChainId, isChain, isOperatingChain, parseArgs } from "./config";
import { getSigner } from "./signer";
import { Check, TxResult, buildOverrides, executeChecks, handleFailure } from "./tx";

async function updateRelayerFee(
  relayer: ITokenBridgeRelayer,
  chainId: SupportedChainId,
  relayerFee: string
): Promise<TxResult> {
  const relayerFeeToUpdate = ethers.BigNumber.from(relayerFee);
  const currentFee = await relayer.relayerFee(chainId);
  if (currentFee.eq(relayerFee)) {
    console.log(`Relayer fee for chainId=${chainId} already set to fee=${relayerFee}`);
    return TxResult.Success("");
  }

  const overrides = await buildOverrides(
    () => relayer.estimateGas.updateRelayerFee(chainId, relayerFeeToUpdate),
    RELEASE_CHAIN_ID
  );

  const tx = await relayer.updateRelayerFee(chainId, relayerFeeToUpdate, overrides);
  console.log(
    `Relayer fee update tx sent for chainId=${chainId}, fee=${relayerFee}, txHash=${tx.hash}`
  );
  const receipt = await tx.wait();

  const successMessage = `Relayer fee updated for chainId=${chainId}, fee=${relayerFee}, txHash=${receipt.transactionHash}`;
  const failureMessage = `Failed to update relayer fee for chainId=${chainId}`;
  return TxResult.create(receipt, successMessage, failureMessage, async () => {
    // query the contract and see if the relayer fee was set properly
    const relayerFeeInContract = await relayer.relayerFee(chainId);
    return relayerFeeInContract.eq(relayerFeeToUpdate);
  });
}

async function main() {
  const args = await parseArgs();
  const { deployedContracts: contracts, relayerFeesInUsd: relayerFees } = JSON.parse(
    fs.readFileSync(args.config, "utf8")
  ) as Config;

  if (!isOperatingChain(RELEASE_CHAIN_ID)) {
    throw new Error(`Transaction signing unsupported for wormhole chain id ${RELEASE_CHAIN_ID}`);
  }

  const provider = new ethers.providers.StaticJsonRpcProvider(RELEASE_RPC);
  const wallet = await getSigner(args, provider);

  // fetch relayer address from config
  const relayerAddress = tryHexToNativeString(contracts[RELEASE_CHAIN_ID], RELEASE_CHAIN_ID);

  // set up relayer contract
  const relayer = ITokenBridgeRelayer__factory.connect(relayerAddress, wallet);

  const checks: Check[] = [];
  for (const [chainId_, fee] of Object.entries(relayerFees)) {
    // skip this chain
    const chainIdToRegister = Number(chainId_);
    if (!isChain(chainIdToRegister)) {
      throw new Error(`Unknown wormhole chain id ${chainIdToRegister}`);
    }
    if (chainIdToRegister === RELEASE_CHAIN_ID) {
      continue;
    }

    const result = await updateRelayerFee(relayer, chainIdToRegister, fee);
    handleFailure(checks, result);
  }

  const messages = await executeChecks(checks);
  console.log(messages);
}

main();
