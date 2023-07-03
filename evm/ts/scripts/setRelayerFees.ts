import { ethers } from "ethers";
import { RELEASE_CHAIN_ID, RELEASE_RPC } from "./consts";
import { tryHexToNativeString } from "@certusone/wormhole-sdk";
import {
  ITokenBridgeRelayer__factory,
  ITokenBridgeRelayer,
} from "../src/ethers-contracts";
import * as fs from "fs";
import {
  Config,
  SupportedChainId,
  isChain,
  parseArgs,
} from "./config";
import { getSigner } from "./signer";
import { buildOverrides } from "./tx";

async function updateRelayerFee(
  relayer: ITokenBridgeRelayer,
  chainId: SupportedChainId,
  relayerFee: string
): Promise<boolean> {
  const relayerFeeToUpdate = ethers.BigNumber.from(relayerFee);

  const overrides = await buildOverrides(
    () => relayer.estimateGas.updateRelayerFee(chainId, relayerFeeToUpdate),
    RELEASE_CHAIN_ID
  );

  const tx = await relayer.updateRelayerFee(
    chainId,
    relayerFeeToUpdate,
    overrides
  );
  const receipt = await tx.wait();
  console.log(
    `Relayer fee updated for chainId=${chainId}, fee=${relayerFee}, txHash=${receipt.transactionHash}`
  );

  // query the contract and see if the relayer fee was set properly
  const relayerFeeInContract = await relayer.relayerFee(chainId);
  return relayerFeeInContract.eq(relayerFeeToUpdate);
}

async function main() {
  const args = await parseArgs();
  const { deployedContracts: contracts, relayerFeesInUsd: relayerFees } =
    JSON.parse(fs.readFileSync(args.config, "utf8")) as Config;

  if (!isChain(RELEASE_CHAIN_ID)) {
    throw new Error(`Unknown wormhole chain id ${RELEASE_CHAIN_ID}`);
  }

  const provider = new ethers.providers.StaticJsonRpcProvider(RELEASE_RPC);
  const wallet = await getSigner(args, provider);

  // fetch relayer address from config
  const relayerAddress = tryHexToNativeString(
    contracts[RELEASE_CHAIN_ID],
    RELEASE_CHAIN_ID
  );

  // set up relayer contract
  const relayer = ITokenBridgeRelayer__factory.connect(relayerAddress, wallet);

  // loop through relayer fees and update the contract
  for (const [chainId_, fee] of Object.entries(relayerFees)) {
    // skip this chain
    const chainIdToRegister = Number(chainId_);
    if (!isChain(chainIdToRegister)) {
      throw new Error(`Unknown wormhole chain id ${chainIdToRegister}`);
    }
    if (chainIdToRegister === RELEASE_CHAIN_ID) {
      continue;
    }

    const result = await updateRelayerFee(
      relayer,
      chainIdToRegister,
      fee
    );

    if (result === false) {
      console.log(`Failed to update relayer fee for chainId=${chainId_}`);
    }
  }
}

main();
