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
  getTestBalances,
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
          coinBalanceBefore.totalBalance - coinBalanceAfter.totalBalance
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
        tx.setGasBudget(100_000n);

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

      // it("transfer::redeem_transfer_with_payload Self Redemption", async () => {
      //    // Complete the tranfer with relay.
      // tx.moveCall({
      //   target: `${RELAYER_ID}::redeem::complete_transfer`,
      //   arguments: [
      //     tx.object(stateId),
      //     tx.object(WORMHOLE_STATE_ID),
      //     tx.object(TOKEN_BRIDGE_STATE_ID),
      //     tx.pure(Array.from(signedWormholeMessage)),
      //     tx.object(SUI_CLOCK_OBJECT_ID),
      //   ],
      //   typeArguments: [COIN_8_TYPE],
      // });
      // tx.setGasBudget(215_000_000n);
      // const eventData = await wallet.signAndExecuteTransactionBlock({
      //   transactionBlock: tx,
      //   options: {
      //     showEffects: true,
      //     showEvents: true,
      //     showBalanceChanges: true,
      //   },
      // });

      // console.log(eventData);
    });

    describe("Coin 9", () => {
      it("Transfer tokens with relay", async () => {
        // expect(localVariables.stateId).is.not.undefined;
        // const stateId: string = localVariables.stateId;
        // // Fetch wallet address.
        // const walletAddress = await wallet.getAddress();
        // // Set the transfer amount.
        // localVariables.transferAmountCoin9 = "455";
        // const amount = localVariables.transferAmountCoin9;
        // // Fetch sui coins to pay the wormhole fee.
        // const wormholeFeeCoin = await getWormholeFeeCoins(provider, wallet);
        // // Grab COIN_10 balance.
        // const [transferCoin] = await provider
        //   .getCoins(walletAddress, COIN_10_TYPE)
        //   .then((result) => result.data);
        // // Fetch the coin metadata.
        // const metadata = await provider.getCoinMetadata(COIN_10_TYPE);
        // // Compute the normalized amount for data validation. The token
        // // bridge normalizes transfer quantites for tokens that have
        // // decimals greater than 8.
        // const normalizedAmount = tokenBridgeNormalizeAmount(
        //   ethers.BigNumber.from(amount),
        //   metadata.decimals
        // );
        // // Split the coin object into a separate object.
        // const splitCoin = await wallet
        //   .splitCoin({
        //     coinObjectId: transferCoin.coinObjectId,
        //     splitAmounts: [Number(amount)],
        //     gasBudget: 1000,
        //   })
        //   .then(async (tx) => {
        //     const created = await getCreatedFromTransaction(tx).then(
        //       (objects) => objects[0]
        //     );
        //     return "reference" in created ? created.reference.objectId : null;
        //   });
        // expect(splitCoin).is.not.null;
        // // Fetch the coin balance before transferring.
        // const coinBalanceBefore = await provider.getBalance(
        //   walletAddress!,
        //   COIN_10_TYPE
        // );
        // // Send a transfer by invoking `transfer::send_tokens_with_payload`
        // const sendWithPayloadTx = await wallet
        //   .executeMoveCall({
        //     packageObjectId: HELLO_TOKEN_ID,
        //     module: "transfer",
        //     function: "send_tokens_with_payload",
        //     typeArguments: [COIN_10_TYPE],
        //     arguments: [
        //       stateId,
        //       WORMHOLE_STATE_ID,
        //       TOKEN_BRIDGE_STATE_ID,
        //       splitCoin!,
        //       wormholeFeeCoin!,
        //       foreignChain,
        //       "0", // batchId
        //       Array.from(foreignContractAddress),
        //     ],
        //     gasBudget: 20000,
        //   })
        //   .catch((reason) => {
        //     // should not happen
        //     console.log(reason);
        //     return null;
        //   });
        // expect(sendWithPayloadTx).is.not.null;
        // // Fetch the Wormhole message emitted by the contract.
        // const wormholeMessages = await getWormholeMessagesFromTransaction(
        //   provider,
        //   WORMHOLE_ID,
        //   sendWithPayloadTx!
        // );
        // // Verify message contents.
        // const message = wormholeMessages[0];
        // expect(message.emitter).equals(HELLO_TOKEN_ID);
        // expect(message.finality).equal(0);
        // expect(message.sequence).equals("4");
        // expect(message.batchId).equals(0);
        // // Check state.
        // const helloTokenState = await getObjectFields(provider, stateId);
        // expect(helloTokenState.emitter_cap.fields.sequence).equals("0");
        // // Verify the transfer payload.
        // const transferPayload = await parseTransferPayload(message.payload);
        // expect(transferPayload.amount.toString()).to.equal(
        //   normalizedAmount.toString()
        // );
        // expect(
        //   transferPayload.fromAddress!.endsWith(
        //     helloTokenState.emitter_cap.fields.emitter
        //   )
        // ).is.true;
        // expect(transferPayload.originChain).to.equal(CHAIN_ID_SUI);
        // expect(transferPayload.targetAddress).to.equal(
        //   Buffer.alloc(32, "deadbeef").toString("hex")
        // );
        // expect(transferPayload.targetChain).to.equal(Number(foreignChain));
        // // Fetch the coin balance after transferring. The difference
        // // in balance should reflect the transformed amount, since the
        // // token being transferred has 9 decimals, and the token bridge
        // // truncates the transfer amount.
        // const coinBalanceAfter = await provider.getBalance(
        //   walletAddress,
        //   COIN_10_TYPE
        // );
        // // Compute the normalized amount for data validation.
        // const transformedAmount = tokenBridgeTransform(
        //   ethers.BigNumber.from(amount),
        //   metadata.decimals
        // );
        // expect(
        //   coinBalanceBefore.totalBalance - coinBalanceAfter.totalBalance
        // ).eq(transformedAmount.toNumber());
      });

      //     it("transfer::redeem_transfer_with_payload With Relayer", async () => {
      //       expect(localVariables.stateId).is.not.undefined;
      //       const stateId: string = localVariables.stateId;

      //       // Define transfer parameters.
      //       const tokenAddress = "0x0000000000000000000000000000000000000001";
      //       const tokenDecimals = 9;

      //       // We need to truncate the amount based on the token decimals
      //       // the same way that the token bridge does. This test will
      //       // fail if this step is not completed, since the amount
      //       // deposited in the bridge in the previous test is the truncated
      //       // amount.
      //       const rawMintAmount = Math.floor(
      //         Number(localVariables.transferAmountCoin9) / 2
      //       ).toString();
      //       const mintAmount = tokenBridgeNormalizeAmount(
      //         ethers.BigNumber.from(rawMintAmount),
      //         tokenDecimals
      //       );

      //       // Recipient wallet.
      //       const destination = await wallet
      //         .getAddress()
      //         .then((address) =>
      //           Buffer.concat([Buffer.alloc(12), Buffer.from(address, "hex")])
      //         );
      //       const payload = Buffer.concat([Buffer.alloc(1, 1), destination]);

      //       // Fetch coin balances for the relayer and recipient before
      //       // completing the transfer.
      //       const recipientBalanceBefore = await provider.getBalance(
      //         await wallet.getAddress(),
      //         COIN_10_TYPE
      //       );
      //       const relayerBalanceBefore = await provider.getBalance(
      //         await relayer.getAddress(),
      //         COIN_10_TYPE
      //       );

      //       // Create a transfer tokens with payload message.
      //       const published = ethereumTokenBridge.publishTransferTokensWithPayload(
      //         tryNativeToHexString(tokenAddress, "ethereum"),
      //         CHAIN_ID_SUI, // tokenChain
      //         BigInt(mintAmount.toString()),
      //         CHAIN_ID_SUI, // recipientChain
      //         helloTokenEmitter, // recipient
      //         foreignContractAddress, // fromAddress
      //         payload,
      //         0 // nonce
      //       );

      //       // Sign the transfer message.
      //       const signedWormholeMessage = guardians.addSignatures(published, [0]);

      //       // Execute `transfer::redeem_tokens_with_payload`
      //       const completeTransferTx = await relayer
      //         .executeMoveCall({
      //           packageObjectId: HELLO_TOKEN_ID,
      //           module: "transfer",
      //           function: "redeem_transfer_with_payload",
      //           typeArguments: [COIN_10_TYPE],
      //           arguments: [
      //             stateId,
      //             WORMHOLE_STATE_ID,
      //             TOKEN_BRIDGE_STATE_ID,
      //             Array.from(signedWormholeMessage),
      //           ],
      //           gasBudget: 20000,
      //         })
      //         .catch((reason) => {
      //           // should not happen
      //           console.log(reason);
      //           return null;
      //         });
      //       expect(completeTransferTx).is.not.null;

      //       // Fetch coin balances for the recipient and relayer after
      //       // completing the transfer.
      //       const recipientBalanceAfter = await provider.getBalance(
      //         await wallet.getAddress(),
      //         COIN_10_TYPE
      //       );
      //       const relayerBalanceAfter = await provider.getBalance(
      //         await relayer.getAddress(),
      //         COIN_10_TYPE
      //       );

      //       // Fetch the relayer fee from the hello token state.
      //       const helloTokenState = await getObjectFields(provider, stateId);
      //       const relayerFee = Number(helloTokenState.relayer_fee.fields.value);
      //       const relayerFeePrecision = Number(
      //         helloTokenState.relayer_fee.fields.precision
      //       );

      //       // Denormalize the mintAmount to compute balance changes.
      //       const denormalizedMintAmount = tokenBridgeDenormalizeAmount(
      //         mintAmount,
      //         tokenDecimals
      //       ).toNumber();

      //       // Confirm relayer balance change.
      //       const expectedRelayerBalanceChange = computeRelayerFee(
      //         denormalizedMintAmount,
      //         relayerFee,
      //         relayerFeePrecision
      //       );
      //       expect(expectedRelayerBalanceChange).to.equal(
      //         relayerBalanceAfter.totalBalance - relayerBalanceBefore.totalBalance
      //       );

      //       // Confirm recipient balance change.
      //       const expectedRecipientBalanceChange =
      //         denormalizedMintAmount - expectedRelayerBalanceChange;
      //       expect(expectedRecipientBalanceChange).to.equal(
      //         recipientBalanceAfter.totalBalance -
      //           recipientBalanceBefore.totalBalance
      //       );
      //     });

      //     it("transfer::redeem_transfer_with_payload Self Redemption", async () => {
      //       expect(localVariables.stateId).is.not.undefined;
      //       const stateId: string = localVariables.stateId;

      //       // Define transfer parameters.
      //       const tokenAddress = "0x0000000000000000000000000000000000000001";
      //       const tokenDecimals = 9;

      //       // We need to truncate the amount based on the token decimals
      //       // the same way that the token bridge does. This test will
      //       // fail if this step is not completed, since the amount
      //       // deposited in the bridge in the previous test is the truncated
      //       // amount.
      //       const rawMintAmount = Math.floor(
      //         Number(localVariables.transferAmountCoin9) / 2
      //       ).toString();
      //       const mintAmount = tokenBridgeNormalizeAmount(
      //         ethers.BigNumber.from(rawMintAmount),
      //         tokenDecimals
      //       );

      //       // Recipient wallet.
      //       const destination = await wallet
      //         .getAddress()
      //         .then((address) =>
      //           Buffer.concat([Buffer.alloc(12), Buffer.from(address, "hex")])
      //         );
      //       const payload = Buffer.concat([Buffer.alloc(1, 1), destination]);

      //       // Fetch recipient coin balance before completing the transfer.
      //       const recipientBalanceBefore = await provider.getBalance(
      //         await wallet.getAddress(),
      //         COIN_10_TYPE
      //       );

      //       // Create a transfer tokens with payload message.
      //       const published = ethereumTokenBridge.publishTransferTokensWithPayload(
      //         tryNativeToHexString(tokenAddress, "ethereum"),
      //         CHAIN_ID_SUI, // tokenChain
      //         BigInt(mintAmount.toString()),
      //         CHAIN_ID_SUI, // recipientChain
      //         helloTokenEmitter, // recipient
      //         foreignContractAddress, // fromAddress
      //         payload,
      //         0 // nonce
      //       );

      //       // Sign the transfer message.
      //       const signedWormholeMessage = guardians.addSignatures(published, [0]);

      //       // Execute `transfer::redeem_tokens_with_payload`
      //       const completeTransferTx = await wallet
      //         .executeMoveCall({
      //           packageObjectId: HELLO_TOKEN_ID,
      //           module: "transfer",
      //           function: "redeem_transfer_with_payload",
      //           typeArguments: [COIN_10_TYPE],
      //           arguments: [
      //             stateId,
      //             WORMHOLE_STATE_ID,
      //             TOKEN_BRIDGE_STATE_ID,
      //             Array.from(signedWormholeMessage),
      //           ],
      //           gasBudget: 20000,
      //         })
      //         .catch((reason) => {
      //           // should not happen
      //           console.log(reason);
      //           return null;
      //         });
      //       expect(completeTransferTx).is.not.null;

      //       // Fetch coin balances before completing the transfer.
      //       const recipientBalanceAfter = await provider.getBalance(
      //         await wallet.getAddress(),
      //         COIN_10_TYPE
      //       );

      //       // Denormalize the mintAmount to compute balance changes.
      //       const denormalizedMintAmount = tokenBridgeDenormalizeAmount(
      //         mintAmount,
      //         tokenDecimals
      //       ).toNumber();

      //       expect(denormalizedMintAmount).to.equal(
      //         recipientBalanceAfter.totalBalance -
      //           recipientBalanceBefore.totalBalance
      //       );
      //     });
      //   });
    });

    //   describe("Wrapped Ether", () => {
    //     it("transfer::send_tokens_with_payload", async () => {
    //       expect(localVariables.stateId).is.not.undefined;
    //       const stateId: string = localVariables.stateId;

    //       // Fetch wallet address.
    //       const walletAddress = await wallet.getAddress();

    //       // Set the transfer amount.
    //       const amount = "69";

    //       // Fetch sui coins to pay the wormhole fee.
    //       const wormholeFeeCoin = await getWormholeFeeCoins(provider, wallet);

    //       // Grab wrapped eth balance.
    //       const coins = await provider
    //         .getCoins(walletAddress, WRAPPED_WETH_COIN_TYPE)
    //         .then((result) => result.data);
    //       const nonzeroCoin = coins.find((coin) => coin.balance > 0);
    //       expect(nonzeroCoin!.balance > parseInt(amount)).is.true;

    //       // Split the coin object into a separate object.
    //       const splitCoin = await wallet
    //         .splitCoin({
    //           coinObjectId: nonzeroCoin!.coinObjectId,
    //           splitAmounts: [Number(amount)],
    //           gasBudget: 2000,
    //         })
    //         .then(async (tx) => {
    //           const created = await getCreatedFromTransaction(tx).then(
    //             (objects) => objects[0]
    //           );
    //           return "reference" in created ? created.reference.objectId : null;
    //         });
    //       expect(splitCoin).is.not.null;

    //       // Fetch the coin balance before transferring.
    //       const coinBalanceBefore = await provider.getBalance(
    //         walletAddress!,
    //         WRAPPED_WETH_COIN_TYPE
    //       );

    //       // Send a transfer by invoking `transfer::send_tokens_with_payload`
    //       const sendWithPayloadTx = await wallet
    //         .executeMoveCall({
    //           packageObjectId: HELLO_TOKEN_ID,
    //           module: "transfer",
    //           function: "send_tokens_with_payload",
    //           typeArguments: [WRAPPED_WETH_COIN_TYPE],
    //           arguments: [
    //             stateId,
    //             WORMHOLE_STATE_ID,
    //             TOKEN_BRIDGE_STATE_ID,
    //             splitCoin!,
    //             wormholeFeeCoin!,
    //             foreignChain,
    //             "0", // batchId
    //             Array.from(foreignContractAddress),
    //           ],
    //           gasBudget: 20000,
    //         })
    //         .catch((reason) => {
    //           // should not happen
    //           console.log(reason);
    //           return null;
    //         });
    //       expect(sendWithPayloadTx).is.not.null;

    //       // Fetch the Wormhole message emitted by the contract.
    //       const wormholeMessages = await getWormholeMessagesFromTransaction(
    //         provider,
    //         WORMHOLE_ID,
    //         sendWithPayloadTx!
    //       );

    //       // Verify message contents.
    //       const message = wormholeMessages[0];
    //       expect(message.emitter).equals(HELLO_TOKEN_ID);
    //       expect(message.finality).equal(0);
    //       expect(message.sequence).equals("5");
    //       expect(message.batchId).equals(0);

    //       // Check state.
    //       const helloTokenState = await getObjectFields(provider, stateId);
    //       expect(helloTokenState.emitter_cap.fields.sequence).equals("0");

    //       // Verify the transfer payload.
    //       const transferPayload = await parseTransferPayload(message.payload);
    //       expect(
    //         transferPayload.fromAddress!.endsWith(
    //           helloTokenState.emitter_cap.fields.emitter
    //         )
    //       ).is.true;
    //       expect(transferPayload.originChain).to.equal(CHAIN_ID_ETH);
    //       expect(transferPayload.targetAddress).to.equal(
    //         Buffer.alloc(32, "deadbeef").toString("hex")
    //       );
    //       expect(transferPayload.targetChain).to.equal(Number(foreignChain));

    //       // Fetch the coin balance after doing the transfer.
    //       const coinBalanceAfter = await provider.getBalance(
    //         walletAddress,
    //         WRAPPED_WETH_COIN_TYPE
    //       );
    //       expect(
    //         coinBalanceBefore.totalBalance - coinBalanceAfter.totalBalance
    //       ).eq(parseInt(amount));
    //     });

    //     it("transfer::redeem_transfer_with_payload With Relayer", async () => {
    //       expect(localVariables.stateId).is.not.undefined;
    //       const stateId: string = localVariables.stateId;

    //       // Set the mint amount.
    //       const mintAmount = "69000000";

    //       // Recipient wallet.
    //       const destination = await wallet
    //         .getAddress()
    //         .then((address) =>
    //           Buffer.concat([Buffer.alloc(12), Buffer.from(address, "hex")])
    //         );
    //       const payload = Buffer.concat([Buffer.alloc(1, 1), destination]);

    //       // Fetch coin balances for the relayer and recipient before
    //       // completing the transfer.
    //       const recipientBalanceBefore = await provider.getBalance(
    //         await wallet.getAddress(),
    //         WRAPPED_WETH_COIN_TYPE
    //       );
    //       const relayerBalanceBefore = await provider.getBalance(
    //         await relayer.getAddress(),
    //         WRAPPED_WETH_COIN_TYPE
    //       );

    //       // Create a transfer tokens with payload message.
    //       const published = ethereumTokenBridge.publishTransferTokensWithPayload(
    //         tryNativeToHexString(WETH_ID, "ethereum"),
    //         CHAIN_ID_ETH, // tokenChain
    //         BigInt(mintAmount.toString()),
    //         CHAIN_ID_SUI, // recipientChain
    //         helloTokenEmitter, // recipient
    //         foreignContractAddress, // fromAddress
    //         payload,
    //         0 // nonce
    //       );

    //       // Sign the transfer message.
    //       const signedWormholeMessage = guardians.addSignatures(published, [0]);

    //       // Execute `transfer::redeem_tokens_with_payload`
    //       const completeTransferTx = await relayer
    //         .executeMoveCall({
    //           packageObjectId: HELLO_TOKEN_ID,
    //           module: "transfer",
    //           function: "redeem_transfer_with_payload",
    //           typeArguments: [WRAPPED_WETH_COIN_TYPE],
    //           arguments: [
    //             stateId,
    //             WORMHOLE_STATE_ID,
    //             TOKEN_BRIDGE_STATE_ID,
    //             Array.from(signedWormholeMessage),
    //           ],
    //           gasBudget: 20000,
    //         })
    //         .catch((reason) => {
    //           // should not happen
    //           console.log(reason);
    //           return null;
    //         });
    //       expect(completeTransferTx).is.not.null;

    //       // Fetch coin balances for the recipient and relayer after
    //       // completing the transfer.
    //       const recipientBalanceAfter = await provider.getBalance(
    //         await wallet.getAddress(),
    //         WRAPPED_WETH_COIN_TYPE
    //       );
    //       const relayerBalanceAfter = await provider.getBalance(
    //         await relayer.getAddress(),
    //         WRAPPED_WETH_COIN_TYPE
    //       );

    //       // Fetch the relayer fee from the hello token state.
    //       const helloTokenState = await getObjectFields(provider, stateId);
    //       const relayerFee = Number(helloTokenState.relayer_fee.fields.value);
    //       const relayerFeePrecision = Number(
    //         helloTokenState.relayer_fee.fields.precision
    //       );

    //       // Confirm relayer balance change.
    //       const expectedRelayerBalanceChange = computeRelayerFee(
    //         Number(mintAmount),
    //         relayerFee,
    //         relayerFeePrecision
    //       );
    //       expect(expectedRelayerBalanceChange).to.equal(
    //         relayerBalanceAfter.totalBalance - relayerBalanceBefore.totalBalance
    //       );

    //       // Confirm recipient balance change.
    //       const expectedRecipientBalanceChange =
    //         Number(mintAmount) - expectedRelayerBalanceChange;
    //       expect(expectedRecipientBalanceChange).to.equal(
    //         recipientBalanceAfter.totalBalance -
    //           recipientBalanceBefore.totalBalance
    //       );
    //     });

    //     it("transfer::redeem_transfer_with_payload Self Redemption", async () => {
    //       expect(localVariables.stateId).is.not.undefined;
    //       const stateId: string = localVariables.stateId;

    //       // Set the mint amount.
    //       const mintAmount = "42000000";

    //       // Recipient wallet.
    //       const destination = await wallet
    //         .getAddress()
    //         .then((address) =>
    //           Buffer.concat([Buffer.alloc(12), Buffer.from(address, "hex")])
    //         );
    //       const payload = Buffer.concat([Buffer.alloc(1, 1), destination]);

    //       // Fetch recipient coin balance before completing the transfer.
    //       const recipientBalanceBefore = await provider.getBalance(
    //         await wallet.getAddress(),
    //         WRAPPED_WETH_COIN_TYPE
    //       );

    //       // Create a transfer tokens with payload message.
    //       const published = ethereumTokenBridge.publishTransferTokensWithPayload(
    //         tryNativeToHexString(WETH_ID, "ethereum"),
    //         CHAIN_ID_ETH, // tokenChain
    //         BigInt(mintAmount.toString()),
    //         CHAIN_ID_SUI, // recipientChain
    //         helloTokenEmitter, // recipient
    //         foreignContractAddress, // fromAddress
    //         payload,
    //         0 // nonce
    //       );

    //       // Sign the transfer message.
    //       const signedWormholeMessage = guardians.addSignatures(published, [0]);

    //       // Execute `transfer::redeem_tokens_with_payload`
    //       const completeTransferTx = await wallet
    //         .executeMoveCall({
    //           packageObjectId: HELLO_TOKEN_ID,
    //           module: "transfer",
    //           function: "redeem_transfer_with_payload",
    //           typeArguments: [WRAPPED_WETH_COIN_TYPE],
    //           arguments: [
    //             stateId,
    //             WORMHOLE_STATE_ID,
    //             TOKEN_BRIDGE_STATE_ID,
    //             Array.from(signedWormholeMessage),
    //           ],
    //           gasBudget: 20000,
    //         })
    //         .catch((reason) => {
    //           // should not happen
    //           console.log(reason);
    //           return null;
    //         });
    //       expect(completeTransferTx).is.not.null;

    //       // Fetch coin balances before completing the transfer.
    //       const recipientBalanceAfter = await provider.getBalance(
    //         await wallet.getAddress(),
    //         WRAPPED_WETH_COIN_TYPE
    //       );

    //       // Verify balance changes.
    //       expect(Number(mintAmount)).to.equal(
    //         recipientBalanceAfter.totalBalance -
    //           recipientBalanceBefore.totalBalance
    //     );
  });
});
