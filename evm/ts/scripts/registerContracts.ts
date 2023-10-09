import { ethers } from "ethers";
import { RELEASE_CHAIN_ID, RELEASE_RPC, ZERO_BYTES32 } from "./consts";
import { tryHexToNativeString } from "@certusone/wormhole-sdk";
import { ITokenBridgeRelayer__factory, ITokenBridgeRelayer } from "../src/ethers-contracts";
import * as fs from "fs";
import { Config, SupportedChainId, isChain, isOperatingChain, parseArgs } from "./config";
import { getSigner } from "./signer";
import { Check, TxResult, buildOverrides, executeChecks, handleFailure } from "./tx";

async function registerContract(
  relayer: ITokenBridgeRelayer,
  chainId: SupportedChainId,
  contract: string
): Promise<TxResult> {
  // query the contract and see if the contract is already registered
  const beforeRegistrationEmitter = await relayer.getRegisteredContract(chainId);
  if (beforeRegistrationEmitter.toLowerCase() === contract.toLowerCase()) {
    console.log(`Contract already registered for chainId=${chainId}`);
    return TxResult.Success("");
  } else if (beforeRegistrationEmitter !== ZERO_BYTES32) {
    // TODO: either add an option to override this and reregister or remove this error altogether
    throw new Error(`A different contract is already registered for chainId=${chainId}`);
  }

  const overrides = await buildOverrides(
    () => relayer.estimateGas.registerContract(chainId, contract),
    RELEASE_CHAIN_ID
  );

  // register the emitter
  const tx = await relayer.registerContract(chainId, contract, overrides);
  console.log(`Register tx sent chainId=${chainId}, txHash=${tx.hash}`);
  const receipt = await tx.wait();

  const successMessage = `Registered chainId=${chainId}, txHash=${receipt.transactionHash}`;
  const failureMessage = `Failed to register chain=${chainId}`;
  return TxResult.create(receipt, successMessage, failureMessage, async () => {
    const emitterInContractState = await relayer.getRegisteredContract(chainId);
    return emitterInContractState.toLowerCase() === contract.toLowerCase();
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
  for (const [chainId_, contract] of Object.entries(contracts)) {
    // skip this chain
    const chainIdToRegister = Number(chainId_);
    if (!isChain(chainIdToRegister)) {
      throw new Error(`Unknown wormhole chain id ${chainIdToRegister}`);
    }
    if (chainIdToRegister == RELEASE_CHAIN_ID) {
      continue;
    }

    // format the address and register the chain
    const formattedAddress = `0x${contract}`;
    const result = await registerContract(relayer, chainIdToRegister, formattedAddress);

    handleFailure(checks, result);
  }

  const messages = await executeChecks(checks);
  console.log(messages);
}

main();
