import { ethers } from "ethers";
import { RELEASE_CHAIN_ID, RELEASE_RPC } from "./consts";
import { tryHexToNativeString } from "@certusone/wormhole-sdk";
import { ITokenBridgeRelayer__factory, ITokenBridgeRelayer } from "../src/ethers-contracts";
import * as fs from "fs";
import { Config, ConfigArguments, isOperatingChain, configArgsParser } from "./config";
import { SignerArguments, addSignerArgsParser, getSigner } from "./signer";
import { Check, TxResult, buildOverrides, executeChecks, handleFailure } from "./tx";

interface CustomArguments {
  newOwner: string;
}

type Arguments = CustomArguments & SignerArguments & ConfigArguments;

async function parseArgs(): Promise<Arguments> {
  const parsed = await addSignerArgsParser(configArgsParser()).option("newOwner", {
    string: true,
    boolean: false,
    description: "ownership transfer will be initiated with this address",
    required: true,
  }).argv;

  const args: Arguments = {
    newOwner: parsed.newOwner,
    useLedger: parsed.ledger,
    derivationPath: parsed.derivationPath,
    config: parsed.config,
  };

  return args;
}

async function transferOwnership(
  relayer: ITokenBridgeRelayer,
  newOwner: string
): Promise<TxResult> {
  const overrides = await buildOverrides(
    () => relayer.estimateGas.submitOwnershipTransferRequest(RELEASE_CHAIN_ID, newOwner),
    RELEASE_CHAIN_ID
  );

  const tx = await relayer.submitOwnershipTransferRequest(RELEASE_CHAIN_ID, newOwner, overrides);
  console.log(`Ownership transfer request tx sent txHash=${tx.hash}`);
  const receipt = await tx.wait();

  const successMessage = `Success: ownership transfer request tx succeeded txHash=${receipt.transactionHash}`;
  const failureMessage = `Failed to submit ownership transfer request`;
  return TxResult.create(receipt, successMessage, failureMessage, async () => {
    const pendingOwner = await relayer.pendingOwner();
    return pendingOwner === newOwner;
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
  if (!ethers.utils.isAddress(args.newOwner)) {
    throw new Error(`Invalid EVM address for new owner: ${args.newOwner}`);
  }

  // setup ethers wallet
  const provider = new ethers.providers.StaticJsonRpcProvider(RELEASE_RPC);
  const wallet = await getSigner(args, provider);

  // fetch relayer address from config
  const relayerAddress = tryHexToNativeString(contracts[RELEASE_CHAIN_ID], RELEASE_CHAIN_ID);

  // setup relayer contract
  const relayer = ITokenBridgeRelayer__factory.connect(relayerAddress, wallet);

  const checks: Check[] = [];
  const result = await transferOwnership(relayer, args.newOwner);
  handleFailure(checks, result);

  const messages = await executeChecks(checks);
  console.log(messages);
}

main();
