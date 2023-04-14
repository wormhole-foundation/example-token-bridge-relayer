import {expect} from "chai";
import {ethers} from "ethers";
import {
  CHAIN_ID_SUI,
  tryNativeToHexString,
  parseTransferPayload,
  CHAIN_ID_ETH,
} from "@certusone/wormhole-sdk";
import * as mock from "@certusone/wormhole-sdk/lib/cjs/mock";
import {
  ETHEREUM_TOKEN_BRIDGE_ADDRESS,
  GUARDIAN_PRIVATE_KEY,
  WALLET_PRIVATE_KEY,
  WORMHOLE_ID,
  RELAYER_PRIVATE_KEY,
  CREATOR_PRIVATE_KEY,
  WORMHOLE_STATE_ID,
  TOKEN_BRIDGE_STATE_ID,
  RELAYER_ID,
  RELAYER_OWNER_CAP_ID,
  COIN_8_TYPE,
  COIN_10_TYPE,
  SUI_TYPE,
  WRAPPED_WETH_COIN_TYPE,
  WETH_ID,
  TOKEN_BRIDGE_ID,
} from "./helpers";
import {
  Ed25519Keypair,
  JsonRpcProvider,
  RawSigner,
  localnetConnection,
  TransactionBlock,
  SUI_CLOCK_OBJECT_ID,
} from "@mysten/sui.js";
import {
  getObjectFields,
  getWormholeEvents,
  getTableFromDynamicObjectField,
  tokenBridgeNormalizeAmount,
  tokenBridgeTransform,
  tokenBridgeDenormalizeAmount,
  getDynamicFieldsByType,
  getWormholeFee,
  getCoinWithHighestBalance,
  parseTransferWithRelay,
  getTableByName,
  getTokenInfo,
  getTokenRelayerFee,
  createTransferWithRelayPayload,
  getSwapQuote,
  getSwapAmountIn,
  getBalanceChangeFromTransaction,
} from "../src";

describe("1: Token Bridge Relayer", () => {
  const provider = new JsonRpcProvider(localnetConnection);

  // User wallet.
  const wallet = new RawSigner(
    Ed25519Keypair.fromSecretKey(WALLET_PRIVATE_KEY),
    provider
  );

  // Relayer wallet.
  const relayer = new RawSigner(
    Ed25519Keypair.fromSecretKey(RELAYER_PRIVATE_KEY),
    provider
  );

  // Deployer wallet.
  const creator = new RawSigner(
    Ed25519Keypair.fromSecretKey(CREATOR_PRIVATE_KEY),
    provider
  );

  // Mock guardians for signing wormhole messages.
  const guardians = new mock.MockGuardians(0, [GUARDIAN_PRIVATE_KEY]);

  const localVariables: any = {};

  describe("Set Up Relayer Contract", () => {
    // Foreign contract.
    const foreignChain = 2;
    const foreignContractAddress = Buffer.alloc(32, "deadbeef");
    const relayerFee = "25000000"; // $0.25

    // Coin 10.
    const coin10SwapRate = "100000000000"; // $1000.00
    const coin10MaxSwapAmount = "1000000000"; // One Sui.

    // Coin 8.
    const coin8SwapRate = "50000000"; // $0.50
    const coin8MaxSwapAmount = "5000000000"; // Five Sui.

    // Sui.
    const suiSwapRate = "100000000"; // $1.00
    const suiMaxSwapAmount = "0";

    it("Create relayer state", async () => {
      // Call `owner::create_state` on the Token Bridge Relayer.
      const tx = new TransactionBlock();
      tx.moveCall({
        target: `${RELAYER_ID}::owner::create_state`,
        arguments: [
          tx.object(WORMHOLE_STATE_ID),
          tx.object(RELAYER_OWNER_CAP_ID),
        ],
      });
      const result = await creator.signAndExecuteTransactionBlock({
        transactionBlock: tx,
        options: {showObjectChanges: true},
      });
      expect(result.digest).is.not.null;

      // Transaction is successful, so grab state ID.
      for (const objectEvent of result.objectChanges!) {
        if (
          objectEvent["type"] == "created" &&
          objectEvent["objectType"].includes("state::State")
        ) {
          localVariables.stateId = objectEvent["objectId"];
          break;
        }
      }

      // Fetch the state object fields and validate the setup.
      const state = await getObjectFields(provider, localVariables.stateId);
      expect("emitter_cap" in state!).is.true;
      expect(state!.registered_tokens.fields.num_tokens).equals("0");
      expect(state!.relayer_fee_precision).equals("100000000");
      expect(state!.swap_rate_precision).equals("100000000");
    });

    it("Register foreign contract (Ethereum)", async () => {
      expect(localVariables.stateId).is.not.undefined;
      const stateId: string = localVariables.stateId;

      // Register a foreign contract on the relayer.
      const tx = new TransactionBlock();
      tx.moveCall({
        target: `${RELAYER_ID}::owner::register_foreign_contract`,
        arguments: [
          tx.object(RELAYER_OWNER_CAP_ID),
          tx.object(stateId),
          tx.pure(foreignChain),
          tx.pure(foreignContractAddress),
        ],
      });
      const result = await creator.signAndExecuteTransactionBlock({
        transactionBlock: tx,
      });
      expect(result.digest).is.not.null;

      // Fetch the `foreign_contracts` table.
      const registeredContracts = await getTableByName(
        provider,
        stateId,
        "foreign_contracts"
      );
      expect(registeredContracts).has.length(1);

      // Verify that the contract was registered correctly.
      expect(parseInt(registeredContracts![0][0])).to.equal(foreignChain);
      expect(
        Buffer.from(
          registeredContracts![0][1].fields.value.fields.data
        ).toString("hex")
      ).to.equal(foreignContractAddress.toString("hex"));
    });

    it("Set relayer fee for foreign contract (Ethereum)", async () => {
      expect(localVariables.stateId).is.not.undefined;
      const stateId: string = localVariables.stateId;

      // Set the relayer fee for the registered foreign contract.
      const tx = new TransactionBlock();
      tx.moveCall({
        target: `${RELAYER_ID}::owner::update_relayer_fee`,
        arguments: [
          tx.object(RELAYER_OWNER_CAP_ID),
          tx.object(stateId),
          tx.pure(foreignChain),
          tx.pure(relayerFee),
        ],
      });
      const result = await creator.signAndExecuteTransactionBlock({
        transactionBlock: tx,
      });
      expect(result.digest).is.not.null;

      // Fetch the `relayer_fees` table from state.
      const relayerFees = await getTableByName(
        provider,
        stateId,
        "relayer_fees"
      );
      expect(relayerFees).has.length(1);

      // Verify that the contract was registered correctly.
      expect(parseInt(relayerFees![0][0])).to.equal(foreignChain);
      expect(relayerFees![0][1]).to.equal(relayerFee);
    });

    it("Register coin 10", async () => {
      expect(localVariables.stateId).is.not.undefined;
      const stateId: string = localVariables.stateId;

      // Set the relayer fee for the registered foreign contract.
      const tx = new TransactionBlock();
      tx.moveCall({
        target: `${RELAYER_ID}::owner::register_token`,
        arguments: [
          tx.object(RELAYER_OWNER_CAP_ID),
          tx.object(stateId),
          tx.pure(coin10SwapRate),
          tx.pure(coin10MaxSwapAmount),
          tx.pure(true), // Enable swap.
        ],
        typeArguments: [COIN_10_TYPE],
      });
      const result = await creator.signAndExecuteTransactionBlock({
        transactionBlock: tx,
      });
      expect(result.digest).is.not.null;

      // Verify the relayer state.
      const state = await getObjectFields(provider, localVariables.stateId);
      expect(state!.registered_tokens.fields.num_tokens).equals("1");

      // Fetch the COIN_10 `TokenInfo`.
      const tokenInfo = await getTokenInfo(provider, state, COIN_10_TYPE);

      expect(tokenInfo.max_native_swap_amount).equals(coin10MaxSwapAmount);
      expect(tokenInfo.swap_enabled).is.true;
      expect(tokenInfo.swap_rate).equals(coin10SwapRate);
    });

    it("Register coin 8", async () => {
      expect(localVariables.stateId).is.not.undefined;
      const stateId: string = localVariables.stateId;

      // Set the relayer fee for the registered foreign contract.
      const tx = new TransactionBlock();
      tx.moveCall({
        target: `${RELAYER_ID}::owner::register_token`,
        arguments: [
          tx.object(RELAYER_OWNER_CAP_ID),
          tx.object(stateId),
          tx.pure(coin8SwapRate),
          tx.pure(coin8MaxSwapAmount),
          tx.pure(true), // Enable swap.
        ],
        typeArguments: [COIN_8_TYPE],
      });
      const result = await creator.signAndExecuteTransactionBlock({
        transactionBlock: tx,
      });
      expect(result.digest).is.not.null;

      // Verify the relayer state.
      const state = await getObjectFields(provider, localVariables.stateId);
      expect(state!.registered_tokens.fields.num_tokens).equals("2");

      // Fetch the COIN_8 `TokenInfo`.
      const tokenInfo = await getTokenInfo(provider, state, COIN_8_TYPE);

      expect(tokenInfo.max_native_swap_amount).equals(coin8MaxSwapAmount);
      expect(tokenInfo.swap_enabled).is.true;
      expect(tokenInfo.swap_rate).equals(coin8SwapRate);
    });

    it("Register SUI", async () => {
      expect(localVariables.stateId).is.not.undefined;
      const stateId: string = localVariables.stateId;

      // Set the relayer fee for the registered foreign contract.
      const tx = new TransactionBlock();
      tx.moveCall({
        target: `${RELAYER_ID}::owner::register_token`,
        arguments: [
          tx.object(RELAYER_OWNER_CAP_ID),
          tx.object(stateId),
          tx.pure(suiSwapRate),
          tx.pure(suiMaxSwapAmount),
          tx.pure(false), // Disable swap.
        ],
        typeArguments: [SUI_TYPE],
      });
      const result = await creator.signAndExecuteTransactionBlock({
        transactionBlock: tx,
      });
      expect(result.digest).is.not.null;

      // Verify the relayer state.
      const state = await getObjectFields(provider, localVariables.stateId);
      expect(state!.registered_tokens.fields.num_tokens).equals("3");

      // Fetch the SUI `TokenInfo`.
      const tokenInfo = await getTokenInfo(provider, state, SUI_TYPE);

      expect(tokenInfo.max_native_swap_amount).equals(suiMaxSwapAmount);
      expect(tokenInfo.swap_enabled).is.false;
      expect(tokenInfo.swap_rate).equals(suiSwapRate);
    });
  });

  describe("Test Business Logic", () => {
    // Mock foreign token bridge.
    const ethereumTokenBridge = new mock.MockEthereumTokenBridge(
      ETHEREUM_TOKEN_BRIDGE_ADDRESS
    );

    // Foreign HelloToken contract.
    const foreignChain = "2";
    const foreignContractAddress = Buffer.alloc(32, "deadbeef");

    // Transfer nonce.
    const nonce = 69;

    describe("Coin 8", () => {
      // The `transferAmount` will be transferred outbound in the first
      // The two following tests will use the `transferAmount` that is
      // deposited in the bridge to test complete transfer functionality.
      // For both tests to be successful, the following must be true:
      //     * transferAmount >= mintAmount1 + mintAmount2
      const outboundTransferAmount = "100000000000";

      it("Transfer tokens with relay", async () => {
        expect(localVariables.stateId).is.not.undefined;
        const stateId: string = localVariables.stateId;

        // Fetch wallet address.
        const walletAddress = await wallet.getAddress();

        // Amount of tokens to swap.
        const toNativeAmount = "5000000";

        // Fetch sui coins to pay the wormhole fee.
        const feeAmount = await getWormholeFee(provider);

        // Fetch coin 8.
        const coin = await getCoinWithHighestBalance(
          provider,
          walletAddress,
          COIN_8_TYPE
        );

        // Balance check before transferring tokens.
        const coinBalanceBefore = await provider.getBalance({
          owner: walletAddress,
          coinType: COIN_8_TYPE,
        });

        // Start new transaction.
        const tx = new TransactionBlock();

        // Wormhole fee coins.
        const [wormholeFee] = tx.splitCoins(tx.gas, [tx.pure(feeAmount)]);

        // Coins to transfer to the target chain.
        const [coinsToTransfer] = tx.splitCoins(tx.object(coin.coinObjectId), [
          tx.pure(outboundTransferAmount),
        ]);

        // Send the transfer with relay.
        tx.moveCall({
          target: `${RELAYER_ID}::transfer::transfer_tokens_with_relay`,
          arguments: [
            tx.object(stateId),
            tx.object(WORMHOLE_STATE_ID),
            tx.object(TOKEN_BRIDGE_STATE_ID),
            coinsToTransfer,
            tx.pure(toNativeAmount),
            wormholeFee,
            tx.pure(foreignChain),
            tx.pure(nonce),
            tx.pure(walletAddress),
            tx.object(SUI_CLOCK_OBJECT_ID),
          ],
          typeArguments: [COIN_8_TYPE],
        });
        const eventData = await wallet.signAndExecuteTransactionBlock({
          transactionBlock: tx,
          options: {
            showEvents: true,
          },
        });

        // Fetch wormhole events.
        const wormholeEvents = getWormholeEvents(eventData);
        expect(wormholeEvents!.length).equals(1);

        // Parse the emitted Wormhole message and verify the payload.
        const message = wormholeEvents![0].parsedJson;
        expect(message.consistency_level).equal(0);
        expect(message.sequence).equals("2");
        expect(message.nonce).equals(nonce);

        // Cache state.
        const state = await getObjectFields(provider, stateId);

        // Verify the transfer payload.
        {
          const transferPayload = await parseTransferPayload(
            Buffer.from(message.payload)
          );

          expect(transferPayload.amount.toString()).to.equal(
            outboundTransferAmount
          );
          expect(transferPayload.fromAddress!).equals(
            state!.emitter_cap.fields.id.id.substring(2)
          );
          expect(transferPayload.originChain).to.equal(CHAIN_ID_SUI);
          expect(transferPayload.targetAddress).to.equal(
            foreignContractAddress.toString("hex")
          );
          expect(transferPayload.targetChain).to.equal(Number(foreignChain));
        }

        // Verify the additional payload.
        {
          const relayPayload = parseTransferWithRelay(
            Buffer.from(message.payload)
          );

          expect(relayPayload.payloadType).equals(1);
          expect(relayPayload.toNativeTokenAmount.toString()).equals(
            toNativeAmount
          );
          expect(relayPayload.recipient).equals(walletAddress);

          // Calculate the target relayer fee and compare it to the
          // value in the encoded payload.
          const expectedRelayerFee = await getTokenRelayerFee(
            provider,
            state,
            Number(foreignChain),
            8, // COIN_8 decimals,
            COIN_8_TYPE
          );

          expect(relayPayload.targetRelayerFee).equals(expectedRelayerFee);
        }

        // Balance check after transferring tokens.
        const coinBalanceAfter = await provider.getBalance({
          owner: walletAddress,
          coinType: COIN_8_TYPE,
        });
        expect(
          parseInt(coinBalanceBefore.totalBalance) -
            parseInt(coinBalanceAfter.totalBalance)
        ).eq(parseInt(outboundTransferAmount));
      });

      it("Redeem transfer with relayer", async () => {
        expect(localVariables.stateId).is.not.undefined;

        // Cache stateId and fetch the state.
        const stateId: string = localVariables.stateId;
        const state = await getObjectFields(provider, stateId);

        // Save wallet and relayer addresses.
        const walletAddress = await wallet.getAddress();
        const relayerAddress = await relayer.getAddress();

        // Define transfer parameters.
        const mintAmount = Math.floor(Number(outboundTransferAmount) / 2);
        const recipient = walletAddress;
        const tokenAddress = await provider
          .getCoinMetadata({
            coinType: COIN_8_TYPE,
          })
          .then((result) => result.id);
        const toNativeTokenAmount = "5000000000";
        const targetRelayerFee = await getTokenRelayerFee(
          provider,
          state,
          Number(foreignChain),
          8, // COIN_8 decimals,
          COIN_8_TYPE
        );
        const payload = createTransferWithRelayPayload(
          targetRelayerFee,
          parseInt(toNativeTokenAmount),
          recipient
        );

        // Verify that the mintAmount is large enough to cover the relayer fee
        // and swap amount.
        expect(parseInt(toNativeTokenAmount) + targetRelayerFee).lt(mintAmount);

        // Create a transfer tokens with payload message.
        const published = ethereumTokenBridge.publishTransferTokensWithPayload(
          tokenAddress!.substring(2),
          CHAIN_ID_SUI, // tokenChain
          BigInt(mintAmount.toString()),
          CHAIN_ID_SUI, // recipientChain
          state!.emitter_cap.fields.id.id.substring(2), // targetContractAddress
          foreignContractAddress, // fromAddress
          Buffer.from(payload.substring(2), "hex"),
          nonce
        );

        // Sign the transfer message.
        const signedWormholeMessage = guardians.addSignatures(published, [0]);

        // Calculate the swap quote.
        let swapQuote = await getSwapQuote(
          provider,
          walletAddress,
          state,
          toNativeTokenAmount,
          8, // Coin 8 decimals.
          COIN_8_TYPE
        );

        // Start new transaction.
        const tx = new TransactionBlock();

        // Native coins to swap.
        const [coinsToTransfer] = tx.splitCoins(tx.gas, [tx.pure(swapQuote)]);

        // Complete the tranfer with relay.
        tx.moveCall({
          target: `${RELAYER_ID}::redeem::complete_transfer_with_relay`,
          arguments: [
            tx.object(stateId),
            tx.object(WORMHOLE_STATE_ID),
            tx.object(TOKEN_BRIDGE_STATE_ID),
            tx.pure(Array.from(signedWormholeMessage)),
            coinsToTransfer,
            tx.object(SUI_CLOCK_OBJECT_ID),
          ],
          typeArguments: [COIN_8_TYPE],
        });
        tx.setGasBudget(25_000n);

        const receipt = await relayer.signAndExecuteTransactionBlock({
          transactionBlock: tx,
          options: {
            showEvents: true,
            showBalanceChanges: true,
          },
        });

        // Fetch balance changes.
        const recipientCoinChange = getBalanceChangeFromTransaction(
          walletAddress,
          COIN_8_TYPE,
          receipt.balanceChanges
        );
        const recipientSuiChange = getBalanceChangeFromTransaction(
          walletAddress,
          SUI_TYPE,
          receipt.balanceChanges
        );
        const relayerCoinChange = getBalanceChangeFromTransaction(
          relayerAddress,
          COIN_8_TYPE,
          receipt.balanceChanges
        );
        const relayerSuiChange = getBalanceChangeFromTransaction(
          relayerAddress,
          SUI_TYPE,
          receipt.balanceChanges
        );

        // Fetch the estimated swap amount in.
        const swapAmountIn = await getSwapAmountIn(
          provider,
          walletAddress,
          state,
          toNativeTokenAmount,
          8, // Coin 8 decimals.
          COIN_8_TYPE
        );

        // Validate relayer balance change.
        expect(relayerCoinChange).equals(swapAmountIn + targetRelayerFee);
        expect(relayerSuiChange).gte(swapQuote); // GTE to account for gas.

        // Confirm recipient balance changes.
        expect(recipientCoinChange).equals(
          mintAmount - targetRelayerFee - swapAmountIn
        );
        expect(recipientSuiChange).equals(swapQuote);
      });

      it("Recipient self redeems transfer", async () => {
        expect(localVariables.stateId).is.not.undefined;

        // Cache stateId and fetch the state.
        const stateId: string = localVariables.stateId;
        const state = await getObjectFields(provider, stateId);

        // Save wallet and relayer addresses.
        const walletAddress = await wallet.getAddress();

        // Define transfer parameters.
        const mintAmount = Math.floor(Number(outboundTransferAmount) / 2);
        const recipient = walletAddress;
        const tokenAddress = await provider
          .getCoinMetadata({
            coinType: COIN_8_TYPE,
          })
          .then((result) => result.id);
        const toNativeTokenAmount = "0";
        const targetRelayerFee = await getTokenRelayerFee(
          provider,
          state,
          Number(foreignChain),
          8, // COIN_8 decimals,
          COIN_8_TYPE
        );
        const payload = createTransferWithRelayPayload(
          targetRelayerFee,
          parseInt(toNativeTokenAmount),
          recipient
        );

        // Verify that the mintAmount is large enough to cover the relayer fee
        // and swap amount.
        expect(parseInt(toNativeTokenAmount) + targetRelayerFee).lt(mintAmount);

        // Create a transfer tokens with payload message.
        const published = ethereumTokenBridge.publishTransferTokensWithPayload(
          tokenAddress!.substring(2),
          CHAIN_ID_SUI, // tokenChain
          BigInt(mintAmount.toString()),
          CHAIN_ID_SUI, // recipientChain
          state!.emitter_cap.fields.id.id.substring(2), // targetContractAddress
          foreignContractAddress, // fromAddress
          Buffer.from(payload.substring(2), "hex"),
          nonce
        );

        // Sign the transfer message.
        const signedWormholeMessage = guardians.addSignatures(published, [0]);

        // Start new transaction.
        const tx = new TransactionBlock();

        // Complete the tranfer with relay.
        tx.moveCall({
          target: `${RELAYER_ID}::redeem::complete_transfer`,
          arguments: [
            tx.object(stateId),
            tx.object(WORMHOLE_STATE_ID),
            tx.object(TOKEN_BRIDGE_STATE_ID),
            tx.pure(Array.from(signedWormholeMessage)),
            tx.object(SUI_CLOCK_OBJECT_ID),
          ],
          typeArguments: [COIN_8_TYPE],
        });
        tx.setGasBudget(25_000n);

        const receipt = await wallet.signAndExecuteTransactionBlock({
          transactionBlock: tx,
          options: {
            showEffects: true,
            showEvents: true,
            showBalanceChanges: true,
          },
        });

        // Fetch balance change.
        const recipientCoinChange = getBalanceChangeFromTransaction(
          walletAddress,
          COIN_8_TYPE,
          receipt.balanceChanges
        );

        // Confirm recipient balance change. Since this is a self redeem
        // the receipient should receive the full mintAmount.
        expect(recipientCoinChange).equals(mintAmount);
      });
    });
    describe("Coin 10", () => {
      // The `transferAmount` will be transferred outbound in the first
      // The two following tests will use the `transferAmount` that is
      // deposited in the bridge to test complete transfer functionality.
      // For both tests to be successful, the following must be true:
      //     * transferAmount >= mintAmount1 + mintAmount2
      const outboundTransferAmount = "20000000000"; // 2 COIN_10.
      const coin10Decimals = 10;

      it("Transfer tokens with relay", async () => {
        expect(localVariables.stateId).is.not.undefined;
        const stateId: string = localVariables.stateId;

        // Fetch wallet address.
        const walletAddress = await wallet.getAddress();

        // Amount of tokens to swap.
        const toNativeAmount = "6900000069";

        // Fetch sui coins to pay the wormhole fee.
        const feeAmount = await getWormholeFee(provider);

        // Fetch coin 10.
        const coin = await getCoinWithHighestBalance(
          provider,
          walletAddress,
          COIN_10_TYPE
        );

        // Balance check before transferring tokens.
        const coinBalanceBefore = await provider.getBalance({
          owner: walletAddress,
          coinType: COIN_10_TYPE,
        });

        // Start new transaction.
        const tx = new TransactionBlock();

        // Wormhole fee coins.
        const [wormholeFee] = tx.splitCoins(tx.gas, [tx.pure(feeAmount)]);

        // Coins to transfer to the target chain.
        const [coinsToTransfer] = tx.splitCoins(tx.object(coin.coinObjectId), [
          tx.pure(outboundTransferAmount),
        ]);

        // Send the transfer with relay.
        tx.moveCall({
          target: `${RELAYER_ID}::transfer::transfer_tokens_with_relay`,
          arguments: [
            tx.object(stateId),
            tx.object(WORMHOLE_STATE_ID),
            tx.object(TOKEN_BRIDGE_STATE_ID),
            coinsToTransfer,
            tx.pure(toNativeAmount),
            wormholeFee,
            tx.pure(foreignChain),
            tx.pure(nonce),
            tx.pure(walletAddress),
            tx.object(SUI_CLOCK_OBJECT_ID),
          ],
          typeArguments: [COIN_10_TYPE],
        });
        const eventData = await wallet.signAndExecuteTransactionBlock({
          transactionBlock: tx,
          options: {
            showEvents: true,
          },
        });

        // Fetch wormhole events.
        const wormholeEvents = getWormholeEvents(eventData);
        expect(wormholeEvents!.length).equals(1);

        // Parse the emitted Wormhole message and verify the payload.
        const message = wormholeEvents![0].parsedJson;
        expect(message.consistency_level).equal(0);
        expect(message.sequence).equals("3");
        expect(message.nonce).equals(nonce);

        // Cache state.
        const state = await getObjectFields(provider, stateId);

        // Since COIN_10 has 10 decimals, we need to verify that the amounts
        // encoded in the payload are normalized.
        const normalizedTransferAmount = tokenBridgeNormalizeAmount(
          parseInt(outboundTransferAmount),
          coin10Decimals
        );

        // Verify the transfer payload.
        {
          const transferPayload = await parseTransferPayload(
            Buffer.from(message.payload)
          );

          expect(transferPayload.amount.toString()).to.equal(
            normalizedTransferAmount.toString()
          );
          expect(transferPayload.fromAddress!).equals(
            state!.emitter_cap.fields.id.id.substring(2)
          );
          expect(transferPayload.originChain).to.equal(CHAIN_ID_SUI);
          expect(transferPayload.targetAddress).to.equal(
            foreignContractAddress.toString("hex")
          );
          expect(transferPayload.targetChain).to.equal(Number(foreignChain));
        }

        // Calculate the normalized target relayer fee and to native swap amount
        // and compare it to the values in the encoded payload.
        const expectedRelayerFee = await getTokenRelayerFee(
          provider,
          state,
          Number(foreignChain),
          coin10Decimals,
          COIN_10_TYPE
        );
        const normalizedExpectedRelayerFee = tokenBridgeNormalizeAmount(
          expectedRelayerFee,
          coin10Decimals
        );
        const normalizedToNativeAmount = tokenBridgeNormalizeAmount(
          parseInt(toNativeAmount),
          coin10Decimals
        );

        // Verify the additional payload.
        {
          const relayPayload = parseTransferWithRelay(
            Buffer.from(message.payload)
          );

          expect(relayPayload.payloadType).equals(1);
          expect(relayPayload.toNativeTokenAmount.toString()).equals(
            normalizedToNativeAmount.toString()
          );
          expect(relayPayload.recipient).equals(walletAddress);
          expect(relayPayload.targetRelayerFee.toString()).equals(
            normalizedExpectedRelayerFee.toString()
          );
        }

        // Balance check after transferring tokens. The balance should reflect
        // the denormalized outboundTransferAmount. Dust should be returned to
        // the sender.
        const coinBalanceAfter = await provider.getBalance({
          owner: walletAddress,
          coinType: COIN_10_TYPE,
        });
        expect(
          parseInt(coinBalanceBefore.totalBalance) -
            parseInt(coinBalanceAfter.totalBalance)
        ).eq(
          tokenBridgeDenormalizeAmount(normalizedTransferAmount, coin10Decimals)
        );
      });

      it("Redeem transfer with relayer", async () => {
        expect(localVariables.stateId).is.not.undefined;

        // Cache stateId and fetch the state.
        const stateId: string = localVariables.stateId;
        const state = await getObjectFields(provider, stateId);

        // Save wallet and relayer addresses.
        const walletAddress = await wallet.getAddress();
        const relayerAddress = await relayer.getAddress();

        // Define transfer parameters.
        const mintAmount = Math.floor(Number(outboundTransferAmount) / 2);
        const recipient = walletAddress;
        const tokenAddress = await provider
          .getCoinMetadata({
            coinType: COIN_10_TYPE,
          })
          .then((result) => result.id);

        // Raw amounts. These values will be normalized when added to the
        // payload.
        const toNativeTokenAmount = "4200000069";
        const targetRelayerFee = await getTokenRelayerFee(
          provider,
          state,
          Number(foreignChain),
          coin10Decimals,
          COIN_10_TYPE
        );

        // Normalize values.
        const normalizedMintAmount = tokenBridgeNormalizeAmount(
          mintAmount,
          coin10Decimals
        );
        const normalizedToNativeAmount = tokenBridgeNormalizeAmount(
          parseInt(toNativeTokenAmount),
          coin10Decimals
        );
        const normalizedTargetRelayerFee = tokenBridgeNormalizeAmount(
          targetRelayerFee,
          coin10Decimals
        );

        // Encode the payload.
        const payload = createTransferWithRelayPayload(
          normalizedTargetRelayerFee,
          normalizedToNativeAmount,
          recipient
        );

        // Verify that the mintAmount is large enough to cover the relayer fee
        // and swap amount.
        expect(normalizedToNativeAmount + normalizedTargetRelayerFee).lt(
          normalizedMintAmount
        );

        // Create a transfer tokens with payload message.
        const published = ethereumTokenBridge.publishTransferTokensWithPayload(
          tokenAddress!.substring(2),
          CHAIN_ID_SUI, // tokenChain
          BigInt(normalizedMintAmount),
          CHAIN_ID_SUI, // recipientChain
          state!.emitter_cap.fields.id.id.substring(2), // targetContractAddress
          foreignContractAddress, // fromAddress
          Buffer.from(payload.substring(2), "hex"),
          nonce
        );

        // Sign the transfer message.
        const signedWormholeMessage = guardians.addSignatures(published, [0]);

        // Denormalize the swap amount.
        const denormalizedToNativeAmount = tokenBridgeDenormalizeAmount(
          normalizedToNativeAmount,
          coin10Decimals
        );

        // Calculate the swap quote.
        let swapQuote = await getSwapQuote(
          provider,
          walletAddress,
          state,
          denormalizedToNativeAmount.toString(),
          coin10Decimals,
          COIN_10_TYPE
        );

        // Start new transaction.
        const tx = new TransactionBlock();

        // Native coins to swap.
        const [coinsToTransfer] = tx.splitCoins(tx.gas, [tx.pure(swapQuote)]);

        // Complete the tranfer with relay.
        tx.moveCall({
          target: `${RELAYER_ID}::redeem::complete_transfer_with_relay`,
          arguments: [
            tx.object(stateId),
            tx.object(WORMHOLE_STATE_ID),
            tx.object(TOKEN_BRIDGE_STATE_ID),
            tx.pure(Array.from(signedWormholeMessage)),
            coinsToTransfer,
            tx.object(SUI_CLOCK_OBJECT_ID),
          ],
          typeArguments: [COIN_10_TYPE],
        });
        tx.setGasBudget(50_000n);

        const receipt = await relayer.signAndExecuteTransactionBlock({
          transactionBlock: tx,
          options: {
            showEvents: true,
            showBalanceChanges: true,
          },
        });

        // Fetch balance changes.
        const recipientCoinChange = getBalanceChangeFromTransaction(
          walletAddress,
          COIN_10_TYPE,
          receipt.balanceChanges
        );
        const recipientSuiChange = getBalanceChangeFromTransaction(
          walletAddress,
          SUI_TYPE,
          receipt.balanceChanges
        );
        const relayerCoinChange = getBalanceChangeFromTransaction(
          relayerAddress,
          COIN_10_TYPE,
          receipt.balanceChanges
        );
        const relayerSuiChange = getBalanceChangeFromTransaction(
          relayerAddress,
          SUI_TYPE,
          receipt.balanceChanges
        );

        // Calculate denormalized test amounts.
        const denormalizedTargetRelayerFee = tokenBridgeDenormalizeAmount(
          normalizedTargetRelayerFee,
          coin10Decimals
        );

        // Fetch the estimated swap amount in.
        const swapAmountIn = await getSwapAmountIn(
          provider,
          walletAddress,
          state,
          denormalizedToNativeAmount.toString(),
          coin10Decimals,
          COIN_10_TYPE
        );

        // Validate relayer balance change.
        expect(relayerCoinChange).equals(
          swapAmountIn + denormalizedTargetRelayerFee
        );
        expect(relayerSuiChange).gte(swapQuote); // GTE to account for gas.

        // Confirm recipient balance changes.
        expect(recipientCoinChange).equals(
          tokenBridgeDenormalizeAmount(normalizedMintAmount, coin10Decimals) -
            targetRelayerFee -
            swapAmountIn
        );
        expect(recipientSuiChange).equals(swapQuote);
      });

      // it("Recipient self redeems transfer", async () => {
      //   expect(localVariables.stateId).is.not.undefined;

      //   // Cache stateId and fetch the state.
      //   const stateId: string = localVariables.stateId;
      //   const state = await getObjectFields(provider, stateId);

      //   // Save wallet and relayer addresses.
      //   const walletAddress = await wallet.getAddress();

      //   // Define transfer parameters.
      //   const mintAmount = Math.floor(Number(outboundTransferAmount) / 2);
      //   const recipient = walletAddress;
      //   const tokenAddress = await provider
      //     .getCoinMetadata({
      //       coinType: COIN_8_TYPE,
      //     })
      //     .then((result) => result.id);
      //   const toNativeTokenAmount = "0";
      //   const targetRelayerFee = await getTokenRelayerFee(
      //     provider,
      //     state,
      //     Number(foreignChain),
      //     8, // COIN_8 decimals,
      //     COIN_8_TYPE
      //   );
      //   const payload = createTransferWithRelayPayload(
      //     targetRelayerFee,
      //     parseInt(toNativeTokenAmount),
      //     recipient
      //   );

      //   // Verify that the mintAmount is large enough to cover the relayer fee
      //   // and swap amount.
      //   expect(parseInt(toNativeTokenAmount) + targetRelayerFee).lt(mintAmount);

      //   // Create a transfer tokens with payload message.
      //   const published = ethereumTokenBridge.publishTransferTokensWithPayload(
      //     tokenAddress!.substring(2),
      //     CHAIN_ID_SUI, // tokenChain
      //     BigInt(mintAmount.toString()),
      //     CHAIN_ID_SUI, // recipientChain
      //     state!.emitter_cap.fields.id.id.substring(2), // targetContractAddress
      //     foreignContractAddress, // fromAddress
      //     Buffer.from(payload.substring(2), "hex"),
      //     nonce
      //   );

      //   // Sign the transfer message.
      //   const signedWormholeMessage = guardians.addSignatures(published, [0]);

      //   // Start new transaction.
      //   const tx = new TransactionBlock();

      //   // Complete the tranfer with relay.
      //   tx.moveCall({
      //     target: `${RELAYER_ID}::redeem::complete_transfer`,
      //     arguments: [
      //       tx.object(stateId),
      //       tx.object(WORMHOLE_STATE_ID),
      //       tx.object(TOKEN_BRIDGE_STATE_ID),
      //       tx.pure(Array.from(signedWormholeMessage)),
      //       tx.object(SUI_CLOCK_OBJECT_ID),
      //     ],
      //     typeArguments: [COIN_8_TYPE],
      //   });
      //   tx.setGasBudget(25_000n);

      //   const receipt = await wallet.signAndExecuteTransactionBlock({
      //     transactionBlock: tx,
      //     options: {
      //       showEffects: true,
      //       showEvents: true,
      //       showBalanceChanges: true,
      //     },
      //   });

      //   // Fetch balance change.
      //   const recipientCoinChange = getBalanceChangeFromTransaction(
      //     walletAddress,
      //     COIN_8_TYPE,
      //     receipt.balanceChanges
      //   );

      //   // Confirm recipient balance change. Since this is a self redeem
      //   // the receipient should receive the full mintAmount.
      //   expect(recipientCoinChange).equals(mintAmount);
      // });
    });
  });
});
