import { ethers } from "ethers";
import { RELEASE_CHAIN_ID, RELEASE_RPC } from "./consts";
import { tryHexToNativeString } from "@certusone/wormhole-sdk";
import { ITokenBridgeRelayer__factory, ITokenBridgeRelayer } from "../src/ethers-contracts";
import fs from "fs";
import { Config, ConfigArguments, isOperatingChain, configArgsParser } from "./config";
import { SignerArguments, addSignerArgsParser, getSigner } from "./signer";
import { Check, TxResult, buildOverrides, executeChecks, handleFailure } from "./tx";

interface CustomArguments {
  newOwnerAssistant: string;
}

type Arguments = CustomArguments & SignerArguments & ConfigArguments;

async function parseArgs(): Promise<Arguments> {
  const parsed = await addSignerArgsParser(configArgsParser()).option("newOwnerAssistant", {
    string: true,
    boolean: false,
    description: "fees will be received by this address",
    required: true,
  }).argv;

  const args: Arguments = {
    newOwnerAssistant: parsed.newOwnerAssistant,
    useLedger: parsed.ledger,
    derivationPath: parsed.derivationPath,
    config: parsed.config,
  };

  return args;
}

async function setOwnerAssistant(
  relayer: ITokenBridgeRelayer,
  newOwnerAssistant: string
): Promise<TxResult> {
  const currentOwnerAssistant = await relayer.ownerAssistant();
  if (currentOwnerAssistant.toLowerCase() === newOwnerAssistant.toLowerCase()) {
    return TxResult.Success(`Owner assistant already set to ${newOwnerAssistant}`);
  }

  const overrides = await buildOverrides(
    () => relayer.estimateGas.updateOwnerAssistant(RELEASE_CHAIN_ID, newOwnerAssistant),
    RELEASE_CHAIN_ID
  );

  const tx = await relayer.updateOwnerAssistant(RELEASE_CHAIN_ID, newOwnerAssistant, overrides);
  console.log(`Owner assistant update tx sent txHash=${tx.hash}`);
  const receipt = await tx.wait();

  const successMessage = `Updated owner assistant in blockHash=${receipt.blockHash}`;
  const failureMessage = `Failed to update owner assistant`;
  return TxResult.create(receipt, successMessage, failureMessage, async () => {
    const ownerAssistant = await relayer.ownerAssistant();
    return ownerAssistant === newOwnerAssistant;
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
  if (!ethers.utils.isAddress(args.newOwnerAssistant)) {
    throw new Error(`Invalid EVM address for owner assitant: ${args.newOwnerAssistant}`);
  }

  const provider = new ethers.providers.StaticJsonRpcProvider(RELEASE_RPC);
  const wallet = await getSigner(args, provider);

  const relayerAddress = tryHexToNativeString(contracts[RELEASE_CHAIN_ID], RELEASE_CHAIN_ID);
  const relayer = ITokenBridgeRelayer__factory.connect(relayerAddress, wallet);

  const checks: Check[] = [];
  const result = await setOwnerAssistant(relayer, args.newOwnerAssistant);
  handleFailure(checks, result);

  const messages = await executeChecks(checks);
  console.log(messages);
}

main();
