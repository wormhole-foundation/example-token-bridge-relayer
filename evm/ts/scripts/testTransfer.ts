import {ethers} from "ethers";
import {
  RELEASE_CHAIN_ID,
  RELEASE_RPC,
  WALLET_PRIVATE_KEY,
  RELEASE_BRIDGE_ADDRESS,
  ZERO_ADDRESS,
} from "./consts";
import {
  tryHexToNativeString,
  ChainId,
  tryUint8ArrayToNative,
  tryNativeToHexString,
} from "@certusone/wormhole-sdk";
import {
  ITokenBridgeRelayer__factory,
  ITokenBridge__factory,
  IERC20__factory,
} from "../src/ethers-contracts";
import * as fs from "fs";

async function transferTokensWithRelay(
  tokenAddress: string,
  tokenChain: ChainId,
  tokenDecimals: number,
  amount: string,
  toNativeTokenAmount: string,
  targetChain: ChainId,
  testNative: boolean
) {
  // read config
  const configPath = `${__dirname}/../../../cfg/deploymentConfig.json`;
  const relayerConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));

  // set up ethers wallet
  const provider = new ethers.providers.StaticJsonRpcProvider(RELEASE_RPC);
  const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

  // fetch relayer address from config
  const relayerAddress = tryHexToNativeString(
    relayerConfig["deployedContracts"][RELEASE_CHAIN_ID.toString()],
    RELEASE_CHAIN_ID as ChainId
  );

  // set up relayer contract
  const relayer: ethers.Contract = ITokenBridgeRelayer__factory.connect(
    relayerAddress,
    wallet
  );

  // set up token bridge contract
  const tokenBridge: ethers.Contract = ITokenBridge__factory.connect(
    RELEASE_BRIDGE_ADDRESS,
    wallet
  );

  // format the token address
  const formattedAddress = ethers.utils.arrayify("0x" + tokenAddress);

  // fetch the localTokenAddress
  let localTokenAddress: string;
  {
    if (tokenChain == RELEASE_CHAIN_ID) {
      localTokenAddress = tryUint8ArrayToNative(
        formattedAddress,
        tokenChain as ChainId
      );
    } else {
      // fetch the wrapped address
      localTokenAddress = await tokenBridge.wrappedAsset(
        tokenChain,
        formattedAddress
      );
    }
    if (localTokenAddress == ZERO_ADDRESS) {
      console.log(
        `Token not attested: chainId=${tokenChain}, token=${tokenChain}`
      );
      return;
    }
  }

  // set up ERC20
  const erc20Token: ethers.Contract = IERC20__factory.connect(
    localTokenAddress,
    wallet
  );

  // prepare amounts
  const amountToSend = ethers.utils.parseUnits(amount, tokenDecimals);
  const toNativeAmount = ethers.utils.parseUnits(
    toNativeTokenAmount,
    tokenDecimals
  );

  // calculate target relayer fee
  const relayerFee = await relayer.calculateRelayerFee(
    targetChain,
    erc20Token.address,
    18
  );

  // relayerFees
  const relayerFeeUsd = await relayer.relayerFee(targetChain);
  const relayerFeePrecision = await relayer.relayerFeePrecision();

  // swap rate
  const swapRate = await relayer.swapRate(erc20Token.address);
  const swapRatePrecision = await relayer.swapRatePrecision();

  console.log(
    `
     fee: ${relayerFeeUsd},
     feePrecision: ${relayerFeePrecision},
     swapRate: ${swapRate},
     swapRatePrecision: ${swapRatePrecision}
     amount: ${amountToSend},
     toNativeAmount: ${toNativeAmount},
     relayerFee: ${relayerFee},
     isNative: ${testNative}
    `
  );

  const targetRecipient = tryNativeToHexString(
    wallet.address,
    RELEASE_CHAIN_ID as ChainId
  );

  if (testNative) {
    // register the emitter
    let receipt: ethers.ContractReceipt;
    try {
      receipt = await relayer
        .wrapAndTransferEthWithRelay(
          toNativeAmount,
          targetChain,
          "0x" + targetRecipient,
          0,
          {value: amountToSend}
        )
        .then((tx: ethers.ContractTransaction) => tx.wait())
        .catch((msg: any) => {
          // should not happen
          console.log(msg);
          return null;
        });
      console.log(`txHash=${receipt.transactionHash}`);
    } catch (e: any) {
      console.log(e);
    }
  } else {
    // approve the relayer contract to spend tokens
    const tx = await erc20Token.approve(relayer.address, amountToSend);
    await tx.wait();

    // register the emitter
    let receipt: ethers.ContractReceipt;
    try {
      receipt = await relayer
        .transferTokensWithRelay(
          localTokenAddress,
          amountToSend,
          toNativeAmount,
          targetChain,
          "0x" + targetRecipient,
          0
        )
        .then((tx: ethers.ContractTransaction) => tx.wait())
        .catch((msg: any) => {
          // should not happen
          console.log(msg);
          return null;
        });
      console.log(`txHash=${receipt.transactionHash}`);
    } catch (e: any) {
      console.log(e);
    }
  }
}

async function main() {
  const tokenAddress =
    "000000000000000000000000d00ae08403B9bbb9124bB305C09058E32C39A48c";
  const tokenChain = 6 as ChainId;
  const amount = "0.005";
  const toNativeTokenAmount = "0.0005";
  const targetChain = 6;
  const tokenDecimals = 18;
  const testNative = false;

  await transferTokensWithRelay(
    tokenAddress,
    tokenChain,
    tokenDecimals,
    amount,
    toNativeTokenAmount,
    targetChain,
    testNative
  );
}

main();
