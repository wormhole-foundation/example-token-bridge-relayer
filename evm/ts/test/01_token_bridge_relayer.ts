import {expect} from "chai";
import {ethers} from "ethers";
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
  AVAX_RELAYER_FEE_PRECISION,
  FORK_AVAX_CHAIN_ID,
  ETH_HOST,
  ETH_WORMHOLE_ADDRESS,
  ETH_BRIDGE_ADDRESS,
  ETH_RELAYER_FEE_PRECISION,
  WETH_ADDRESS,
  FORK_ETH_CHAIN_ID,
  WALLET_PRIVATE_KEY,
  WALLET_PRIVATE_KEY_TWO,
  WALLET_PRIVATE_KEY_THREE,
  WALLET_PRIVATE_KEY_FOUR,
  GUARDIAN_PRIVATE_KEY,
} from "../helpers/consts";
import {SwapRateUpdate} from "../helpers/interfaces";
import {
  formatWormholeMessageFromReceipt,
  readTokenBridgeRelayerContractAddress,
  readWormUSDContractAddress,
  tokenBridgeTransform,
  findTransferCompletedEventInLogs,
  findSwapExecutedEventInLogs,
} from "../helpers/utils";
import {
  ITokenBridgeRelayer__factory,
  ITokenBridge__factory,
  IWormhole__factory,
} from "../src/ethers-contracts";
import {makeContract} from "../helpers/io";
import {IWETH__factory} from "@certusone/wormhole-sdk/lib/cjs/ethers-contracts";

describe("Token Bridge Relayer", () => {
  // avax wallet
  const avaxProvider = new ethers.providers.StaticJsonRpcProvider(AVAX_HOST);
  const avaxWallet = new ethers.Wallet(WALLET_PRIVATE_KEY, avaxProvider);
  const avaxRelayerWallet = new ethers.Wallet(
    WALLET_PRIVATE_KEY_TWO,
    avaxProvider
  );
  const avaxFeeWallet = new ethers.Wallet(
    WALLET_PRIVATE_KEY_THREE,
    avaxProvider
  );
  const avaxOwnerAssistant = new ethers.Wallet(
    WALLET_PRIVATE_KEY_FOUR,
    avaxProvider
  );

  // eth wallet
  const ethProvider = new ethers.providers.StaticJsonRpcProvider(ETH_HOST);
  const ethWallet = new ethers.Wallet(WALLET_PRIVATE_KEY, ethProvider);
  const ethRelayerWallet = new ethers.Wallet(
    WALLET_PRIVATE_KEY_TWO,
    ethProvider
  );
  const ethFeeWallet = new ethers.Wallet(WALLET_PRIVATE_KEY_THREE, ethProvider);
  const ethOwnerAssistant = new ethers.Wallet(
    WALLET_PRIVATE_KEY_FOUR,
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
  const wormUsdAbi = `${__dirname}/../../out/WormUSD.sol/WormUSD.json`;
  const avaxWormUsd = makeContract(
    avaxWallet,
    readWormUSDContractAddress(FORK_AVAX_CHAIN_ID),
    wormUsdAbi
  );

  // Token Bridge Relayer contracts
  const avaxRelayer = ITokenBridgeRelayer__factory.connect(
    readTokenBridgeRelayerContractAddress(FORK_AVAX_CHAIN_ID, true),
    avaxWallet
  );
  const ethRelayer = ITokenBridgeRelayer__factory.connect(
    readTokenBridgeRelayerContractAddress(FORK_ETH_CHAIN_ID, true),
    ethWallet
  );

  // WETH contracts
  const wavax = IWETH__factory.connect(WAVAX_ADDRESS, avaxWallet);
  const weth = IWETH__factory.connect(WETH_ADDRESS, ethWallet);

  // swap rates
  const ethSwapRate = ethers.BigNumber.from("1200");
  const avaxSwapRate = ethers.BigNumber.from("14");
  const wormUsdSwapRate = ethers.BigNumber.from("1");

  // relayer fees in USD
  const ethRelayerFee = ethers.BigNumber.from(
    (6.9 * Number(ETH_RELAYER_FEE_PRECISION)).toString()
  );
  const avaxRelayerFee = ethers.BigNumber.from(
    (0.42 * Number(AVAX_RELAYER_FEE_PRECISION)).toString()
  );

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
        const swapRatePrecision = await avaxRelayer.swapRatePrecision();

        // array of SwapRateUpdate structs
        const update: SwapRateUpdate[] = [
          {
            token: wavax.address,
            value: avaxSwapRate.mul(swapRatePrecision),
          },
        ];

        const receipt = await avaxRelayer
          .connect(avaxOwnerAssistant)
          .updateSwapRate(CHAIN_ID_AVAX, update)
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm the swap rate was set
        const swapRateInContract = await avaxRelayer.swapRate(wavax.address);

        expect(swapRateInContract.toString()).to.equal(
          avaxSwapRate.mul(swapRatePrecision).toString()
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
        const swapRatePrecision = await avaxRelayer.swapRatePrecision();

        // array of SwapRateUpdate structs
        const update: SwapRateUpdate[] = [
          {
            token: avaxWormUsd.address,
            value: wormUsdSwapRate.mul(swapRatePrecision),
          },
        ];

        const receipt = await avaxRelayer
          .connect(avaxOwnerAssistant)
          .updateSwapRate(CHAIN_ID_AVAX, update)
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm the swap rate was set
        const swapRateInContract = await avaxRelayer.swapRate(
          avaxWormUsd.address
        );
        expect(swapRateInContract.toString()).to.equal(
          wormUsdSwapRate.mul(swapRatePrecision).toString()
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
        const swapRatePrecision = await avaxRelayer.swapRatePrecision();

        // array of SwapRateUpdate structs
        const update: SwapRateUpdate[] = [
          {
            token: wrappedEth,
            value: ethSwapRate.mul(swapRatePrecision),
          },
        ];

        const receipt = await avaxRelayer
          .connect(avaxOwnerAssistant)
          .updateSwapRate(CHAIN_ID_AVAX, update)
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm the swap rate was set
        const swapRateInContract = await avaxRelayer.swapRate(wrappedEth);
        expect(swapRateInContract.toString()).to.equal(
          ethSwapRate.mul(swapRatePrecision).toString()
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

    it("Set Relayer Fee on AVAX", async () => {
      // set relayer fee for transferring to ETH
      const receipt = await avaxRelayer
        .connect(avaxOwnerAssistant)
        .updateRelayerFee(CHAIN_ID_ETH, ethRelayerFee)
        .then((tx: ethers.ContractTransaction) => tx.wait())
        .catch((msg: any) => {
          // should not happen
          console.log(msg);
          return null;
        });
      expect(receipt).is.not.null;

      // query the contract and confirm that the relayer fee was set
      const relayerFeeInContract = await avaxRelayer.relayerFee(CHAIN_ID_ETH);
      expect(relayerFeeInContract.toString()).to.equal(
        ethRelayerFee.toString()
      );
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
        const swapRatePrecision = await ethRelayer.swapRatePrecision();

        // array of SwapRateUpdate structs
        const update: SwapRateUpdate[] = [
          {
            token: weth.address,
            value: ethSwapRate.mul(swapRatePrecision),
          },
        ];

        const receipt = await ethRelayer
          .connect(ethOwnerAssistant)
          .updateSwapRate(CHAIN_ID_ETH, update)
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm the swap rate was set
        const swapRateInContract = await ethRelayer.swapRate(weth.address);
        expect(swapRateInContract.toString()).to.equal(
          ethSwapRate.mul(swapRatePrecision).toString()
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
        const swapRatePrecision = await ethRelayer.swapRatePrecision();

        // array of SwapRateUpdate structs
        const update: SwapRateUpdate[] = [
          {
            token: wrappedWormUsd,
            value: wormUsdSwapRate.mul(swapRatePrecision),
          },
        ];

        const receipt = await ethRelayer
          .connect(ethOwnerAssistant)
          .updateSwapRate(CHAIN_ID_ETH, update)
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm the swap rate was set
        const swapRateInContract = await ethRelayer.swapRate(wrappedWormUsd);
        expect(swapRateInContract.toString()).to.equal(
          wormUsdSwapRate.mul(swapRatePrecision).toString()
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
        const swapRatePrecision = await ethRelayer.swapRatePrecision();

        // array of SwapRateUpdate structs
        const update: SwapRateUpdate[] = [
          {
            token: wrappedAvax,
            value: avaxSwapRate.mul(swapRatePrecision),
          },
        ];

        const receipt = await ethRelayer
          .connect(ethOwnerAssistant)
          .updateSwapRate(CHAIN_ID_ETH, update)
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm the swap rate was set
        const swapRateInContract = await ethRelayer.swapRate(wrappedAvax);
        expect(swapRateInContract.toString()).to.equal(
          avaxSwapRate.mul(swapRatePrecision).toString()
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

    it("Set Relayer Fee on ETH", async () => {
      // set relayer fee for transferring to ETH
      const receipt = await ethRelayer
        .connect(ethOwnerAssistant)
        .updateRelayerFee(CHAIN_ID_AVAX, avaxRelayerFee)
        .then((tx: ethers.ContractTransaction) => tx.wait())
        .catch((msg: any) => {
          // should not happen
          console.log(msg);
          return null;
        });
      expect(receipt).is.not.null;

      // query the contract and confirm that the relayer fee was set
      const relayerFeeInContract = await ethRelayer.relayerFee(CHAIN_ID_AVAX);
      expect(relayerFeeInContract.toString()).to.equal(
        avaxRelayerFee.toString()
      );
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
      local.tokenDecimals = await avaxWormUsd.decimals();
      local.transferAmount = ethers.utils.parseUnits(
        "42069",
        local.tokenDecimals
      );
      local.toNativeTokenAmount = ethers.utils.parseUnits(
        "69",
        local.tokenDecimals
      );

      // compute the relayer fee in the token's denomination
      local.tokenRelayerFee = await avaxRelayer.calculateRelayerFee(
        CHAIN_ID_ETH,
        avaxWormUsd.address,
        local.tokenDecimals
      );

      // validate amounts before the test
      expect(
        local.transferAmount.gt(
          local.toNativeTokenAmount.add(local.tokenRelayerFee)
        )
      );

      // increase allowance of the wormUsd token for the avax wallet
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

      // call transferTokensWithRelay
      const receipt = await avaxRelayer
        .transferTokensWithRelay(
          avaxWormUsd.address,
          local.transferAmount,
          local.toNativeTokenAmount,
          CHAIN_ID_ETH,
          "0x" + tryNativeToHexString(ethWallet.address, CHAIN_ID_ETH),
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

    it("Redeem Wrapped wormUSD tokens on ETH", async () => {
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

      // Check the balance of the recipient, relayer and fee recipient wallet
      // before redeeming the token transfer.
      const relayerBalanceBefore = await wrappedTokenContract.balanceOf(
        ethRelayerWallet.address
      );
      const recipientBalanceBefore = await wrappedTokenContract.balanceOf(
        ethWallet.address
      );
      const feeRecipientBalanceBefore = await wrappedTokenContract.balanceOf(
        ethFeeWallet.address
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

      // parse the wormhole message
      const parsedMessage = await ethWormhole.parseVM(
        local.signedTransferMessage
      );

      // fetch the Redeem event emitted by the contract
      const event = findTransferCompletedEventInLogs(
        receipt!.logs,
        ethRelayer.address
      );
      expect(event.emitterChainId).to.equal(parsedMessage.emitterChainId);
      expect(event.emitterAddress).to.equal(parsedMessage.emitterAddress);
      expect(event.sequence.toString()).to.equal(
        parsedMessage.sequence.toString()
      );

      // fetch the balances after redeeming the token transfer
      const relayerBalanceAfter = await wrappedTokenContract.balanceOf(
        ethRelayerWallet.address
      );
      const recipientBalanceAfter = await wrappedTokenContract.balanceOf(
        ethWallet.address
      );
      const feeRecipientBalanceAfter = await wrappedTokenContract.balanceOf(
        ethFeeWallet.address
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
        if (nativeSwapQuote.eq(0) && local.toNativeTokenAmount > 0) {
          local.toNativeTokenAmount = 0;
        }

        // calculate the expected eth balance change for the relayer/recipient
        let expectedEthBalanceChange = await ethRelayer.maxNativeSwapAmount(
          wrappedTokenContract.address
        );
        if (nativeSwapQuote < expectedEthBalanceChange) {
          expectedEthBalanceChange = nativeSwapQuote;
        }

        // recipient balance changes
        expect(
          recipientBalanceAfter.sub(recipientBalanceBefore).toString()
        ).to.equal(
          local.transferAmount
            .sub(local.toNativeTokenAmount)
            .sub(local.tokenRelayerFee)
            .toString()
        );
        expect(
          recipientEthBalanceAfter.sub(recipientEthBalanceBefore).toString()
        ).to.equal(expectedEthBalanceChange.toString());

        // relayer balance changes
        expect(
          relayerBalanceAfter.sub(relayerBalanceBefore).toString()
        ).to.equal("0");
        expect(
          relayerEthBalanceBefore
            .sub(relayerEthBalanceAfter)
            .gte(expectedEthBalanceChange)
        ).is.true;

        // fee recipient balance changes
        expect(
          feeRecipientBalanceAfter.sub(feeRecipientBalanceBefore).toString()
        ).to.equal(
          local.toNativeTokenAmount.add(local.tokenRelayerFee).toString()
        );

        // confirm swap event was emitted correctly
        const event = findSwapExecutedEventInLogs(
          receipt!.logs,
          ethRelayer.address
        );
        expect(event.recipient).to.equal(ethWallet.address);
        expect(event.relayer).to.equal(ethRelayerWallet.address);
        expect(event.token).to.equal(wrappedTokenContract.address);
        expect(event.tokenAmount.toString()).to.equal(
          local.toNativeTokenAmount.toString()
        );
        expect(event.nativeAmount.toString()).to.equal(
          expectedEthBalanceChange.toString()
        );
      }

      // clear localVariables
      local = {};

      // save the recipient wrapped token balance for the next test
      local.avaxWalletWrappedTokenBalance = recipientBalanceAfter;
      local.wrappedTokenContract = wrappedTokenContract;
    });

    it("Transfer Wrapped wormUSD Tokens From ETH to AVAX", async () => {
      // define the transfer amounts
      local.tokenDecimals = await local.wrappedTokenContract.decimals();
      local.transferAmount = local.avaxWalletWrappedTokenBalance;
      local.toNativeTokenAmount = ethers.utils.parseUnits(
        "0",
        local.tokenDecimals
      );

      // compute the relayer fee in the token's denomination
      local.tokenRelayerFee = await ethRelayer.calculateRelayerFee(
        CHAIN_ID_AVAX,
        local.wrappedTokenContract.address,
        local.tokenDecimals
      );

      // validate amounts before the test
      expect(
        local.transferAmount.gt(
          local.toNativeTokenAmount.add(local.tokenRelayerFee)
        )
      );

      // increase allowance of the wrapped wormUsd token for the eth wallet
      {
        const receipt = await local.wrappedTokenContract
          .approve(ethRelayer.address, local.transferAmount)
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;
      }

      // grab token balance before performing the transfer
      const balanceBefore = await local.wrappedTokenContract.balanceOf(
        ethWallet.address
      );

      // call transferTokensWithRelay
      const receipt = await ethRelayer
        .transferTokensWithRelay(
          local.wrappedTokenContract.address,
          local.transferAmount,
          local.toNativeTokenAmount,
          CHAIN_ID_AVAX,
          "0x" + tryNativeToHexString(avaxWallet.address, CHAIN_ID_AVAX),
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
      const balanceAfter = await local.wrappedTokenContract.balanceOf(
        ethWallet.address
      );
      expect(balanceBefore.sub(balanceAfter).eq(local.transferAmount)).is.true;

      // now grab the Wormhole message
      const unsignedMessages = await formatWormholeMessageFromReceipt(
        receipt!,
        CHAIN_ID_ETH
      );
      expect(unsignedMessages.length).to.equal(1);

      // sign the TransferWithPayload message
      local.signedTransferMessage = Uint8Array.from(
        guardians.addSignatures(unsignedMessages[0], [0])
      );
      expect(local.signedTransferMessage).is.not.null;
    });

    it("Redeem wormUSD tokens on AVAX", async () => {
      // Check the balance of the recipient and relayer wallet before
      // redeeming the token transfer.
      const relayerBalanceBefore = await avaxWormUsd.balanceOf(
        avaxRelayerWallet.address
      );
      const recipientBalanceBefore = await avaxWormUsd.balanceOf(
        avaxWallet.address
      );
      const feeRecipientBalanceBefore = await avaxWormUsd.balanceOf(
        avaxFeeWallet.address
      );
      const relayerEthBalanceBefore = await avaxRelayerWallet.getBalance();
      const recipientEthBalanceBefore = await avaxWallet.getBalance();

      // NOTE: the nativeSwapQuote should be zero, since it's set to zero in
      // the previous test.
      const nativeSwapQuote = await avaxRelayer.calculateNativeSwapAmountOut(
        avaxWormUsd.address,
        local.toNativeTokenAmount
      );
      expect(nativeSwapQuote.toString()).to.equal("0");

      // Invoke the relayer contract to redeem the transfer, passing the
      // encoded Wormhole message. Invoke this method using the avaxRelayerWallet
      // to confirm that the contract handles relayer payouts correctly.
      const receipt = await avaxRelayer
        .connect(avaxRelayerWallet) // change signer
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

      // parse the wormhole message
      const parsedMessage = await avaxWormhole.parseVM(
        local.signedTransferMessage
      );

      // fetch the Redeem event emitted by the contract
      const event = findTransferCompletedEventInLogs(
        receipt!.logs,
        avaxRelayer.address
      );
      expect(event.emitterChainId).to.equal(parsedMessage.emitterChainId);
      expect(event.emitterAddress).to.equal(parsedMessage.emitterAddress);
      expect(event.sequence.toString()).to.equal(
        parsedMessage.sequence.toString()
      );

      // fetch the balances after redeeming the token transfer
      const relayerBalanceAfter = await avaxWormUsd.balanceOf(
        avaxRelayerWallet.address
      );
      const recipientBalanceAfter = await avaxWormUsd.balanceOf(
        avaxWallet.address
      );
      const feeRecipientBalanceAfter = await avaxWormUsd.balanceOf(
        avaxFeeWallet.address
      );
      const relayerEthBalanceAfter = await avaxRelayerWallet.getBalance();
      const recipientEthBalanceAfter = await avaxWallet.getBalance();

      // validate balance changes
      {
        const maxToNative = await avaxRelayer.calculateMaxSwapAmountIn(
          avaxWormUsd.address
        );
        if (local.toNativeTokenAmount > maxToNative) {
          local.toNativeTokenAmount = maxToNative;
        }
        if (nativeSwapQuote.eq(0) && local.toNativeTokenAmount > 0) {
          local.toNativeTokenAmount = 0;
        }

        // calculate the expected eth balance change for the relayer/recipient
        let expectedEthBalanceChange = await avaxRelayer.maxNativeSwapAmount(
          avaxWormUsd.address
        );
        if (nativeSwapQuote < expectedEthBalanceChange) {
          expectedEthBalanceChange = nativeSwapQuote;
        }

        // recipient balance changes
        expect(
          recipientBalanceAfter.sub(recipientBalanceBefore).toString()
        ).to.equal(
          local.transferAmount
            .sub(local.toNativeTokenAmount)
            .sub(local.tokenRelayerFee)
            .toString()
        );
        expect(
          recipientEthBalanceAfter.sub(recipientEthBalanceBefore).toString()
        ).to.equal(expectedEthBalanceChange.toString());

        // relayer balance changes
        expect(
          relayerBalanceAfter.sub(relayerBalanceBefore).toString()
        ).to.equal("0");
        expect(
          relayerEthBalanceBefore
            .sub(relayerEthBalanceAfter)
            .gte(expectedEthBalanceChange)
        ).is.true;
      }

      // fee recipient balance changes
      expect(
        feeRecipientBalanceAfter.sub(feeRecipientBalanceBefore).toString()
      ).to.equal(
        local.toNativeTokenAmount.add(local.tokenRelayerFee).toString()
      );

      // clear localVariables
      local = {};
    });

    it("Transfer WAVAX From AVAX to ETH", async () => {
      // define the transfer amounts
      local.tokenDecimals = 18;
      local.transferAmount = ethers.utils.parseEther("6.9");
      local.toNativeTokenAmount = ethers.utils.parseUnits(
        ".5",
        local.tokenDecimals
      );

      // compute the relayer fee in the token's denomination
      local.tokenRelayerFee = await avaxRelayer.calculateRelayerFee(
        CHAIN_ID_ETH,
        wavax.address,
        local.tokenDecimals
      );

      // validate amounts before the test
      expect(
        local.transferAmount.gt(
          local.toNativeTokenAmount.add(local.tokenRelayerFee)
        )
      );

      // wrap AVAX using the wormhole SDK's WETH factory
      {
        const receipt = await wavax
          .deposit({value: local.transferAmount})
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;
      }

      // increase allowance of the wavax token for the avax wallet
      {
        const receipt = await wavax
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
      const balanceBefore = await wavax.balanceOf(avaxWallet.address);

      // call transferTokensWithRelay
      const receipt = await avaxRelayer
        .transferTokensWithRelay(
          wavax.address,
          local.transferAmount,
          local.toNativeTokenAmount,
          CHAIN_ID_ETH,
          "0x" + tryNativeToHexString(ethWallet.address, CHAIN_ID_ETH),
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
      const balanceAfter = await wavax.balanceOf(avaxWallet.address);
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

    it("Redeem Wrapped AVAX on ETH", async () => {
      // fetch the token bridge wrapper for the transferred token
      const wrappedTokenOnEth = await ethBridge.wrappedAsset(
        CHAIN_ID_AVAX,
        "0x" + tryNativeToHexString(wavax.address, CHAIN_ID_AVAX)
      );

      // Create a token contract for the wrapped AVAX. We can reuse the wormUsdAbi
      // since don't need any of the WAVAX-specific functionality to use the
      // wrapped version.
      const wrappedTokenContract = makeContract(
        ethWallet,
        wrappedTokenOnEth,
        wormUsdAbi
      );

      // Check the balance of the recipient, relayer and fee recipient wallet
      // before redeeming the token transfer.
      const relayerBalanceBefore = await wrappedTokenContract.balanceOf(
        ethRelayerWallet.address
      );
      const recipientBalanceBefore = await wrappedTokenContract.balanceOf(
        ethWallet.address
      );
      const feeRecipientBalanceBefore = await wrappedTokenContract.balanceOf(
        ethFeeWallet.address
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

      // parse the wormhole message
      const parsedMessage = await ethWormhole.parseVM(
        local.signedTransferMessage
      );

      // fetch the Redeem event emitted by the contract
      const event = findTransferCompletedEventInLogs(
        receipt!.logs,
        ethRelayer.address
      );
      expect(event.emitterChainId).to.equal(parsedMessage.emitterChainId);
      expect(event.emitterAddress).to.equal(parsedMessage.emitterAddress);
      expect(event.sequence.toString()).to.equal(
        parsedMessage.sequence.toString()
      );

      // fetch the balances after redeeming the token transfer
      const relayerBalanceAfter = await wrappedTokenContract.balanceOf(
        ethRelayerWallet.address
      );
      const recipientBalanceAfter = await wrappedTokenContract.balanceOf(
        ethWallet.address
      );
      const feeRecipientBalanceAfter = await wrappedTokenContract.balanceOf(
        ethFeeWallet.address
      );
      const relayerEthBalanceAfter = await ethRelayerWallet.getBalance();
      const recipientEthBalanceAfter = await ethWallet.getBalance();

      // validate balance changes
      {
        // transform toNativeTokenAmount and relayerFee
        let denormToNative = tokenBridgeTransform(
          local.toNativeTokenAmount,
          local.tokenDecimals
        );
        let denormRelayerFee = tokenBridgeTransform(
          local.tokenRelayerFee,
          local.tokenDecimals
        );
        let denormTransferAmount = tokenBridgeTransform(
          local.transferAmount,
          local.tokenDecimals
        );

        const maxToNative = await ethRelayer.calculateMaxSwapAmountIn(
          wrappedTokenContract.address
        );
        if (denormToNative > maxToNative) {
          denormToNative = maxToNative;
        }
        if (nativeSwapQuote.eq(0)) {
          denormToNative = ethers.BigNumber.from("0");
        }

        // calculate the expected eth balance change for the relayer/recipient
        let expectedEthBalanceChange = await ethRelayer.maxNativeSwapAmount(
          wrappedTokenContract.address
        );
        if (nativeSwapQuote < expectedEthBalanceChange) {
          expectedEthBalanceChange = nativeSwapQuote;
        }

        // recipient balance changes
        expect(
          recipientBalanceAfter.sub(recipientBalanceBefore).toString()
        ).to.equal(
          denormTransferAmount
            .sub(denormToNative)
            .sub(denormRelayerFee)
            .toString()
        );
        expect(
          recipientEthBalanceAfter.sub(recipientEthBalanceBefore).toString()
        ).to.equal(expectedEthBalanceChange.toString());

        // relayer balance changes
        expect(
          relayerBalanceAfter.sub(relayerBalanceBefore).toString()
        ).to.equal("0");
        expect(
          relayerEthBalanceBefore
            .sub(relayerEthBalanceAfter)
            .gte(expectedEthBalanceChange)
        ).is.true;

        // fee recipient balance changes
        expect(
          feeRecipientBalanceAfter.sub(feeRecipientBalanceBefore).toString()
        ).to.equal(denormToNative.add(denormRelayerFee).toString());
      }

      // clear localVariables
      local = {};

      // save the recipient wrapped token balance for the next test
      local.avaxWalletWrappedTokenBalance = recipientBalanceAfter;
      local.wrappedTokenContract = wrappedTokenContract;
    });

    it("Deregister Wrapped Avax on ETH and Revert on transfer", async () => {
      // deregister wrapped avax on ETH
      {
        const receipt = await ethRelayer
          .deregisterToken(CHAIN_ID_ETH, local.wrappedTokenContract.address)
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // query the contract and confirm that the emitter is set in storage
        const tokenIsRegistered = await ethRelayer.isAcceptedToken(
          local.wrappedTokenContract.address
        );
        expect(tokenIsRegistered).is.false;

        // confirm that wrapped avax was removed from the list
        const acceptedTokenList = await ethRelayer.getAcceptedTokensList();
        expect(acceptedTokenList.includes(local.wrappedTokenContract.address))
          .is.false;
      }

      // define the transfer amounts
      local.tokenDecimals = await local.wrappedTokenContract.decimals();
      local.transferAmount = local.avaxWalletWrappedTokenBalance;
      local.toNativeTokenAmount = ethers.utils.parseUnits(
        "1",
        local.tokenDecimals
      );

      // the calculateRelayerFee call to should revert
      {
        let failed = false;
        try {
          local.tokenRelayerFee = await ethRelayer.calculateRelayerFee(
            CHAIN_ID_AVAX,
            local.wrappedTokenContract.address,
            local.tokenDecimals
          );
        } catch (e: any) {
          failed = true;
        }

        expect(failed).is.true;
      }

      // increase allowance of the wrapped wavax token for the eth wallet
      {
        const receipt = await local.wrappedTokenContract
          .approve(ethRelayer.address, local.transferAmount)
          .then((tx: ethers.ContractTransaction) => tx.wait())
          .catch((msg: any) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;
      }

      // grab token balance before performing the transfer
      const balanceBefore = await local.wrappedTokenContract.balanceOf(
        ethWallet.address
      );

      // try to redeem the transfer again
      let failed = false;
      try {
        // call transferTokensWithRelay
        const receipt = await ethRelayer
          .transferTokensWithRelay(
            local.wrappedTokenContract.address,
            local.transferAmount,
            local.toNativeTokenAmount,
            CHAIN_ID_AVAX,
            "0x" + tryNativeToHexString(avaxWallet.address, CHAIN_ID_AVAX),
            0 // batchId
          )
          .then(async (tx: ethers.ContractTransaction) => {
            const receipt = await tx.wait();
            return receipt;
          });
        expect(receipt).is.not.null;
      } catch (e: any) {
        expect(e.error.reason, "execution reverted: token not accepted").to.be
          .equal;
        failed = true;
      }

      // confirm that the call failed
      expect(failed).is.true;
    });

    it("Wrap and Transfer ETH From ETH to AVAX", async () => {
      // define the transfer amounts
      local.tokenDecimals = 18;
      local.transferAmount = ethers.utils.parseEther("42.69");
      local.toNativeTokenAmount = ethers.utils.parseUnits(
        "5",
        local.tokenDecimals
      );

      // compute the relayer fee in the token's denomination
      local.tokenRelayerFee = await ethRelayer.calculateRelayerFee(
        CHAIN_ID_AVAX,
        weth.address,
        local.tokenDecimals
      );

      // validate amounts before the test
      expect(
        local.transferAmount.gt(
          local.toNativeTokenAmount.add(local.tokenRelayerFee)
        )
      );

      // grab token balance before performing the transfer
      const balanceBefore = await ethWallet.getBalance();

      // call wrapAndTransferEthWithRelay
      const receipt = await ethRelayer
        .wrapAndTransferEthWithRelay(
          local.toNativeTokenAmount,
          CHAIN_ID_AVAX,
          "0x" + tryNativeToHexString(avaxWallet.address, CHAIN_ID_AVAX),
          0, // batchId
          {value: local.transferAmount}
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
      const balanceAfter = await ethWallet.getBalance();
      expect(balanceBefore.sub(balanceAfter).gte(local.transferAmount)).is.true;

      // now grab the Wormhole message
      const unsignedMessages = await formatWormholeMessageFromReceipt(
        receipt!,
        CHAIN_ID_ETH
      );
      expect(unsignedMessages.length).to.equal(1);

      // sign the TransferWithPayload message
      local.signedTransferMessage = Uint8Array.from(
        guardians.addSignatures(unsignedMessages[0], [0])
      );
      expect(local.signedTransferMessage).is.not.null;
    });

    it("Redeem Wrapped ETH on AVAX", async () => {
      // fetch the token bridge wrapper for the transferred token
      const wrappedTokenOnAvax = await avaxBridge.wrappedAsset(
        CHAIN_ID_ETH,
        "0x" + tryNativeToHexString(weth.address, CHAIN_ID_ETH)
      );

      // Create a token contract for the wrapped ETH. We can reuse the wormUsdAbi
      // since don't need any of the WETH-specific functionality to use the
      // wrapped version.
      const wrappedTokenContract = makeContract(
        avaxWallet,
        wrappedTokenOnAvax,
        wormUsdAbi
      );

      // Check the balance of the recipient, relayer and fee recipient wallet
      // before redeeming the token transfer.
      const relayerBalanceBefore = await wrappedTokenContract.balanceOf(
        avaxRelayerWallet.address
      );
      const recipientBalanceBefore = await wrappedTokenContract.balanceOf(
        avaxWallet.address
      );
      const feeRecipientBalanceBefore = await wrappedTokenContract.balanceOf(
        avaxFeeWallet.address
      );
      const relayerEthBalanceBefore = await avaxRelayerWallet.getBalance();
      const recipientEthBalanceBefore = await avaxWallet.getBalance();

      // fetch the native asset swap quote
      const nativeSwapQuote = await avaxRelayer.calculateNativeSwapAmountOut(
        wrappedTokenContract.address,
        local.toNativeTokenAmount
      );

      // Invoke the relayer contract to redeem the transfer, passing the
      // encoded Wormhole message. Invoke this method using the avaxRelayerWallet
      // to confirm that the contract handles relayer payouts correctly.
      const receipt = await avaxRelayer
        .connect(avaxRelayerWallet) // change signer
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

      // parse the wormhole message
      const parsedMessage = await avaxWormhole.parseVM(
        local.signedTransferMessage
      );

      // fetch the Redeem event emitted by the contract
      const event = findTransferCompletedEventInLogs(
        receipt!.logs,
        avaxRelayer.address
      );
      expect(event.emitterChainId).to.equal(parsedMessage.emitterChainId);
      expect(event.emitterAddress).to.equal(parsedMessage.emitterAddress);
      expect(event.sequence.toString()).to.equal(
        parsedMessage.sequence.toString()
      );

      // fetch the balances after redeeming the token transfer
      const relayerBalanceAfter = await wrappedTokenContract.balanceOf(
        avaxRelayerWallet.address
      );
      const recipientBalanceAfter = await wrappedTokenContract.balanceOf(
        avaxWallet.address
      );
      const feeRecipientBalanceAfter = await wrappedTokenContract.balanceOf(
        avaxFeeWallet.address
      );
      const relayerEthBalanceAfter = await avaxRelayerWallet.getBalance();
      const recipientEthBalanceAfter = await avaxWallet.getBalance();

      // validate balance changes
      {
        // transform toNativeTokenAmount and relayerFee
        let denormToNative = tokenBridgeTransform(
          local.toNativeTokenAmount,
          local.tokenDecimals
        );
        let denormRelayerFee = tokenBridgeTransform(
          local.tokenRelayerFee,
          local.tokenDecimals
        );
        let denormTransferAmount = tokenBridgeTransform(
          local.transferAmount,
          local.tokenDecimals
        );

        const maxToNative = await avaxRelayer.calculateMaxSwapAmountIn(
          wrappedTokenContract.address
        );
        if (denormToNative > maxToNative) {
          denormToNative = maxToNative;
        }
        if (nativeSwapQuote.eq(0)) {
          denormToNative = ethers.BigNumber.from("0");
        }

        // calculate the expected eth balance change for the relayer/recipient
        let expectedEthBalanceChange = await avaxRelayer.maxNativeSwapAmount(
          wrappedTokenContract.address
        );
        if (nativeSwapQuote < expectedEthBalanceChange) {
          expectedEthBalanceChange = nativeSwapQuote;
        }

        // recipient balance changes
        expect(
          recipientBalanceAfter.sub(recipientBalanceBefore).toString()
        ).to.equal(
          denormTransferAmount
            .sub(denormToNative)
            .sub(denormRelayerFee)
            .toString()
        );
        expect(
          recipientEthBalanceAfter.sub(recipientEthBalanceBefore).toString()
        ).to.equal(expectedEthBalanceChange.toString());

        // relayer balance changes
        expect(
          relayerBalanceAfter.sub(relayerBalanceBefore).toString()
        ).to.equal("0");
        expect(
          relayerEthBalanceBefore
            .sub(relayerEthBalanceAfter)
            .gte(expectedEthBalanceChange)
        ).is.true;

        // fee recipient balance changes
        expect(
          feeRecipientBalanceAfter.sub(feeRecipientBalanceBefore).toString()
        ).to.equal(denormToNative.add(denormRelayerFee).toString());
      }

      // clear localVariables
      local = {};

      // save the recipient wrapped token balance for the next test
      local.ethWalletWrappedTokenBalance = recipientBalanceAfter;
      local.wrappedTokenContract = wrappedTokenContract;
    });

    it("Transfer and Unwrap Wrapped ETH From AVAX to ETH", async () => {
      // define the transfer amounts
      local.tokenDecimals = await local.wrappedTokenContract.decimals();
      local.transferAmount = local.ethWalletWrappedTokenBalance;
      local.toNativeTokenAmount = ethers.utils.parseUnits(
        "0",
        local.tokenDecimals
      );

      // compute the relayer fee in the token's denomination
      local.tokenRelayerFee = await avaxRelayer.calculateRelayerFee(
        CHAIN_ID_ETH,
        local.wrappedTokenContract.address,
        local.tokenDecimals
      );

      // validate amounts before the test
      expect(
        local.transferAmount.gt(
          local.toNativeTokenAmount.add(local.tokenRelayerFee)
        )
      );

      // increase allowance of the wrapped weth token for the avax wallet
      {
        const receipt = await local.wrappedTokenContract
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
      const balanceBefore = await local.wrappedTokenContract.balanceOf(
        avaxWallet.address
      );

      // call transferTokensWithRelay
      const receipt = await avaxRelayer
        .transferTokensWithRelay(
          local.wrappedTokenContract.address,
          local.transferAmount,
          local.toNativeTokenAmount,
          CHAIN_ID_ETH,
          "0x" + tryNativeToHexString(ethWallet.address, CHAIN_ID_ETH),
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
      const balanceAfter = await local.wrappedTokenContract.balanceOf(
        avaxWallet.address
      );
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

    it("Redeem and Unwrap ETH on ETH", async () => {
      // Check the balance of the recipient and relayer wallet before
      // redeeming the token transfer.
      const relayerEthBalanceBefore = await ethRelayerWallet.getBalance();
      const recipientEthBalanceBefore = await ethWallet.getBalance();

      // Invoke the relayer contract to redeem the transfer, passing the
      // encoded Wormhole message. Invoke this method using the ethRelayerWallet
      // to confirm that the contract handles relayer payouts correctly.
      const receipt = await ethRelayer
        .connect(ethRelayerWallet) // change signer
        .completeTransferWithRelay(local.signedTransferMessage)
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

      // parse the wormhole message
      const parsedMessage = await avaxWormhole.parseVM(
        local.signedTransferMessage
      );

      // fetch the Redeem event emitted by the contract
      const event = findTransferCompletedEventInLogs(
        receipt!.logs,
        ethRelayer.address
      );
      expect(event.emitterChainId).to.equal(parsedMessage.emitterChainId);
      expect(event.emitterAddress).to.equal(parsedMessage.emitterAddress);
      expect(event.sequence.toString()).to.equal(
        parsedMessage.sequence.toString()
      );

      // fetch the balances after redeeming the token transfer
      const relayerEthBalanceAfter = await ethRelayerWallet.getBalance();
      const recipientEthBalanceAfter = await ethWallet.getBalance();

      // validate balance changes
      {
        let denormRelayerFee = tokenBridgeTransform(
          local.tokenRelayerFee,
          local.tokenDecimals
        );
        let denormTransferAmount = tokenBridgeTransform(
          local.transferAmount,
          local.tokenDecimals
        );

        // balance check the relayer and recipient
        expect(
          recipientEthBalanceAfter.sub(recipientEthBalanceBefore).toString()
        ).to.equal(denormTransferAmount.sub(denormRelayerFee).toString());
        expect(recipientEthBalanceAfter.gt(recipientEthBalanceBefore)).is.true;
      }

      // clear localVariables
      local = {};
    });

    it("Transfer wormUSD Tokens From AVAX to ETH", async () => {
      // define the transfer amounts
      local.tokenDecimals = await avaxWormUsd.decimals();
      local.transferAmount = ethers.utils.parseUnits(
        "69420",
        local.tokenDecimals
      );

      // The subsequent test demonstrates self redemption, even though
      // the toNativeTokenAmount value is nonzero, no swap will take place.
      local.toNativeTokenAmount = ethers.utils.parseUnits(
        "69.42",
        local.tokenDecimals
      );

      // compute the relayer fee in the token's denomination
      local.tokenRelayerFee = await avaxRelayer.calculateRelayerFee(
        CHAIN_ID_ETH,
        avaxWormUsd.address,
        local.tokenDecimals
      );

      // validate amounts before the test
      expect(
        local.transferAmount.gt(
          local.toNativeTokenAmount.add(local.tokenRelayerFee)
        )
      );

      // increase allowance of the wormUsd token for the avax wallet
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

      // call transferTokensWithRelay
      const receipt = await avaxRelayer
        .transferTokensWithRelay(
          avaxWormUsd.address,
          local.transferAmount,
          local.toNativeTokenAmount,
          CHAIN_ID_ETH,
          "0x" + tryNativeToHexString(ethWallet.address, CHAIN_ID_ETH),
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

    it("Self Redeem (No Relayer) Wrapped wormUSD tokens on ETH", async () => {
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

      // NOTE: do not fetch a native swap quote, the contract will not allow
      // native swaps for self redemptions.

      // invoke the relayer contract from the recipient's wallet
      const receipt = await ethRelayer
        .connect(ethWallet) // change signer
        .completeTransferWithRelay(local.signedTransferMessage)
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

      // parse the wormhole message
      const parsedMessage = await ethWormhole.parseVM(
        local.signedTransferMessage
      );

      // fetch the Redeem event emitted by the contract
      const event = findTransferCompletedEventInLogs(
        receipt!.logs,
        ethRelayer.address
      );
      expect(event.emitterChainId).to.equal(parsedMessage.emitterChainId);
      expect(event.emitterAddress).to.equal(parsedMessage.emitterAddress);
      expect(event.sequence.toString()).to.equal(
        parsedMessage.sequence.toString()
      );

      // fetch the balances after redeeming the token transfer
      const relayerBalanceAfter = await wrappedTokenContract.balanceOf(
        ethRelayerWallet.address
      );
      const recipientBalanceAfter = await wrappedTokenContract.balanceOf(
        ethWallet.address
      );

      // validate balance changes
      {
        // recipient balance changes
        expect(
          recipientBalanceAfter.sub(recipientBalanceBefore).toString()
        ).to.equal(local.transferAmount.toString());

        // relayer balance changes
        expect(
          relayerBalanceAfter.sub(relayerBalanceBefore).toString()
        ).to.equal("0");
      }

      // save the recipient wrapped token balance for the next test
      local.avaxWalletWrappedTokenBalance = recipientBalanceAfter;
      local.wrappedTokenContract = wrappedTokenContract;
    });

    it("Not Redeem a Transfer More Than Once", async () => {
      // grab the balance before redeeming the transfer
      const balanceBefore = await local.wrappedTokenContract.balanceOf(
        ethWallet.address
      );

      // try to redeem the transfer again
      let failed: boolean = false;
      try {
        // invoke the relayer contract from the recipient's wallet
        const receipt = await ethRelayer
          .connect(ethWallet) // change signer
          .completeTransferWithRelay(local.signedTransferMessage)
          .then(async (tx: ethers.ContractTransaction) => {
            const receipt = await tx.wait();
            return receipt;
          });
        expect(receipt).is.not.null;
      } catch (e: any) {
        expect(e.error.reason, "execution reverted: transfer already completed")
          .to.be.equal;
        failed = true;
      }

      // confirm that the call failed
      expect(failed).is.true;

      // confirm expected balance change
      const balanceAfter = await local.wrappedTokenContract.balanceOf(
        ethWallet.address
      );
      expect(balanceAfter.eq(balanceBefore)).is.true;
    });
  });
});
