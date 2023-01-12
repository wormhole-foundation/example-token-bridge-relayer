import {ethers} from "ethers";
import {RELEASE_CHAIN_ID, RELEASE_RPC, WALLET_PRIVATE_KEY} from "./consts";
import {tryHexToNativeString, ChainId} from "@certusone/wormhole-sdk";
import {ITokenBridgeRelayer__factory} from "../src/ethers-contracts";
import * as fs from "fs";

async function updateRelayerFee(
  relayer: ethers.Contract,
  chainId: Number,
  relayerFee: string
): Promise<boolean> {
  let result: boolean = false;

  // convert USD fee to a BigNumber
  const relayerFeeToUpdate = ethers.BigNumber.from(relayerFee);

  // update the relayerFee
  let receipt: ethers.ContractReceipt;
  try {
    receipt = await relayer
      .updateRelayerFee(chainId, relayerFeeToUpdate)
      .then((tx: ethers.ContractTransaction) => tx.wait())
      .catch((msg: any) => {
        // should not happen
        console.log(msg);
        return null;
      });
    console.log(
      `Relayer fee updated for chainId=${chainId}, fee=${relayerFee}, txHash=${receipt.transactionHash}`
    );
  } catch (e: any) {
    console.log(e);
  }

  // query the contract and see if the relayer fee was set properly
  const relayerFeeInContract: ethers.BigNumber = await relayer.relayerFee(
    chainId
  );

  if (relayerFeeInContract.eq(relayerFeeToUpdate)) {
    result = true;
  }

  return result;
}

async function main() {
  // read config
  const configPath = `${__dirname}/../../../cfg/deploymentConfig.json`;
  const relayerConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const contracts = relayerConfig["deployedContracts"];
  const relayerFees = relayerConfig["relayerFeesInUsd"];

  // set up wallet
  const provider = new ethers.providers.StaticJsonRpcProvider(RELEASE_RPC);
  const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

  // fetch relayer address from config
  const relayerAddress = tryHexToNativeString(
    contracts[RELEASE_CHAIN_ID],
    RELEASE_CHAIN_ID as ChainId
  );

  // set up relayer contract
  const relayer: ethers.Contract = ITokenBridgeRelayer__factory.connect(
    relayerAddress,
    wallet
  );

  // loop through relayer fees and update the contract
  for (const chainId_ of Object.keys(relayerFees)) {
    // skip this chain
    const chainIdToRegister = Number(chainId_);
    if (chainIdToRegister == RELEASE_CHAIN_ID) {
      continue;
    }

    // update the relayerFee
    const result: boolean = await updateRelayerFee(
      relayer,
      chainIdToRegister,
      relayerFees[chainId_]
    );

    if (result === false) {
      console.log(`Failed to update relayer fee for chainId=${chainId_}`);
    }
  }
}

main();
