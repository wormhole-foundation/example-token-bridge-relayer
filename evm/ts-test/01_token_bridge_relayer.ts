import {expect} from "chai";
import {ethers, Wallet} from "ethers";
import {MockGuardians} from "@certusone/wormhole-sdk/lib/cjs/mock";
import {
  CHAIN_ID_ETH,
  CHAIN_ID_AVAX,
  tryNativeToHexString,
} from "@certusone/wormhole-sdk";
import {
  AVAX_HOST,
  AVAX_WORMHOLE_ADDRESS,
  AVAX_BRIDGE_ADDRESS,
  AVAX_WORMHOLE_GUARDIAN_SET_INDEX,
  WAVAX_ADDRESS,
  FORK_AVAX_CHAIN_ID,
  ETH_HOST,
  ETH_WORMHOLE_ADDRESS,
  ETH_BRIDGE_ADDRESS,
  WETH_ADDRESS,
  FORK_ETH_CHAIN_ID,
  WALLET_PRIVATE_KEY,
  WALLET_PRIVATE_KEY_TWO,
  GUARDIAN_PRIVATE_KEY,
} from "./helpers/consts";
import {
  formatWormholeMessageFromReceipt,
  readTokenBridgeRelayerContractAddress,
  readWormUSDContractAddress,
  tokenBridgeDenormalizeAmount,
  tokenBridgeNormalizeAmount,
  tokenBridgeTransform,
} from "./helpers/utils";
import {
  ITokenBridgeRelayer__factory,
  ITokenBridge__factory,
  IWormhole__factory,
  IWETH__factory,
} from "./src/ethers-contracts";
import {makeContract} from "./helpers/io";

describe("Token Bridge Relayer", () => {
  // avax wallet
  const avaxProvider = new ethers.providers.StaticJsonRpcProvider(AVAX_HOST);
  const avaxWallet = new ethers.Wallet(WALLET_PRIVATE_KEY, avaxProvider);
  const avaxRelayerWallet = new ethers.Wallet(
    WALLET_PRIVATE_KEY_TWO,
    avaxProvider
  );

  // eth wallet
  const ethProvider = new ethers.providers.StaticJsonRpcProvider(ETH_HOST);
  const ethWallet = new ethers.Wallet(WALLET_PRIVATE_KEY, ethProvider);
  const ethRelayerWallet = new ethers.Wallet(
    WALLET_PRIVATE_KEY_TWO,
    ethProvider
  );

  // wormhole contract
  const avaxWormhole = IWormhole__factory.connect(
    AVAX_WORMHOLE_ADDRESS,
    avaxWallet
  );
  const ethWormhole = IWormhole__factory.connect(
    ETH_WORMHOLE_ADDRESS,
    ethWallet
  );

  // token bridge contract
  const avaxBridge = ITokenBridge__factory.connect(
    AVAX_BRIDGE_ADDRESS,
    avaxWallet
  );
  const ethBridge = ITokenBridge__factory.connect(
    ETH_BRIDGE_ADDRESS,
    ethWallet
  );

  // WormUSD ERC20 contract
  const wormUsdAbi = `${__dirname}/../out/WormUSD.sol/WormUSD.json`;
  const avaxWormUsd = makeContract(
    avaxWallet,
    readWormUSDContractAddress(FORK_AVAX_CHAIN_ID),
    wormUsdAbi
  );
  const ethWormUsd = makeContract(
    ethWallet,
    readWormUSDContractAddress(FORK_ETH_CHAIN_ID),
    wormUsdAbi
  );

  // Token Bridge Relayer contracts
  const avaxRelayer = ITokenBridgeRelayer__factory.connect(
    readTokenBridgeRelayerContractAddress(FORK_AVAX_CHAIN_ID),
    avaxWallet
  );
  const ethRelayer = ITokenBridgeRelayer__factory.connect(
    readTokenBridgeRelayerContractAddress(FORK_ETH_CHAIN_ID),
    ethWallet
  );

  // WETH contracts
  const wavax = IWETH__factory.connect(WAVAX_ADDRESS, avaxWallet);
  const weth = IWETH__factory.connect(WETH_ADDRESS, ethWallet);

  // swap rates and relayer fees for ETH
  const ethSwapRate = ethers.BigNumber.from("1200");
  const ethRelayerFee = ethers.utils.parseEther("0.0069");

  // swap rates and relayer fees for AVAX
  const avaxSwapRate = ethers.BigNumber.from("14");
  const avaxRelayerFee = ethers.utils.parseEther("0.01");

  // swap rates and relayer fees for WormUSD
  const wormUsdSwapRate = ethers.BigNumber.from("1");
  const wormUsdRelayerFee = ethers.utils.parseUnits("4.2", 6);

  // max native swap amounts
  const ethMaxNativeSwapAmount = ethers.utils.parseEther("6.9");
  const avaxMaxNativeSwapAmount = ethers.utils.parseEther("420");

  describe("AVAX Token Bridge Relayer Contract Setup", () => {
    it("Verify Contract Deployment", async () => {
      // confirm chainId
      const deployedChainId = await avaxRelayer.chainId();
      expect(deployedChainId).to.equal(CHAIN_ID_AVAX);
    });

    it("Contract Registration", async () => {
      // Convert the target contract address to bytes32, since other
      // non-evm blockchains (e.g. Solana) have 32 byte wallet addresses.
      const targetContractAddressHex =
        "0x" + tryNativeToHexString(ethRelayer.address, CHAIN_ID_ETH);

      // register the emitter
      const receipt = await avaxRelayer
        .registerContract(CHAIN_ID_ETH, targetContractAddressHex)
        .then((tx: ethers.ContractTransaction) => tx.wait())
        .catch((msg: any) => {
          // should not happen
          console.log(msg);
          return null;
        });
      expect(receipt).is.not.null;

      // query the contract and confirm that the emitter is set in storage
      const emitterInContractState = await avaxRelayer.getRegisteredContract(
        CHAIN_ID_ETH
      );
      expect(emitterInContractState).to.equal(targetContractAddressHex);
    });

    it("Register and Set Up WAVAX", async () => {
      // register wrapped avax
      {
        const receipt = await avaxRelayer
          .registerToken(CHAIN_ID_AVAX, wavax.address)
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm that the emitter is set in storage
        const tokenIsRegistered = await avaxRelayer.isAcceptedToken(
          wavax.address
        );
        expect(tokenIsRegistered).is.true;
      }

      // set the swap rate for wrapped avax
      {
        const swapRatePrecision = await avaxRelayer.nativeSwapRatePrecision();

        const receipt = await avaxRelayer
          .updateNativeSwapRate(
            CHAIN_ID_AVAX,
            wavax.address,
            avaxSwapRate.mul(swapRatePrecision)
          )
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm the swap rate was set
        const swapRateInContract = await avaxRelayer.nativeSwapRate(
          wavax.address
        );
        expect(swapRateInContract.toString()).to.equal(
          avaxSwapRate.mul(swapRatePrecision).toString()
        );
      }

      // set the relayer fee for wrapped avax
      {
        const receipt = await avaxRelayer
          .updateRelayerFee(CHAIN_ID_AVAX, wavax.address, avaxRelayerFee)
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm the swap rate was set
        const relayerFeeInContract = await avaxRelayer.relayerFee(
          CHAIN_ID_AVAX,
          wavax.address
        );
        expect(relayerFeeInContract.toString()).to.equal(
          avaxRelayerFee.toString()
        );
      }

      // set the max native swap amount for wrapped avax
      {
        const receipt = await avaxRelayer
          .updateMaxNativeSwapAmount(
            CHAIN_ID_AVAX,
            wavax.address,
            avaxMaxNativeSwapAmount
          )
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm the swap rate was set
        const maxNativeSwapAmount = await avaxRelayer.maxNativeSwapAmount(
          wavax.address
        );
        expect(maxNativeSwapAmount.toString()).to.equal(
          avaxMaxNativeSwapAmount.toString()
        );
      }
    });

    it("Register and Set Up WormUSD", async () => {
      // register WormUSD
      {
        const receipt = await avaxRelayer
          .registerToken(CHAIN_ID_AVAX, avaxWormUsd.address)
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm that the emitter is set in storage
        const tokenIsRegistered = await avaxRelayer.isAcceptedToken(
          avaxWormUsd.address
        );
        expect(tokenIsRegistered).is.true;
      }

      // set the swap rate for WormUSD
      {
        const swapRatePrecision = await avaxRelayer.nativeSwapRatePrecision();

        const receipt = await avaxRelayer
          .updateNativeSwapRate(
            CHAIN_ID_AVAX,
            avaxWormUsd.address,
            wormUsdSwapRate.mul(swapRatePrecision)
          )
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm the swap rate was set
        const swapRateInContract = await avaxRelayer.nativeSwapRate(
          avaxWormUsd.address
        );
        expect(swapRateInContract.toString()).to.equal(
          wormUsdSwapRate.mul(swapRatePrecision).toString()
        );
      }

      // set the relayer fee for WormUSD
      {
        const receipt = await avaxRelayer
          .updateRelayerFee(
            CHAIN_ID_AVAX,
            avaxWormUsd.address,
            wormUsdRelayerFee
          )
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm the swap rate was set
        const relayerFeeInContract = await avaxRelayer.relayerFee(
          CHAIN_ID_AVAX,
          avaxWormUsd.address
        );
        expect(relayerFeeInContract.toString()).to.equal(
          wormUsdRelayerFee.toString()
        );
      }

      // set the max native swap amount for WormUSD
      {
        const receipt = await avaxRelayer
          .updateMaxNativeSwapAmount(
            CHAIN_ID_AVAX,
            avaxWormUsd.address,
            avaxMaxNativeSwapAmount
          )
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm the swap rate was set
        const maxNativeSwapAmount = await avaxRelayer.maxNativeSwapAmount(
          avaxWormUsd.address
        );
        expect(maxNativeSwapAmount.toString()).to.equal(
          avaxMaxNativeSwapAmount.toString()
        );
      }
    });

    it("Register and Set Up Wrapped ETH From ETH", async () => {
      // fetch the wrapped version of ETH on avax
      const wrappedEth = await avaxBridge.wrappedAsset(
        CHAIN_ID_ETH,
        "0x" + tryNativeToHexString(weth.address, CHAIN_ID_ETH)
      );

      // register wrapped avax
      {
        const receipt = await avaxRelayer
          .registerToken(CHAIN_ID_AVAX, wrappedEth)
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm that the emitter is set in storage
        const tokenIsRegistered = await avaxRelayer.isAcceptedToken(wrappedEth);
        expect(tokenIsRegistered).is.true;
      }

      // set the swap rate for wrapped eth
      {
        const swapRatePrecision = await avaxRelayer.nativeSwapRatePrecision();

        const receipt = await avaxRelayer
          .updateNativeSwapRate(
            CHAIN_ID_AVAX,
            wrappedEth,
            ethSwapRate.mul(swapRatePrecision)
          )
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm the swap rate was set
        const swapRateInContract = await avaxRelayer.nativeSwapRate(wrappedEth);
        expect(swapRateInContract.toString()).to.equal(
          ethSwapRate.mul(swapRatePrecision).toString()
        );
      }

      // set the relayer fee for wrapped eth
      {
        const receipt = await avaxRelayer
          .updateRelayerFee(CHAIN_ID_AVAX, wrappedEth, ethRelayerFee)
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm the swap rate was set
        const relayerFeeInContract = await avaxRelayer.relayerFee(
          CHAIN_ID_AVAX,
          wrappedEth
        );
        expect(relayerFeeInContract.toString()).to.equal(
          ethRelayerFee.toString()
        );
      }

      // set the max native swap amount for wrapped eth
      {
        const receipt = await avaxRelayer
          .updateMaxNativeSwapAmount(
            CHAIN_ID_AVAX,
            wrappedEth,
            avaxMaxNativeSwapAmount
          )
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm the swap rate was set
        const maxNativeSwapAmount = await avaxRelayer.maxNativeSwapAmount(
          wrappedEth
        );
        expect(maxNativeSwapAmount.toString()).to.equal(
          avaxMaxNativeSwapAmount.toString()
        );
      }
    });
  });

  describe("ETH Token Bridge Relayer Contract Setup", () => {
    it("Verify Contract Deployment", async () => {
      // confirm chainId
      const deployedChainId = await ethRelayer.chainId();
      expect(deployedChainId).to.equal(CHAIN_ID_ETH);
    });

    it("Contract Registration", async () => {
      // Convert the target contract address to bytes32, since other
      // non-evm blockchains (e.g. Solana) have 32 byte wallet addresses.
      const targetContractAddressHex =
        "0x" + tryNativeToHexString(avaxRelayer.address, CHAIN_ID_AVAX);

      // register the emitter
      const receipt = await ethRelayer
        .registerContract(CHAIN_ID_AVAX, targetContractAddressHex)
        .then((tx: ethers.ContractTransaction) => tx.wait())
        .catch((msg: any) => {
          // should not happen
          console.log(msg);
          return null;
        });
      expect(receipt).is.not.null;

      // query the contract and confirm that the emitter is set in storage
      const emitterInContractState = await ethRelayer.getRegisteredContract(
        CHAIN_ID_AVAX
      );
      expect(emitterInContractState).to.equal(targetContractAddressHex);
    });

    it("Register and Set Up WETH", async () => {
      // register weth
      {
        const receipt = await ethRelayer
          .registerToken(CHAIN_ID_ETH, weth.address)
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm that the emitter is set in storage
        const tokenIsRegistered = await ethRelayer.isAcceptedToken(
          weth.address
        );
        expect(tokenIsRegistered).is.true;
      }

      // set the swap rate for weth
      {
        const swapRatePrecision = await ethRelayer.nativeSwapRatePrecision();

        const receipt = await ethRelayer
          .updateNativeSwapRate(
            CHAIN_ID_ETH,
            weth.address,
            ethSwapRate.mul(swapRatePrecision)
          )
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm the swap rate was set
        const swapRateInContract = await ethRelayer.nativeSwapRate(
          weth.address
        );
        expect(swapRateInContract.toString()).to.equal(
          ethSwapRate.mul(swapRatePrecision).toString()
        );
      }

      // set the relayer fee for weth
      {
        const receipt = await ethRelayer
          .updateRelayerFee(CHAIN_ID_ETH, weth.address, ethRelayerFee)
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm the swap rate was set
        const relayerFeeInContract = await ethRelayer.relayerFee(
          CHAIN_ID_ETH,
          weth.address
        );
        expect(relayerFeeInContract.toString()).to.equal(
          ethRelayerFee.toString()
        );
      }

      // set the max native swap amount for weth
      {
        const receipt = await ethRelayer
          .updateMaxNativeSwapAmount(
            CHAIN_ID_ETH,
            weth.address,
            ethMaxNativeSwapAmount
          )
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm the swap rate was set
        const maxNativeSwapAmount = await ethRelayer.maxNativeSwapAmount(
          weth.address
        );
        expect(maxNativeSwapAmount.toString()).to.equal(
          ethMaxNativeSwapAmount.toString()
        );
      }
    });

    it("Register and Set Up Wrapped WormUSD From AVAX", async () => {
      // fetch the wrapped version of wormUSD from AVAX
      const wrappedWormUsd = await ethBridge.wrappedAsset(
        CHAIN_ID_AVAX,
        "0x" + tryNativeToHexString(avaxWormUsd.address, CHAIN_ID_AVAX)
      );

      // register wrapped WormUSD
      {
        const receipt = await ethRelayer
          .registerToken(CHAIN_ID_ETH, wrappedWormUsd)
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm that the emitter is set in storage
        const tokenIsRegistered = await ethRelayer.isAcceptedToken(
          wrappedWormUsd
        );
        expect(tokenIsRegistered).is.true;
      }

      // set the swap rate for wrapped WormUSD
      {
        const swapRatePrecision = await ethRelayer.nativeSwapRatePrecision();

        const receipt = await ethRelayer
          .updateNativeSwapRate(
            CHAIN_ID_ETH,
            wrappedWormUsd,
            wormUsdSwapRate.mul(swapRatePrecision)
          )
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm the swap rate was set
        const swapRateInContract = await ethRelayer.nativeSwapRate(
          wrappedWormUsd
        );
        expect(swapRateInContract.toString()).to.equal(
          wormUsdSwapRate.mul(swapRatePrecision).toString()
        );
      }

      // set the relayer fee for wrapped WormUSD
      {
        const receipt = await ethRelayer
          .updateRelayerFee(CHAIN_ID_ETH, wrappedWormUsd, wormUsdRelayerFee)
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm the swap rate was set
        const relayerFeeInContract = await ethRelayer.relayerFee(
          CHAIN_ID_ETH,
          wrappedWormUsd
        );
        expect(relayerFeeInContract.toString()).to.equal(
          wormUsdRelayerFee.toString()
        );
      }

      // set the max native swap amount for wrapped WormUSD
      {
        const receipt = await ethRelayer
          .updateMaxNativeSwapAmount(
            CHAIN_ID_ETH,
            wrappedWormUsd,
            ethMaxNativeSwapAmount
          )
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm the swap rate was set
        const maxNativeSwapAmount = await ethRelayer.maxNativeSwapAmount(
          wrappedWormUsd
        );
        expect(maxNativeSwapAmount.toString()).to.equal(
          ethMaxNativeSwapAmount.toString()
        );
      }
    });

    it("Register and Set Up Wrapped AVAX From AVAX", async () => {
      // fetch the wrapped version of WAVAX from AVAX
      const wrappedAvax = await ethBridge.wrappedAsset(
        CHAIN_ID_AVAX,
        "0x" + tryNativeToHexString(wavax.address, CHAIN_ID_AVAX)
      );

      // register wrapped avax
      {
        const receipt = await ethRelayer
          .registerToken(CHAIN_ID_ETH, wrappedAvax)
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm that the emitter is set in storage
        const tokenIsRegistered = await ethRelayer.isAcceptedToken(wrappedAvax);
        expect(tokenIsRegistered).is.true;
      }

      // set the swap rate for wrapped avax
      {
        const swapRatePrecision = await ethRelayer.nativeSwapRatePrecision();

        const receipt = await ethRelayer
          .updateNativeSwapRate(
            CHAIN_ID_ETH,
            wrappedAvax,
            avaxSwapRate.mul(swapRatePrecision)
          )
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm the swap rate was set
        const swapRateInContract = await ethRelayer.nativeSwapRate(wrappedAvax);
        expect(swapRateInContract.toString()).to.equal(
          avaxSwapRate.mul(swapRatePrecision).toString()
        );
      }

      // set the relayer fee for wrapped avax
      {
        const receipt = await ethRelayer
          .updateRelayerFee(CHAIN_ID_ETH, wrappedAvax, avaxRelayerFee)
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm the swap rate was set
        const relayerFeeInContract = await ethRelayer.relayerFee(
          CHAIN_ID_ETH,
          wrappedAvax
        );
        expect(relayerFeeInContract.toString()).to.equal(
          avaxRelayerFee.toString()
        );
      }

      // set the max native swap amount for wrapped avax
      {
        const receipt = await ethRelayer
          .updateMaxNativeSwapAmount(
            CHAIN_ID_ETH,
            wrappedAvax,
            ethMaxNativeSwapAmount
          )
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm the swap rate was set
        const maxNativeSwapAmount = await ethRelayer.maxNativeSwapAmount(
          wrappedAvax
        );
        expect(maxNativeSwapAmount.toString()).to.equal(
          ethMaxNativeSwapAmount.toString()
        );
      }
    });
  });

  describe("Test Token Bridge Relayer Business Logic", () => {
    // simulated guardian that signs wormhole messages
    const guardians = new MockGuardians(AVAX_WORMHOLE_GUARDIAN_SET_INDEX, [
      GUARDIAN_PRIVATE_KEY,
    ]);

    let local: any = {};

    it("Transfer wormUSD Tokens From AVAX to ETH", async () => {
      // define the transfer amounts
      local.tokenDecimals = await ethWormUsd.decimals();
      local.transferAmount = ethers.utils.parseUnits(
        "42069",
        local.tokenDecimals
      );
      local.toNativeTokenAmount = ethers.utils.parseUnits(
        "69",
        local.tokenDecimals
      );

      // validate amounts before the test
      expect(
        local.transferAmount.gt(
          local.toNativeTokenAmount.add(wormUsdRelayerFee)
        )
      );

      // increase allowance of the wrapped wormUsd token for the avax wallet
      {
        const receipt = await avaxWormUsd
          .approve(avaxRelayer.address, local.transferAmount)
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;
      }

      // grab token balance before performing the transfer
      const balanceBefore = await avaxWormUsd.balanceOf(avaxWallet.address);

      // call sendTokensWithPayload
      const receipt = await avaxRelayer
        .transferTokensWithRelay(
          avaxWormUsd.address,
          local.transferAmount,
          local.toNativeTokenAmount,
          CHAIN_ID_ETH,
          "0x" + tryNativeToHexString(ethWallet.address, CHAIN_ID_ETH),
          false, // unwrap eth
          0 // batchId
        )
        .then(async (tx: ethers.ContractTransaction) => {
          const receipt = await tx.wait();
          return receipt;
        })
        .catch((msg) => {
          // should not happen
          console.log(msg);
          return null;
        });
      expect(receipt).is.not.null;

      // check token balance after to confirm the transfer worked
      const balanceAfter = await avaxWormUsd.balanceOf(avaxWallet.address);
      expect(balanceBefore.sub(balanceAfter).eq(local.transferAmount)).is.true;

      // now grab the Wormhole message
      const unsignedMessages = await formatWormholeMessageFromReceipt(
        receipt!,
        CHAIN_ID_AVAX
      );
      expect(unsignedMessages.length).to.equal(1);

      // sign the TransferWithPayload message
      local.signedTransferMessage = Uint8Array.from(
        guardians.addSignatures(unsignedMessages[0], [0])
      );
      expect(local.signedTransferMessage).is.not.null;
    });

    it("Should Redeem Wrapped wormUSD tokens on ETH", async () => {
      // fetch the token bridge wrapper for the transferred token
      const wrappedTokenOnEth = await ethBridge.wrappedAsset(
        CHAIN_ID_AVAX,
        "0x" + tryNativeToHexString(avaxWormUsd.address, CHAIN_ID_AVAX)
      );

      // create token contract for the wrapped asset
      const wrappedTokenContract = makeContract(
        ethWallet,
        wrappedTokenOnEth,
        wormUsdAbi
      );

      // Check the balance of the recipient and relayer wallet before
      // redeeming the token transfer.
      const relayerBalanceBefore = await wrappedTokenContract.balanceOf(
        ethRelayerWallet.address
      );
      const recipientBalanceBefore = await wrappedTokenContract.balanceOf(
        ethWallet.address
      );
      const relayerEthBalanceBefore = await ethRelayerWallet.getBalance();
      const recipientEthBalanceBefore = await ethWallet.getBalance();

      // fetch the native asset swap quote
      const nativeSwapQuote = await ethRelayer.calculateNativeSwapAmountOut(
        wrappedTokenContract.address,
        local.toNativeTokenAmount
      );

      // Invoke the relayer contract to redeem the transfer, passing the
      // encoded Wormhole message. Invoke this method using the ethRelayerWallet
      // to confirm that the contract handles relayer payouts correctly.
      const receipt = await ethRelayer
        .connect(ethRelayerWallet) // change signer
        .completeTransferWithRelay(local.signedTransferMessage, {
          value: nativeSwapQuote,
        })
        .then(async (tx: ethers.ContractTransaction) => {
          const receipt = await tx.wait();
          return receipt;
        })
        .catch((msg) => {
          // should not happen
          console.log(msg);
          return null;
        });
      expect(receipt).is.not.null;

      // fetch the balances after redeeming the token transfer
      const relayerBalanceAfter = await wrappedTokenContract.balanceOf(
        avaxRelayerWallet.address
      );
      const recipientBalanceAfter = await wrappedTokenContract.balanceOf(
        avaxWallet.address
      );
      const relayerEthBalanceAfter = await ethRelayerWallet.getBalance();
      const recipientEthBalanceAfter = await ethWallet.getBalance();

      // validate balance changes
      {
        const maxToNative = await ethRelayer.calculateMaxSwapAmountIn(
          wrappedTokenContract.address
        );
        if (local.toNativeTokenAmount > maxToNative) {
          local.toNativeTokenAmount = maxToNative;
        }
        if (nativeSwapQuote.eq(0)) {
          local.toNativeTokenAmount = 0;
        }

        // fetch the relayer fee
        const relayerFee = await ethRelayer.relayerFee(
          CHAIN_ID_ETH,
          wrappedTokenContract.address
        );

        // // recipient balance change
        // expect(recipientBalanceAfter.sub(recipientBalanceBefore)).to.equal(
        //   local.transferAmount.sub(local.toNativeTokenAmount).sub(relayerFee)
        // );
        // expect(relayerEthBalanceAfter.sub(relayerEthBalanceBefore)).to.equal(
        //   nativeSwapQuote
        // );

        // relayer balance change
      }

      // // clear localVariables
      // localVariables = {};

      // // Save the recipient balance change and wrapped token contract for the
      // // next test.
      // localVariables.avaxWalletWrappedTokenBalance = recipientBalanceAfter.sub(
      //   recipientBalanceBefore
      // );
      // localVariables.wrappedTokenContract = wrappedTokenContract;
    });
  });

  // // compute denormalized amounts
  // const relayerFee = tokenBridgeTransform(
  //   await ethRelayer.relayerFee(
  //     CHAIN_ID_ETH,
  //     wrappedTokenContract.address
  //   ),
  //   local.tokenDecimals
  // );
  // const toNative = tokenBridgeTransform(
  //   local.toNativeTokenAmount,
  //   local.tokenDecimals
  // );
});
