import {expect} from "chai";
import {
  CHAIN_ID_SUI,
  parseTransferPayload,
  parseVaa,
} from "@certusone/wormhole-sdk";
import * as mock from "@certusone/wormhole-sdk/lib/cjs/mock";
import {
  ETHEREUM_TOKEN_BRIDGE_ADDRESS,
  GUARDIAN_PRIVATE_KEY,
  WALLET_PRIVATE_KEY,
  RELAYER_PRIVATE_KEY,
  CREATOR_PRIVATE_KEY,
  WORMHOLE_STATE_ID,
  TOKEN_BRIDGE_STATE_ID,
  RELAYER_ID,
  RELAYER_OWNER_CAP_ID,
  RELAYER_UPGRADE_CAP_ID,
  COIN_8_TYPE,
  COIN_10_TYPE,
  SUI_TYPE,
  WORMHOLE_ID,
  SUI_METADATA_ID,
} from "../src/consts";
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
  tokenBridgeNormalizeAmount,
  tokenBridgeDenormalizeAmount,
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
  getDynamicFieldsByType,
  getIsTransferCompletedSui,
  getSwapEvent,
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
          tx.object(RELAYER_UPGRADE_CAP_ID),
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

      // Register coin 10.
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

      // Register coin 8.
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

      // Register SUI.
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
        expect(message.sequence).equals("3");
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
        expect(message.sequence).equals("4");
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

        // Verify the swap event.
        {
          const swapEvent = await getSwapEvent(receipt);
          expect(swapEvent.parsedJson.coin).equals(tokenAddress);
          expect(swapEvent.parsedJson.relayer).equals(relayerAddress);
          expect(swapEvent.parsedJson.recipient).equals(walletAddress);
          expect(swapEvent.parsedJson.coin_amount).equals(
            swapAmountIn.toString()
          );
          expect(swapEvent.parsedJson.sui_amount).equals(swapQuote.toString());
        }

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
            coinType: COIN_10_TYPE,
          })
          .then((result) => result.id);

        // NOTE: Since both the relayerFee and toNativeToken amount are zero,
        // we do not need to normalized the values before encoding them in
        // the payload.
        const toNativeTokenAmount = "0";
        const targetRelayerFee = "0";
        const payload = createTransferWithRelayPayload(
          parseInt(targetRelayerFee),
          parseInt(toNativeTokenAmount),
          recipient
        );

        // Normalize the `mintAmount`.
        const normalizedMintAmount = tokenBridgeNormalizeAmount(
          mintAmount,
          coin10Decimals
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
          typeArguments: [COIN_10_TYPE],
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
          COIN_10_TYPE,
          receipt.balanceChanges
        );

        // Confirm recipient balance change. Since this is a self redeem
        // the receipient should receive the full mintAmount.
        expect(recipientCoinChange).equals(
          tokenBridgeDenormalizeAmount(normalizedMintAmount, coin10Decimals)
        );
      });
    });

    describe("SUI Native Coin", () => {
      // The `transferAmount` will be transferred outbound in the first
      // The two following tests will use the `transferAmount` that is
      // deposited in the bridge to test complete transfer functionality.
      // For both tests to be successful, the following must be true:
      //     * transferAmount >= mintAmount1 + mintAmount2
      const outboundTransferAmount = "690000000000"; // 690 SUI
      const suiDecimals = 9;

      it("Transfer tokens with relay", async () => {
        expect(localVariables.stateId).is.not.undefined;
        const stateId: string = localVariables.stateId;

        // Fetch wallet address.
        const walletAddress = await wallet.getAddress();

        // Amount of tokens to swap.
        const toNativeAmount = "10000000000";

        // Fetch sui coins to pay the wormhole fee.
        const feeAmount = await getWormholeFee(provider);

        // Balance check before transferring tokens.
        const coinBalanceBefore = await provider.getBalance({
          owner: walletAddress,
          coinType: SUI_TYPE,
        });

        // Start new transaction.
        const tx = new TransactionBlock();

        // Coins to transfer to the target chain.
        const [wormholeFee, coinsToTransfer] = tx.splitCoins(tx.gas, [
          tx.pure(feeAmount),
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
          typeArguments: [SUI_TYPE],
        });

        tx.setGasBudget(500_000);
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
        expect(message.sequence).equals("5");
        expect(message.nonce).equals(nonce);

        // Cache state.
        const state = await getObjectFields(provider, stateId);

        // Since SUI has 9 decimals, we need to verify that the amounts
        // encoded in the payload are normalized.
        const normalizedTransferAmount = tokenBridgeNormalizeAmount(
          parseInt(outboundTransferAmount),
          suiDecimals
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
          suiDecimals,
          SUI_TYPE
        );
        const normalizedExpectedRelayerFee = tokenBridgeNormalizeAmount(
          expectedRelayerFee,
          suiDecimals
        );
        const normalizedToNativeAmount = tokenBridgeNormalizeAmount(
          parseInt(toNativeAmount),
          suiDecimals
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
        // the denormalized outboundTransferAmount. The balance chains should be
        // slightly more than the encoded amount, since we are sending SUI
        // in this test and the transaction costs some amount of gas (SUI).
        const coinBalanceAfter = await provider.getBalance({
          owner: walletAddress,
          coinType: SUI_TYPE,
        });
        expect(
          parseInt(coinBalanceBefore.totalBalance) -
            parseInt(coinBalanceAfter.totalBalance)
        ).gte(
          tokenBridgeDenormalizeAmount(normalizedTransferAmount, suiDecimals)
        );
      });

      it("Redeem transfer with relayer (no relayer refund)", async () => {
        expect(localVariables.stateId).is.not.undefined;

        // Cache stateId and fetch the state.
        const stateId: string = localVariables.stateId;
        const state = await getObjectFields(provider, stateId);

        // Save wallet and relayer addresses.
        const walletAddress = await wallet.getAddress();
        const relayerAddress = await relayer.getAddress();

        // Define transfer parameters.
        const mintAmount = Math.floor(Number(outboundTransferAmount) / 3);
        const recipient = walletAddress;
        const tokenAddress = SUI_METADATA_ID;

        // Raw amounts. These values will be normalized when added to the
        // payload.
        const toNativeTokenAmount = "10000000000";
        const targetRelayerFee = await getTokenRelayerFee(
          provider,
          state,
          Number(foreignChain),
          suiDecimals,
          SUI_TYPE
        );

        // Normalize values.
        const normalizedMintAmount = tokenBridgeNormalizeAmount(
          mintAmount,
          suiDecimals
        );
        const normalizedToNativeAmount = tokenBridgeNormalizeAmount(
          parseInt(toNativeTokenAmount),
          suiDecimals
        );
        const normalizedTargetRelayerFee = tokenBridgeNormalizeAmount(
          targetRelayerFee,
          suiDecimals
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

        // Start new transaction.
        const tx = new TransactionBlock();

        // Native coins to swap. Set to zero, since SUI swaps are disabled.
        const [coinsToTransfer] = tx.splitCoins(tx.gas, [tx.pure(0)]);

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
          typeArguments: [SUI_TYPE],
        });

        const gasBudget = 50_000n;
        tx.setGasBudget(gasBudget);

        const receipt = await relayer.signAndExecuteTransactionBlock({
          transactionBlock: tx,
          options: {
            showEvents: true,
            showBalanceChanges: true,
          },
        });

        // Fetch balance changes.
        const recipientSuiChange = getBalanceChangeFromTransaction(
          walletAddress,
          SUI_TYPE,
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
          suiDecimals
        );
        const denormalizedMintAmount = tokenBridgeDenormalizeAmount(
          normalizedMintAmount,
          suiDecimals
        );

        // Validate relayer balance change. The SUI change should reflect
        // the target relayer fee - gas spent.
        expect(relayerSuiChange).gte(
          denormalizedTargetRelayerFee - Number(gasBudget)
        ); // GTE to account for gas.

        // Validate recipient balance change. No swap should occur,
        // but the contract will pay the relayer a fee.
        expect(recipientSuiChange).equals(
          denormalizedMintAmount - denormalizedTargetRelayerFee
        );
      });

      it("Redeem transfer with relayer (with relayer refund)", async () => {
        expect(localVariables.stateId).is.not.undefined;

        // Cache stateId and fetch the state.
        const stateId: string = localVariables.stateId;
        const state = await getObjectFields(provider, stateId);

        // Save wallet and relayer addresses.
        const walletAddress = await wallet.getAddress();
        const relayerAddress = await relayer.getAddress();

        // Define transfer parameters.
        const mintAmount = Math.floor(Number(outboundTransferAmount) / 3);
        const recipient = walletAddress;
        const tokenAddress = SUI_METADATA_ID;

        // Raw amounts. These values will be normalized when added to the
        // payload.
        const toNativeTokenAmount = "0";
        const targetRelayerFee = await getTokenRelayerFee(
          provider,
          state,
          Number(foreignChain),
          suiDecimals,
          SUI_TYPE
        );

        // Normalize values.
        const normalizedMintAmount = tokenBridgeNormalizeAmount(
          mintAmount,
          suiDecimals
        );
        const normalizedToNativeAmount = tokenBridgeNormalizeAmount(
          parseInt(toNativeTokenAmount),
          suiDecimals
        );
        const normalizedTargetRelayerFee = tokenBridgeNormalizeAmount(
          targetRelayerFee,
          suiDecimals
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

        // Start new transaction.
        const tx = new TransactionBlock();

        // Set the swapQuote to a nonzero number. This amount should be refunded
        // to the relayer since swaps are disabled for SUI.
        const swapQuote = 5000000000;

        // Native coins to swap. Set to zero, since SUI swaps are disabled.
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
          typeArguments: [SUI_TYPE],
        });

        const gasBudget = 50_000n;
        tx.setGasBudget(gasBudget);

        const receipt = await relayer.signAndExecuteTransactionBlock({
          transactionBlock: tx,
          options: {
            showEvents: true,
            showBalanceChanges: true,
          },
        });

        // Only one event should be emitted since a swap didn't take place.
        expect(receipt.events!.length).equals(1);

        // Fetch balance changes.
        const recipientSuiChange = getBalanceChangeFromTransaction(
          walletAddress,
          SUI_TYPE,
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
          suiDecimals
        );
        const denormalizedMintAmount = tokenBridgeDenormalizeAmount(
          normalizedMintAmount,
          suiDecimals
        );

        /**
         * Validate relayer balance change. The SUI change should reflect
         * the target relayer fee - gas spent.
         *
         * NOTE: Even though the relayer provided coins to faciliate a swap,
         * the contract should've returned the funds, since swaps are
         * disabled for SUI.
         */
        expect(relayerSuiChange).gte(
          denormalizedTargetRelayerFee - Number(gasBudget)
        ); // GTE to account for gas.

        // Validate recipient balance change. No swap should occur,
        // but the contract will pay the relayer a fee.
        expect(recipientSuiChange).equals(
          denormalizedMintAmount - denormalizedTargetRelayerFee
        );
      });

      it("Recipient self redeems transfer", async () => {
        expect(localVariables.stateId).is.not.undefined;

        // Cache stateId and fetch the state.
        const stateId: string = localVariables.stateId;
        const state = await getObjectFields(provider, stateId);

        // Save wallet and relayer addresses.
        const walletAddress = await wallet.getAddress();

        // Define transfer parameters.
        const mintAmount = Math.floor(Number(outboundTransferAmount) / 3);
        const recipient = walletAddress;
        const tokenAddress = SUI_METADATA_ID;

        // NOTE: Since both the relayerFee and toNativeToken amount are zero,
        // we do not need to normalized the values before encoding them in
        // the payload.
        const toNativeTokenAmount = "0";
        const targetRelayerFee = "0";
        const payload = createTransferWithRelayPayload(
          parseInt(targetRelayerFee),
          parseInt(toNativeTokenAmount),
          recipient
        );

        // Normalize the `mintAmount`.
        const normalizedMintAmount = tokenBridgeNormalizeAmount(
          mintAmount,
          suiDecimals
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
          typeArguments: [SUI_TYPE],
        });

        const gasBudget = 25_000n;
        tx.setGasBudget(gasBudget);

        const receipt = await wallet.signAndExecuteTransactionBlock({
          transactionBlock: tx,
          options: {
            showEffects: true,
            showEvents: true,
            showBalanceChanges: true,
          },
        });

        // Fetch balance change.
        const recipientSuiChange = getBalanceChangeFromTransaction(
          walletAddress,
          SUI_TYPE,
          receipt.balanceChanges
        );

        // Confirm recipient balance change. Since this is a self redeem
        // the receipient should receive the full mintAmount less gas fees.
        expect(recipientSuiChange).gte(
          tokenBridgeDenormalizeAmount(normalizedMintAmount, suiDecimals) -
            Number(gasBudget)
        );
      });
    });

    describe("Only owner", () => {
      it("Update Swap Rate", async () => {
        expect(localVariables.stateId).is.not.undefined;
        const stateId: string = localVariables.stateId;
        const state = await getObjectFields(provider, stateId);

        const newSwapRate = "50000000000"; // $500 USD

        // Fetch the TokenInfo and confirm that the new and old swap rates
        // are not the same value.
        let tokenInfo = await getTokenInfo(provider, state, COIN_10_TYPE);
        expect(tokenInfo.swap_rate != newSwapRate).is.true;

        // Update swap rate.
        const tx = new TransactionBlock();
        tx.moveCall({
          target: `${RELAYER_ID}::owner::update_swap_rate`,
          arguments: [
            tx.object(RELAYER_OWNER_CAP_ID),
            tx.object(stateId),
            tx.pure(newSwapRate),
          ],
          typeArguments: [COIN_10_TYPE],
        });
        const result = await creator.signAndExecuteTransactionBlock({
          transactionBlock: tx,
        });
        expect(result.digest).is.not.null;

        // Validate the state changes.
        tokenInfo = await getTokenInfo(provider, state, COIN_10_TYPE);
        expect(tokenInfo.swap_rate).equals(newSwapRate);
      });

      it("Update max native swap amount", async () => {
        expect(localVariables.stateId).is.not.undefined;
        const stateId: string = localVariables.stateId;
        const state = await getObjectFields(provider, stateId);

        const newMaxSwapAmount = "6900000000"; // $69 USD

        // Fetch the TokenInfo.
        let tokenInfo = await getTokenInfo(provider, state, COIN_10_TYPE);
        expect(tokenInfo.max_native_swap_amount != newMaxSwapAmount).is.true;

        // Update max native swap amount.
        const tx = new TransactionBlock();
        tx.moveCall({
          target: `${RELAYER_ID}::owner::update_max_native_swap_amount`,
          arguments: [
            tx.object(RELAYER_OWNER_CAP_ID),
            tx.object(stateId),
            tx.pure(newMaxSwapAmount),
          ],
          typeArguments: [COIN_10_TYPE],
        });
        const result = await creator.signAndExecuteTransactionBlock({
          transactionBlock: tx,
        });
        expect(result.digest).is.not.null;

        // Validate the state changes.
        tokenInfo = await getTokenInfo(provider, state, COIN_10_TYPE);
        expect(tokenInfo.max_native_swap_amount).equals(newMaxSwapAmount);
      });

      it("Disable swaps", async () => {
        expect(localVariables.stateId).is.not.undefined;
        const stateId: string = localVariables.stateId;
        const state = await getObjectFields(provider, stateId);

        // Fetch the TokenInfo.
        let tokenInfo = await getTokenInfo(provider, state, COIN_10_TYPE);
        expect(tokenInfo.swap_enabled).is.true;

        // Disable swaps.
        const tx = new TransactionBlock();
        tx.moveCall({
          target: `${RELAYER_ID}::owner::toggle_swap_enabled`,
          arguments: [
            tx.object(RELAYER_OWNER_CAP_ID),
            tx.object(stateId),
            tx.pure(false),
          ],
          typeArguments: [COIN_10_TYPE],
        });
        const result = await creator.signAndExecuteTransactionBlock({
          transactionBlock: tx,
        });
        expect(result.digest).is.not.null;

        // Validate the state changes.
        tokenInfo = await getTokenInfo(provider, state, COIN_10_TYPE);
        expect(tokenInfo.swap_enabled).is.false;
      });

      it("Deregister token", async () => {
        expect(localVariables.stateId).is.not.undefined;
        const stateId: string = localVariables.stateId;
        const state = await getObjectFields(provider, stateId);

        // Fetch the dynamic field for COIN_8 token info before deregistering
        // the coin type.
        const registeredCoinFieldBefore = await getDynamicFieldsByType(
          provider,
          state!.registered_tokens.fields.id.id,
          COIN_8_TYPE
        );
        expect(registeredCoinFieldBefore.length).equals(1);

        // Disable swaps.
        const tx = new TransactionBlock();
        tx.moveCall({
          target: `${RELAYER_ID}::owner::deregister_token`,
          arguments: [tx.object(RELAYER_OWNER_CAP_ID), tx.object(stateId)],
          typeArguments: [COIN_8_TYPE],
        });
        const result = await creator.signAndExecuteTransactionBlock({
          transactionBlock: tx,
        });
        expect(result.digest).is.not.null;

        // Fetch the dynamic field for COIN_8 token info after deregistering
        // the coin type.
        const registeredCoinFieldAfter = await getDynamicFieldsByType(
          provider,
          state!.registered_tokens.fields.id.id,
          COIN_8_TYPE
        );
        expect(registeredCoinFieldAfter.length).equals(0);
      });
    });

    describe("Relay End-to-end", () => {
      const depositAmount = 69420100000;

      it("Deposit tokens into bridge", async () => {
        expect(localVariables.stateId).is.not.undefined;
        const stateId: string = localVariables.stateId;

        // Fetch wallet address.
        const walletAddress = await wallet.getAddress();

        // Fetch sui coins to pay the wormhole fee.
        const feeAmount = await getWormholeFee(provider);

        // Fetch coin 10.
        const coin = await getCoinWithHighestBalance(
          provider,
          walletAddress,
          COIN_10_TYPE
        );

        // Start new transaction.
        const tx = new TransactionBlock();

        // Wormhole fee coins.
        const [wormholeFee] = tx.splitCoins(tx.gas, [tx.pure(feeAmount)]);

        // Coins to transfer to the target chain.
        const [coinsToTransfer] = tx.splitCoins(tx.object(coin.coinObjectId), [
          tx.pure(depositAmount),
        ]);

        // Send the transfer with relay (this deposits token into the token
        // bridge).
        tx.moveCall({
          target: `${RELAYER_ID}::transfer::transfer_tokens_with_relay`,
          arguments: [
            tx.object(stateId),
            tx.object(WORMHOLE_STATE_ID),
            tx.object(TOKEN_BRIDGE_STATE_ID),
            coinsToTransfer,
            tx.pure(0),
            wormholeFee,
            tx.pure(foreignChain),
            tx.pure(nonce),
            tx.pure(walletAddress),
            tx.object(SUI_CLOCK_OBJECT_ID),
          ],
          typeArguments: [COIN_10_TYPE],
        });
        await wallet.signAndExecuteTransactionBlock({
          transactionBlock: tx,
          options: {
            showEvents: true,
          },
        });
      });

      it("Create signed VAA to be relayed", async () => {
        expect(localVariables.stateId).is.not.undefined;
        // Cache stateId and fetch the state.
        const stateId: string = localVariables.stateId;
        const state = await getObjectFields(provider, stateId);

        // Save wallet and relayer addresses.
        const walletAddress = await wallet.getAddress();

        // Define transfer parameters.
        const mintAmount = Number(depositAmount);
        const recipient = walletAddress;
        const tokenAddress = await provider
          .getCoinMetadata({
            coinType: COIN_10_TYPE,
          })
          .then((result) => result.id);

        // Raw amounts. These values will be normalized when added to the
        // payload.
        const toNativeTokenAmount = "1000000000000";
        const decimals = 10;
        const targetRelayerFee = await getTokenRelayerFee(
          provider,
          state,
          Number(foreignChain),
          decimals,
          COIN_10_TYPE
        );

        // Encode the payload.
        const payload = createTransferWithRelayPayload(
          tokenBridgeNormalizeAmount(targetRelayerFee, decimals),
          tokenBridgeNormalizeAmount(parseInt(toNativeTokenAmount), decimals),
          recipient
        );

        // Create a transfer tokens with payload message.
        const published = ethereumTokenBridge.publishTransferTokensWithPayload(
          tokenAddress!.substring(2),
          CHAIN_ID_SUI, // tokenChain
          BigInt(tokenBridgeNormalizeAmount(mintAmount, decimals)),
          CHAIN_ID_SUI, // recipientChain
          state!.emitter_cap.fields.id.id.substring(2), // targetContractAddress
          foreignContractAddress, // fromAddress
          Buffer.from(payload.substring(2), "hex"),
          nonce
        );

        // Sign the transfer message.
        localVariables.signedVaa = guardians.addSignatures(published, [0]);
      });

      it("Relay VAA", async () => {
        expect(localVariables.stateId).is.not.undefined;
        expect(localVariables.signedVaa).is.not.undefined;

        // Fetch the state object.
        const stateId: string = localVariables.stateId;
        const state = await getObjectFields(provider, stateId);

        // Assume you just fetched the VAA from the guardians (spy).
        const vaaArray = Buffer.from(localVariables.signedVaa);

        // Check to see if the VAA has been redeemed already.
        const isRedeemed = await getIsTransferCompletedSui(
          provider,
          TOKEN_BRIDGE_STATE_ID,
          WORMHOLE_ID,
          vaaArray
        );

        if (isRedeemed) {
          console.log("Vaa already redeemed");
          return;
        }

        // Parse the VAA.
        const parsedVaa = parseVaa(vaaArray);

        // Make sure it's a payload 3.
        const payloadType = parsedVaa.payload.readUint8(0);
        if (payloadType != 3) {
          console.log("Not a payload 3");
          return;
        }

        // Parse the transfer payload.
        const transferPayload = parseTransferPayload(parsedVaa.payload);

        // Confirm that the destination is the relayer contract.
        if (
          state!.emitter_cap.fields.id.id != transferPayload.targetAddress &&
          transferPayload.targetChain != CHAIN_ID_SUI
        ) {
          console.log("Destination is not a relayer contract");
          return;
        }

        /**
         * Confirm that the sender is a relayer contract.
         *
         * NOTE: The relayer should have a chainId to address mapping
         * for all registered contracts to perform a lookup.
         */
        if (
          transferPayload.fromAddress != foreignContractAddress.toString("hex")
        ) {
          console.log("Sender is not a registered relayer contract");
          return;
        }

        // Parse the TransferWithRelay message.
        const relayPayload = parseTransferWithRelay(parsedVaa.payload);

        // NOTE: We need to use SDK method to look up the coinType here. This method is
        // currently in active development. This is similar to looking up the local
        // token address on EVM chains.
        // const coinType = await getCoinTypeFromVAA(vaaArray);
        const coinType = COIN_10_TYPE; // Replace this with the sdk method.

        // Fetch the token decimals.
        const decimals = await provider
          .getCoinMetadata({
            coinType: coinType,
          })
          .then((result) => result.decimals);

        // Denormalize the to native token amount (swap amount).
        const normalizedToNativeAmount = tokenBridgeNormalizeAmount(
          relayPayload.toNativeTokenAmount,
          decimals
        );

        // Fetch the swap quote.
        const swapQuote = await getSwapQuote(
          provider,
          await relayer.getAddress(),
          state,
          normalizedToNativeAmount.toString(),
          decimals,
          coinType
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
            tx.pure(Array.from(localVariables.signedVaa)),
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

        // Confirm that the test worked!
        {
          const isRedeemed = await getIsTransferCompletedSui(
            provider,
            TOKEN_BRIDGE_STATE_ID,
            WORMHOLE_ID,
            vaaArray
          );
          expect(isRedeemed).is.true;
        }
      });
    });
  });
});
