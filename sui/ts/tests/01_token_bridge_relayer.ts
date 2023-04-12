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
  getDynamicObjectFields,
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

      // Fetch the `foreign_contracts` dynamic field.
      const dynamicField = await provider
        .getDynamicFields({parentId: stateId})
        .then((result) =>
          result.data.filter((name) =>
            Buffer.from(name.name.value)
              .toString()
              .includes("foreign_contracts")
          )
        );

      // Grab the `registered_contracts` table from the state object.
      const registeredContracts = await getTableFromDynamicObjectField(
        provider,
        stateId,
        dynamicField[0].name!
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

      // Fetch relayer state dynamic fields.
      const dynamicField = await provider
        .getDynamicFields({parentId: stateId})
        .then((result) =>
          result.data.filter((name) =>
            Buffer.from(name.name.value).toString().includes("relayer_fees")
          )
        );

      // Fetch the `relayer_fee` dynamic field.
      const relayerFees = await getTableFromDynamicObjectField(
        provider,
        stateId,
        dynamicField[0].name!
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

      // Fetch the COIN_10 token info field.
      const targetDynamicField = await getDynamicFieldsByType(
        provider,
        state!.registered_tokens.fields.id.id,
        COIN_10_TYPE
      );
      expect(targetDynamicField.length).equals(1);

      // Fetch the fields on the dynamic field.
      const fields = await getObjectFields(
        provider,
        targetDynamicField[0].objectId // Coin 10 ID.
      ).then((result) => result!.value.fields);

      expect(fields.max_native_swap_amount).equals(coin10MaxSwapAmount);
      expect(fields.swap_enabled).is.true;
      expect(fields.swap_rate).equals(coin10SwapRate);
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

      // Fetch the COIN_8 token info field.
      const targetDynamicField = await getDynamicFieldsByType(
        provider,
        state!.registered_tokens.fields.id.id,
        COIN_8_TYPE
      );
      expect(targetDynamicField.length).equals(1);

      // Fetch the fields on the dynamic field.
      const fields = await getObjectFields(
        provider,
        targetDynamicField[0].objectId // Coin 8 ID.
      ).then((result) => result!.value.fields);

      expect(fields.max_native_swap_amount).equals(coin8MaxSwapAmount);
      expect(fields.swap_enabled).is.true;
      expect(fields.swap_rate).equals(coin8SwapRate);
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

      // Fetch the SUI token info field.
      const targetDynamicField = await getDynamicFieldsByType(
        provider,
        state!.registered_tokens.fields.id.id,
        SUI_TYPE
      );
      expect(targetDynamicField.length).equals(1);

      // Fetch the fields on the dynamic field.
      const fields = await getObjectFields(
        provider,
        targetDynamicField[0].objectId // SUI.
      ).then((result) => result!.value.fields);

      expect(fields.max_native_swap_amount).equals(suiMaxSwapAmount);
      expect(fields.swap_enabled).is.false;
      expect(fields.swap_rate).equals(suiSwapRate);
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

    // Emitter ID of the Hello Token contract formatted as a 32-byte address.
    const helloTokenEmitter = tryNativeToHexString(
      "0x0000000000000000000000000000000000000003",
      "ethereum"
    );

    describe("Coin 8", () => {
      it("Transfer tokens with relay", async () => {
        expect(localVariables.stateId).is.not.undefined;
        const stateId: string = localVariables.stateId;

        // Fetch wallet address.
        const walletAddress = await wallet.getAddress();

        // Set the transfer amount.
        localVariables.transferAmountCoin8 = "100000000";
        localVariables.toNativeAmount = "5000000";
        const amount = localVariables.transferAmountCoin8;
        const toNativeAmount = localVariables.toNativeAmount;

        // Fetch sui coins to pay the wormhole fee.
        const feeAmount = await getWormholeFee(provider);

        // Fetch coin 8.
        const coin = await getCoinWithHighestBalance(
          provider,
          walletAddress,
          COIN_8_TYPE
        );

        // Start new transaction.
        const tx = new TransactionBlock();

        // Wormhole fee coins.
        const [wormholeFee] = tx.splitCoins(tx.gas, [tx.pure(feeAmount)]);

        // Coins to transfer to the target chain.
        const [coinsToTransfer] = tx.splitCoins(tx.object(coin.coinObjectId), [
          tx.pure(amount),
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
            tx.pure(foreignContractAddress), // Placeholder.
            tx.object(SUI_CLOCK_OBJECT_ID),
          ],
          typeArguments: [COIN_8_TYPE],
        });
        const eventData = await wallet.signAndExecuteTransactionBlock({
          transactionBlock: tx,
          options: {
            showBalanceChanges: true,
            showEvents: true,
          },
        });

        // Fetch wormhole events.
        const wormholeEvents = getWormholeEvents(eventData);
        expect(wormholeEvents!.length).equals(1);

        // Parse the emitted Wormhole message and verify the payload.
        const message = wormholeEvents![0].parsedJson;
        console.log(message);

        console.log("Wormhole output");

        const dynamicFields = await provider.getDynamicFields({
          parentId: WORMHOLE_STATE_ID,
        });

        console.log(
          await provider.getDynamicFields({
            parentId: dynamicFields.data[0].objectId,
          })
        );

        // expect(message.emitter).equals(HELLO_TOKEN_ID);
        // expect(message.finality).equal(0);
        // expect(message.sequence).equals("3");
        // expect(message.batchId).equals(0);

        // // Check state.
        // const helloTokenState = await getObjectFields(provider, stateId);
        // expect(helloTokenState.emitter_cap.fields.sequence).equals("0");

        // // Verify the transfer payload.
        // const transferPayload = await parseTransferPayload(message.payload);
        // expect(transferPayload.amount.toString()).to.equal(amount);
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

        // // Fetch and validate the coin balance change after the transfer.
        // const coinBalanceAfter = await provider.getBalance(
        //   walletAddress,
        //   COIN_8_TYPE
        // );
        // expect(
        //   coinBalanceBefore.totalBalance - coinBalanceAfter.totalBalance
        // ).eq(parseInt(amount));
      });

      //     it("transfer::redeem_transfer_with_payload With Relayer", async () => {
      //       expect(localVariables.stateId).is.not.undefined;
      //       const stateId: string = localVariables.stateId;

      //       // Define transfer parameters.
      //       const tokenAddress = "0x0000000000000000000000000000000000000002";
      //       const mintAmount = Math.floor(
      //         Number(localVariables.transferAmountCoin8) / 2
      //       ).toString();
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
      //         COIN_8_TYPE
      //       );
      //       const relayerBalanceBefore = await provider.getBalance(
      //         await relayer.getAddress(),
      //         COIN_8_TYPE
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
      //           typeArguments: [COIN_8_TYPE],
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
      //         COIN_8_TYPE
      //       );
      //       const relayerBalanceAfter = await provider.getBalance(
      //         await relayer.getAddress(),
      //         COIN_8_TYPE
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

      //       // Confirm recipient balance changes.
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

      //       // Define transfer parameters.
      //       const tokenAddress = "0x0000000000000000000000000000000000000002";
      //       const mintAmount = Math.floor(
      //         Number(localVariables.transferAmountCoin8) / 2
      //       ).toString();
      //       const destination = await wallet
      //         .getAddress()
      //         .then((address) =>
      //           Buffer.concat([Buffer.alloc(12), Buffer.from(address, "hex")])
      //         );
      //       const payload = Buffer.concat([Buffer.alloc(1, 1), destination]);

      //       // Fetch recipient coin balance before completing the transfer.
      //       const recipientBalanceBefore = await provider.getBalance(
      //         await wallet.getAddress(),
      //         COIN_8_TYPE
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
      //           typeArguments: [COIN_8_TYPE],
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

      //       // Fetch recipient coin balances after the completing the transfer
      //       // and verify that the recipient received the correct number of coins.
      //       const recipientBalanceAfter = await provider.getBalance(
      //         await wallet.getAddress(),
      //         COIN_8_TYPE
      //       );

      //       // Confirm balance changes.
      //       expect(Number(mintAmount)).to.equal(
      //         recipientBalanceAfter.totalBalance -
      //           recipientBalanceBefore.totalBalance
      //       );
      //     });
      //   });

      //   describe("Coin 9", () => {
      //     it("transfer::send_tokens_with_payload", async () => {
      //       expect(localVariables.stateId).is.not.undefined;
      //       const stateId: string = localVariables.stateId;

      //       // Fetch wallet address.
      //       const walletAddress = await wallet.getAddress();

      //       // Set the transfer amount.
      //       localVariables.transferAmountCoin9 = "455";
      //       const amount = localVariables.transferAmountCoin9;

      //       // Fetch sui coins to pay the wormhole fee.
      //       const wormholeFeeCoin = await getWormholeFeeCoins(provider, wallet);

      //       // Grab COIN_10 balance.
      //       const [transferCoin] = await provider
      //         .getCoins(walletAddress, COIN_10_TYPE)
      //         .then((result) => result.data);

      //       // Fetch the coin metadata.
      //       const metadata = await provider.getCoinMetadata(COIN_10_TYPE);

      //       // Compute the normalized amount for data validation. The token
      //       // bridge normalizes transfer quantites for tokens that have
      //       // decimals greater than 8.
      //       const normalizedAmount = tokenBridgeNormalizeAmount(
      //         ethers.BigNumber.from(amount),
      //         metadata.decimals
      //       );

      //       // Split the coin object into a separate object.
      //       const splitCoin = await wallet
      //         .splitCoin({
      //           coinObjectId: transferCoin.coinObjectId,
      //           splitAmounts: [Number(amount)],
      //           gasBudget: 1000,
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
      //         COIN_10_TYPE
      //       );

      //       // Send a transfer by invoking `transfer::send_tokens_with_payload`
      //       const sendWithPayloadTx = await wallet
      //         .executeMoveCall({
      //           packageObjectId: HELLO_TOKEN_ID,
      //           module: "transfer",
      //           function: "send_tokens_with_payload",
      //           typeArguments: [COIN_10_TYPE],
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
      //       expect(message.sequence).equals("4");
      //       expect(message.batchId).equals(0);

      //       // Check state.
      //       const helloTokenState = await getObjectFields(provider, stateId);
      //       expect(helloTokenState.emitter_cap.fields.sequence).equals("0");

      //       // Verify the transfer payload.
      //       const transferPayload = await parseTransferPayload(message.payload);
      //       expect(transferPayload.amount.toString()).to.equal(
      //         normalizedAmount.toString()
      //       );
      //       expect(
      //         transferPayload.fromAddress!.endsWith(
      //           helloTokenState.emitter_cap.fields.emitter
      //         )
      //       ).is.true;
      //       expect(transferPayload.originChain).to.equal(CHAIN_ID_SUI);
      //       expect(transferPayload.targetAddress).to.equal(
      //         Buffer.alloc(32, "deadbeef").toString("hex")
      //       );
      //       expect(transferPayload.targetChain).to.equal(Number(foreignChain));

      //       // Fetch the coin balance after transferring. The difference
      //       // in balance should reflect the transformed amount, since the
      //       // token being transferred has 9 decimals, and the token bridge
      //       // truncates the transfer amount.
      //       const coinBalanceAfter = await provider.getBalance(
      //         walletAddress,
      //         COIN_10_TYPE
      //       );

      //       // Compute the normalized amount for data validation.
      //       const transformedAmount = tokenBridgeTransform(
      //         ethers.BigNumber.from(amount),
      //         metadata.decimals
      //       );
      //       expect(
      //         coinBalanceBefore.totalBalance - coinBalanceAfter.totalBalance
      //       ).eq(transformedAmount.toNumber());
      //     });

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
});
