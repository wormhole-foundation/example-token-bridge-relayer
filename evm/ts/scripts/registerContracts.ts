import { ethers } from "ethers";
import { RELEASE_CHAIN_ID, RELEASE_RPC, ZERO_BYTES32 } from "./consts";
import { tryHexToNativeString } from "@certusone/wormhole-sdk";
import {
  ITokenBridgeRelayer__factory,
  ITokenBridgeRelayer,
} from "../src/ethers-contracts";
import * as fs from "fs";
import { Config, SupportedChainId, isChain, parseArgs } from "./config";
import { getSigner } from "./signer";
import { buildOverrides } from "./tx";

async function registerContract(
  relayer: ITokenBridgeRelayer,
  chainId: SupportedChainId,
  contract: ethers.BytesLike
): Promise<boolean> {
  // query the contract and see if the contract is already registered
  const beforeRegistrationEmitter = await relayer.getRegisteredContract(
    chainId
  );
  if (beforeRegistrationEmitter !== ZERO_BYTES32) {
    console.log(`Contract already registered for chainId=${chainId}`);
    return true;
  }

  const overrides = await buildOverrides(
    () => relayer.estimateGas.registerContract(chainId, contract),
    RELEASE_CHAIN_ID
  );

  // register the emitter
  const tx = await relayer.registerContract(chainId, contract, overrides);
  const receipt = await tx.wait();
  console.log(
    `Registered chainId=${chainId}, txHash=${receipt.transactionHash}`
  );

  // query the contract and confirm that the emitter is set in storage
  const emitterInContractState = await relayer.getRegisteredContract(chainId);

  return emitterInContractState === ethers.utils.hexlify(contract);
}

async function main() {
  const args = await parseArgs();
  const { deployedContracts: contracts } = JSON.parse(
    fs.readFileSync(args.config, "utf8")
  ) as Config;

  if (!isChain(RELEASE_CHAIN_ID)) {
    throw new Error(`Unknown wormhole chain id ${RELEASE_CHAIN_ID}`);
  }

  // setup ethers wallet
  const provider = new ethers.providers.StaticJsonRpcProvider(RELEASE_RPC);
  const wallet = await getSigner(args, provider);

  // fetch relayer address from config
  const relayerAddress = tryHexToNativeString(
    contracts[RELEASE_CHAIN_ID],
    RELEASE_CHAIN_ID
  );

  // setup relayer contract
  const relayer = ITokenBridgeRelayer__factory.connect(relayerAddress, wallet);

  // loop through configured contracts and register them one at a time
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
    const formattedAddress = ethers.utils.arrayify(`0x${contract}`);
    const result = await registerContract(
      relayer,
      chainIdToRegister,
      formattedAddress
    );

    if (result === false) {
      console.log(`Failed to register chain=${chainId_}`);
    }
  }
}

main();
