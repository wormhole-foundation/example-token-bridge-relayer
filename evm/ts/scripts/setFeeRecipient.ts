import { ethers } from "ethers";
import { RELEASE_CHAIN_ID, RELEASE_RPC } from "./consts";
import { tryHexToNativeString } from "@certusone/wormhole-sdk";
import { ITokenBridgeRelayer__factory, ITokenBridgeRelayer } from "../src/ethers-contracts";
import fs from "fs";
import { Config, ConfigArguments, isOperatingChain, configArgsParser } from "./config";
import { SignerArguments, addSignerArgsParser, getSigner } from "./signer";
import { Check, TxResult, buildOverrides, executeChecks, handleFailure } from "./tx";

interface CustomArguments {
  newFeeRecipient: string;
}

type Arguments = CustomArguments & SignerArguments & ConfigArguments;

async function parseArgs(): Promise<Arguments> {
  const parsed = await addSignerArgsParser(configArgsParser()).option("newFeeRecipient", {
    string: true,
    boolean: false,
    description: "fees will be received by this address",
    required: true,
  }).argv;

  const args: Arguments = {
    newFeeRecipient: parsed.newFeeRecipient,
    useLedger: parsed.ledger,
    derivationPath: parsed.derivationPath,
    config: parsed.config,
  };

  return args;
}

async function setFeeRecipient(
  relayer: ITokenBridgeRelayer,
  newFeeRecipient: string
): Promise<TxResult> {
  const currentFeeRecipient = await relayer.feeRecipient();
  if (currentFeeRecipient.toLowerCase() === newFeeRecipient.toLowerCase()) {
    return TxResult.Success(`Fee recipient already set to ${newFeeRecipient}`);
  }

  const overrides = await buildOverrides(
    () => relayer.estimateGas.updateFeeRecipient(RELEASE_CHAIN_ID, newFeeRecipient),
    RELEASE_CHAIN_ID
  );

  const tx = await relayer.updateFeeRecipient(RELEASE_CHAIN_ID, newFeeRecipient, overrides);
  console.log(`Fee recipient update tx sent txHash=${tx.hash}`);
  const receipt = await tx.wait();

  const successMessage = `Updated fee recipient txHash=${receipt.transactionHash}`;
  const failureMessage = `Failed to update fee recipient`;
  return TxResult.create(receipt, successMessage, failureMessage, async () => {
    const feeRecipient = await relayer.feeRecipient();
    return feeRecipient === newFeeRecipient;
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
  if (!ethers.utils.isAddress(args.newFeeRecipient)) {
    throw new Error(`Invalid EVM address for fee recipient: ${args.newFeeRecipient}`);
  }

  const provider = new ethers.providers.StaticJsonRpcProvider(RELEASE_RPC);
  const wallet = await getSigner(args, provider);

  const relayerAddress = tryHexToNativeString(contracts[RELEASE_CHAIN_ID], RELEASE_CHAIN_ID);
  const relayer = ITokenBridgeRelayer__factory.connect(relayerAddress, wallet);

  const checks: Check[] = [];
  const result = await setFeeRecipient(relayer, args.newFeeRecipient);
  handleFailure(checks, result);

  const messages = await executeChecks(checks);
  console.log(messages);
}

main();
