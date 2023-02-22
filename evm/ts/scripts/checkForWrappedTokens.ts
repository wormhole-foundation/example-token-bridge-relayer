import {ethers} from "ethers";
import {
  RELEASE_CHAIN_ID,
  RELEASE_RPC,
  WALLET_PRIVATE_KEY,
  RELEASE_BRIDGE_ADDRESS,
  ZERO_ADDRESS,
} from "./consts";
import {ChainId, tryUint8ArrayToNative} from "@certusone/wormhole-sdk";
import {ITokenBridge__factory} from "../src/ethers-contracts";
import * as fs from "fs";

async function main() {
  // read config
  const configPath = `${__dirname}/../../../cfg/deploymentConfig.json`;
  const relayerConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const tokenConfig = relayerConfig["acceptedTokensList"];

  // set up ethers wallet
  const provider = new ethers.providers.StaticJsonRpcProvider(RELEASE_RPC);
  const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

  // set up token bridge contract
  const tokenBridge: ethers.Contract = ITokenBridge__factory.connect(
    RELEASE_BRIDGE_ADDRESS,
    wallet
  );

  // loop through configured contracts
  for (const chainIdString of Object.keys(tokenConfig)) {
    // chainId as a number
    const chainIdToRegister = Number(chainIdString);
    console.log("\n");
    console.log(`ChainId ${chainIdToRegister}`);

    // array of tokens to register
    const tokens = tokenConfig[chainIdString];

    // loop through tokens and register them
    for (const tokenConfig of tokens) {
      const tokenContract = tokenConfig["contract"];

      // format the token address
      const formattedAddress = ethers.utils.arrayify("0x" + tokenContract);

      // fetch the wrapped of native address
      let localTokenAddress: string;
      if (chainIdToRegister == RELEASE_CHAIN_ID) {
        localTokenAddress = tryUint8ArrayToNative(
          formattedAddress,
          chainIdToRegister as ChainId
        );
      } else {
        // fetch the wrapped address
        localTokenAddress = await tokenBridge.wrappedAsset(
          chainIdToRegister,
          formattedAddress
        );
        if (localTokenAddress == ZERO_ADDRESS) {
          console.log(
            `Failed: token not attested, chainId=${chainIdString}, token=${tokenContract}`
          );
          continue;
        } else {
          console.log(`Success: token=${tokenContract} is attested.`);
        }
      }
    }
  }
}

main();
