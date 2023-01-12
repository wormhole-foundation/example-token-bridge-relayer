import {ethers} from "ethers";
import {
  RELEASE_CHAIN_ID,
  RELEASE_RPC,
  WALLET_PRIVATE_KEY,
  ZERO_BYTES32,
} from "./consts";
import {tryHexToNativeString, ChainId} from "@certusone/wormhole-sdk";
import {ITokenBridgeRelayer__factory} from "../src/ethers-contracts";
import * as fs from "fs";

async function registerContract(
  relayer: ethers.Contract,
  chainId: Number,
  contract: ethers.BytesLike
): Promise<boolean> {
  let result: boolean = false;

  // query the contract and see if the contract is already registered
  const beforeRegistrationEmitter: ethers.BytesLike =
    await relayer.getRegisteredContract(chainId as ChainId);
  if (beforeRegistrationEmitter != ZERO_BYTES32) {
    console.log(`Contract already registered for chainId=${chainId}`);
    return true;
  }

  // register the emitter
  let receipt: ethers.ContractReceipt;
  try {
    receipt = await relayer
      .registerContract(chainId as ChainId, contract)
      .then((tx: ethers.ContractTransaction) => tx.wait())
      .catch((msg: any) => {
        // should not happen
        console.log(msg);
        return null;
      });
    console.log(
      `Registered chainId=${chainId}, txHash=${receipt.transactionHash}`
    );
  } catch (e: any) {
    console.log(e);
  }

  // query the contract and confirm that the emitter is set in storage
  const emitterInContractState: ethers.BytesLike =
    await relayer.getRegisteredContract(chainId as ChainId);

  if (emitterInContractState == ethers.utils.hexlify(contract)) {
    result = true;
  }

  return result;
}

async function main() {
  // read config
  const configPath = `${__dirname}/../../../cfg/deploymentConfig.json`;
  const relayerConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const contracts = relayerConfig["deployedContracts"];

  // setup ethers wallet
  const provider = new ethers.providers.StaticJsonRpcProvider(RELEASE_RPC);
  const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

  // fetch relayer address from config
  const relayerAddress = tryHexToNativeString(
    contracts[RELEASE_CHAIN_ID],
    RELEASE_CHAIN_ID as ChainId
  );

  // setup relayer contract
  const relayer: ethers.Contract = ITokenBridgeRelayer__factory.connect(
    relayerAddress,
    wallet
  );

  // loop through configured contracts and register them one at a time
  for (const chainId_ of Object.keys(contracts)) {
    // skip this chain
    const chainIdToRegister = Number(chainId_);
    if (chainIdToRegister == RELEASE_CHAIN_ID) {
      continue;
    }

    // format the address and register the chain
    const formattedAddress = ethers.utils.arrayify("0x" + contracts[chainId_]);
    const result: boolean = await registerContract(
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
