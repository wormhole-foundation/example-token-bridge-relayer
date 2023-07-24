import { ethers } from "ethers";
import { RELEASE_CHAIN_ID, RELEASE_RPC } from "./consts";
import { tryHexToNativeString } from "@certusone/wormhole-sdk";
import { ITokenBridgeRelayer__factory, ITokenBridgeRelayer } from "../src/ethers-contracts";
import * as fs from "fs";
import { Config, isOperatingChain, parseArgs } from "./config";
import { getSigner } from "./signer";
import { Check, TxResult, buildOverrides, executeChecks, handleFailure } from "./tx";

async function confirmOwnership(relayer: ITokenBridgeRelayer): Promise<TxResult> {
  const overrides = await buildOverrides(
    () => relayer.estimateGas.confirmOwnershipTransferRequest(),
    RELEASE_CHAIN_ID
  );

  const tx = await relayer.confirmOwnershipTransferRequest(overrides);
  console.log(`Confirm ownership transfer tx sent txHash=${tx.hash}`);
  const receipt = await tx.wait();

  const successMessage = `Success: Confirmed ownership transfer txHash=${receipt.transactionHash}`;
  const failureMessage = `Failed to confirm ownership transfer`;
  return TxResult.create(receipt, successMessage, failureMessage, async () => {
    const owner = await relayer.owner();
    return owner === (await relayer.signer.getAddress());
  });
}

async function main() {
  const args = await parseArgs();
  const { deployedContracts: contracts } = JSON.parse(
    fs.readFileSync(args.config, "utf8")
  ) as Config;

  if (!isOperatingChain(RELEASE_CHAIN_ID)) {
    throw new Error(`Transaction signing unsupported for wormhole chain id ${RELEASE_CHAIN_ID}`);
  }

  // setup ethers wallet
  const provider = new ethers.providers.StaticJsonRpcProvider(RELEASE_RPC);
  const wallet = await getSigner(args, provider);

  // fetch relayer address from config
  const relayerAddress = tryHexToNativeString(contracts[RELEASE_CHAIN_ID], RELEASE_CHAIN_ID);

  // setup relayer contract
  const relayer = ITokenBridgeRelayer__factory.connect(relayerAddress, wallet);

  const checks: Check[] = [];
  const result = await confirmOwnership(relayer);
  handleFailure(checks, result);

  const messages = await executeChecks(checks);
  console.log(messages);
}

main();
