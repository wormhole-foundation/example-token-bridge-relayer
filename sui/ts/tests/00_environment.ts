import {expect} from "chai";
import * as path from "path";
import {ethers} from "ethers";
import {
  CHAIN_ID_SUI,
  tryNativeToHexString,
  tryNativeToUint8Array,
} from "@certusone/wormhole-sdk";
import * as mock from "@certusone/wormhole-sdk/lib/cjs/mock";
import {
  ETHEREUM_TOKEN_BRIDGE_ADDRESS,
  GOVERNANCE_EMITTER_ID,
  GUARDIAN_PRIVATE_KEY,
  WALLET_PRIVATE_KEY,
  TOKEN_BRIDGE_ID,
  WORMHOLE_ID,
  RELAYER_PRIVATE_KEY,
  WETH_ID,
  CREATOR_PRIVATE_KEY,
  RAW_CREATOR_KEY,
  WORMHOLE_FEE,
  GOVERNANCE_CHAIN,
  WORMHOLE_STATE_ID,
  TOKEN_BRIDGE_STATE_ID,
  COIN_10_TREASURY_ID,
  COIN_8_TREASURY_ID,
  COIN_8_TYPE,
  COIN_10_TYPE,
  WRAPPED_WETH_ID,
  WRAPPED_WETH_COIN_TYPE,
  unexpected,
} from "./helpers";
import {
  Ed25519Keypair,
  JsonRpcProvider,
  localnetConnection,
  RawSigner,
  TransactionBlock,
  SUI_CLOCK_OBJECT_ID,
} from "@mysten/sui.js";
import {
  buildAndDeployWrappedCoin,
  getTableFromDynamicObjectField,
  getWormholeFee,
  getObjectFields,
} from "../src";

describe("0: Wormhole", () => {
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

  // for governance actions to modify programs
  const governance = new mock.GovernanceEmitter(GOVERNANCE_EMITTER_ID, 20);

  // Ethereum mock token bridge.
  const ethereumTokenBridge = new mock.MockEthereumTokenBridge(
    ETHEREUM_TOKEN_BRIDGE_ADDRESS
  );

  describe("Environment", () => {
    it("Variables", () => {
      expect(process.env.TESTING_WORMHOLE_ID).is.not.undefined;
      expect(process.env.TESTING_WORMHOLE_STATE_ID).is.not.undefined;
      expect(process.env.TESTING_TOKEN_BRIDGE_ID).is.not.undefined;
      expect(process.env.TESTING_TOKEN_BRIDGE_STATE_ID).is.not.undefined;
      expect(process.env.TESTING_EXAMPLE_COINS_ID).is.not.undefined;
      expect(process.env.TESTING_COIN_8_TREASURY_ID).is.not.undefined;
      expect(process.env.TESTING_COIN_10_TREASURY_ID).is.not.undefined;
      expect(process.env.TESTING_WRAPPED_WETH_COIN_TYPE).is.not.undefined;
      expect(process.env.TESTING_WRAPPED_WETH_ID).is.not.undefined;
    });
  });

  describe("Verify Local Validator", () => {
    it("Balance", async () => {
      // Balance check wallet.
      {
        const coinData = await wallet
          .getAddress()
          .then((address) =>
            provider.getCoins({owner: address}).then((result) => result.data)
          );
        for (const coin of coinData) {
          expect(coin.balance).equals(30000000000000000);
        }
      }

      // Balance check relayer.
      {
        const coinData = await relayer
          .getAddress()
          .then((address) =>
            provider.getCoins({owner: address}).then((result) => result.data)
          );
        for (const coin of coinData) {
          expect(coin.balance).equals(30000000000000000);
        }
      }
    });

    it("Mint and transfer example coins", async () => {
      const walletAddress = await wallet.getAddress();

      // COIN_10
      {
        const metadata = await provider.getCoinMetadata({
          coinType: COIN_10_TYPE,
        });
        expect(metadata.decimals).equals(10);

        // Format the amount based on the coin decimals.
        const amount = ethers.utils
          .parseUnits("69420", metadata.decimals)
          .add(10) // for outbound transfer later
          .toString();

        // Mint and transfer the coins.
        const tx = new TransactionBlock();
        tx.moveCall({
          target: "0x2::coin::mint_and_transfer",
          arguments: [
            tx.object(COIN_10_TREASURY_ID),
            tx.pure(amount),
            tx.pure(walletAddress),
          ],
          typeArguments: [COIN_10_TYPE],
        });
        const result = await creator.signAndExecuteTransactionBlock({
          transactionBlock: tx,
        });
        expect(result.digest).is.not.null;

        // Check balance on wallet.
        const balance = await provider.getBalance({
          owner: walletAddress,
          coinType: COIN_10_TYPE,
        });
        expect(balance.coinObjectCount).equals(1);
        expect(balance.totalBalance.toString()).equals(amount);
      }

      // COIN_8
      {
        const metadata = await provider.getCoinMetadata({
          coinType: COIN_8_TYPE,
        });
        expect(metadata.decimals).equals(8);

        // Format the amount based on the coin decimals.
        const amount = ethers.utils
          .parseUnits("42069", metadata.decimals)
          .add(10) // for outbound transfer later
          .toString();

        // Mint and transfer the coins.
        const tx = new TransactionBlock();
        tx.moveCall({
          target: "0x2::coin::mint_and_transfer",
          arguments: [
            tx.object(COIN_8_TREASURY_ID),
            tx.pure(amount),
            tx.pure(walletAddress),
          ],
          typeArguments: [COIN_8_TYPE],
        });
        const result = await creator.signAndExecuteTransactionBlock({
          transactionBlock: tx,
        });
        expect(result.digest).is.not.null;

        // Check balance on wallet.
        const balance = await provider.getBalance({
          owner: walletAddress,
          coinType: COIN_8_TYPE,
        });
        expect(balance.coinObjectCount).equals(1);
        expect(balance.totalBalance.toString()).equals(amount);
      }
    });

    it("Register foreign emitter (Ethereum)", async () => {
      // Create an emitter registration VAA.
      const message = governance.publishTokenBridgeRegisterChain(
        0, // timestamp
        2,
        ETHEREUM_TOKEN_BRIDGE_ADDRESS
      );
      const signedWormholeMessage = guardians.addSignatures(message, [0]);

      // Register an emitter from Ethereum on the token bridge.
      {
        const tx = new TransactionBlock();
        tx.moveCall({
          target: `${TOKEN_BRIDGE_ID}::register_chain::register_chain`,
          arguments: [
            tx.object(TOKEN_BRIDGE_STATE_ID),
            tx.object(WORMHOLE_STATE_ID),
            tx.pure(Array.from(signedWormholeMessage)),
            tx.object(SUI_CLOCK_OBJECT_ID),
          ],
        });
        const result = await creator.signAndExecuteTransactionBlock({
          transactionBlock: tx,
        });
        expect(result.digest).is.not.null;
      }
    });

    // Before any coin can be transferred out, it needs to be attested for.
    it("Attest native coins", async () => {
      const wallletAddress = await wallet.getAddress();

      // Fetch Sui object to pay wormhole fees with.
      const feeAmount = await getWormholeFee(provider);

      // COIN_10
      {
        // Coin 10 metadata and nonce.
        const metadata = await provider.getCoinMetadata({
          coinType: COIN_10_TYPE,
        });
        const nonce = 69;

        // Call `token_bridge::attest_token` on Token Bridge.
        const tx = new TransactionBlock();
        const [wormholeFee] = tx.splitCoins(tx.gas, [tx.pure(feeAmount)]);
        tx.moveCall({
          target: `${TOKEN_BRIDGE_ID}::attest_token::attest_token`,
          arguments: [
            tx.object(TOKEN_BRIDGE_STATE_ID),
            tx.object(WORMHOLE_STATE_ID),
            wormholeFee,
            tx.object(metadata.id!),
            tx.pure(nonce),
            tx.object(SUI_CLOCK_OBJECT_ID),
          ],
          typeArguments: [COIN_10_TYPE],
        });
        const eventData = await wallet
          .signAndExecuteTransactionBlock({
            transactionBlock: tx,
            options: {
              showEvents: true,
            },
          })
          .then((result) => {
            if ("events" in result && result.events?.length == 1) {
              return result.events[0];
            }

            throw new Error("event not found");
          });

        // Verify that the attest message was published.
        expect(eventData.transactionModule).equal("attest_token");
        expect(eventData.parsedJson!.nonce).equals(nonce);
        expect(eventData.parsedJson!.sequence).equals("0");

        // Verify that a token was registered in the token bridge state.
        const tokenBridgeState = await getObjectFields(
          provider,
          TOKEN_BRIDGE_STATE_ID
        );
        expect(tokenBridgeState!.token_registry.fields.num_native).equals("1");
      }

      // COIN_8
      {
        // Coin 8 metadata and nonce.
        const metadata = await provider.getCoinMetadata({
          coinType: COIN_8_TYPE,
        });
        const nonce = 420;

        // Call `token_bridge::attest_token` on Token Bridge.
        const tx = new TransactionBlock();
        const [wormholeFee] = tx.splitCoins(tx.gas, [tx.pure(feeAmount)]);
        tx.moveCall({
          target: `${TOKEN_BRIDGE_ID}::attest_token::attest_token`,
          arguments: [
            tx.object(TOKEN_BRIDGE_STATE_ID),
            tx.object(WORMHOLE_STATE_ID),
            wormholeFee,
            tx.object(metadata.id!),
            tx.pure(nonce),
            tx.object(SUI_CLOCK_OBJECT_ID),
          ],
          typeArguments: [COIN_8_TYPE],
        });
        const eventData = await wallet
          .signAndExecuteTransactionBlock({
            transactionBlock: tx,
            options: {
              showEvents: true,
            },
          })
          .then((result) => {
            if ("events" in result && result.events?.length == 1) {
              return result.events[0];
            }

            throw new Error("event not found");
          });

        // Verify that the attest message was published.
        expect(eventData.transactionModule).equal("attest_token");
        expect(eventData.parsedJson!.nonce).equals(nonce);
        expect(eventData.parsedJson!.sequence).equals("1");

        // Verify that a token was registered in the token bridge state.
        const tokenBridgeState = await getObjectFields(
          provider,
          TOKEN_BRIDGE_STATE_ID
        );
        expect(tokenBridgeState!.token_registry.fields.num_native).equals("2");
      }
    });
  });

  // it("Attest Sui", async () => {));

  // it("Attest WETH from Ethereum", async () => {
  //   // Create an attestation VAA.
  //   const published = ethereumTokenBridge.publishAttestMeta(
  //     WETH_ID,
  //     18,
  //     "WETH",
  //     "Wrapped Ether"
  //   );

  //   // Sign the VAA.
  //   const signedWormholeMessage = guardians.addSignatures(published, [0]);

  //   // Deploy wrapped coin using template.
  //   const fullPathToTokenBridgeDependency = path.resolve(
  //     `${__dirname}/../../dependencies/token_bridge`
  //   );
  //   const deployedCoinInfo = buildAndDeployWrappedCoin(
  //     WORMHOLE_ID,
  //     TOKEN_BRIDGE_ID,
  //     fullPathToTokenBridgeDependency,
  //     signedWormholeMessage,
  //     "worm sui deploy",
  //     RAW_CREATOR_KEY
  //   );
  //   expect(deployedCoinInfo.id).equals(WRAPPED_WETH_ID);

  // const newWrappedCoinType = `${TOKEN_BRIDGE_ID}::wrapped_coin::WrappedCoin<${WRAPPED_WETH_COIN_TYPE}>`;
  // expect(deployedCoinInfo.type).equals(newWrappedCoinType);

  // // Execute `create_wrapped::register_wrapped_coin` on Token Bridge.
  // // The deployer keypair originally created this coin, so we must use
  // // `creator` to execute the call.
  // const registerWrappedCoinTx = await creator
  //   .executeMoveCall({
  //     packageObjectId: TOKEN_BRIDGE_ID,
  //     module: "create_wrapped",
  //     function: "register_wrapped_coin",
  //     typeArguments: [WRAPPED_WETH_COIN_TYPE],
  //     arguments: [TOKEN_BRIDGE_STATE_ID, WORMHOLE_STATE_ID, WRAPPED_WETH_ID],
  //     gasBudget: 20000,
  //   })
  //   .catch((reason) => {
  //     // should not happen
  //     console.log(reason);
  //     return null;
  //   });
  // expect(registerWrappedCoinTx).is.not.null;

  // // Check state.
  // const tokenBridgeState = await getObjectFields(
  //   provider,
  //   TOKEN_BRIDGE_STATE_ID
  // );

  // // Fetch the wrapped asset info
  // const registeredTokens = tokenBridgeState.registered_tokens.fields;
  // expect(registeredTokens.num_native).to.equal("2");

  // // Wrapped token count should've upticked.
  // expect(registeredTokens.num_wrapped).to.equal("1");

  // // Fetch the wrapped asset info.
  // const wrappedAssetInfo = await getRegisteredAssetInfo(
  //   provider,
  //   registeredTokens.id.id,
  //   WRAPPED_WETH_COIN_TYPE
  // );

  // const treasuryCap = wrappedAssetInfo!.value.fields.treasury_cap.fields;
  // expect(treasuryCap.total_supply.fields.value).equals("0");
  // });

  //     it("Mint WETH to Wallets", async () => {
  //       const rawAmount = ethers.utils.parseEther("69420");
  //       const unitDifference = ethers.BigNumber.from("10").pow(18 - 8);
  //       const mintAmount = rawAmount.div(unitDifference).toString();

  //       // Recipient's wallet.
  //       const destinationBytes = await wallet
  //         .getAddress()
  //         .then((address) =>
  //           Buffer.concat([Buffer.alloc(12), Buffer.from(address, "hex")])
  //         );

  //       // Create a token transfer VAA.
  //       const published = ethereumTokenBridge.publishTransferTokens(
  //         tryNativeToHexString(WETH_ID, "ethereum"),
  //         2, // tokenChain
  //         BigInt(mintAmount),
  //         CHAIN_ID_SUI, // recipientChain
  //         destinationBytes.toString("hex"),
  //         0n
  //       );

  //       // Sign the transfer message.
  //       const signedWormholeMessage = guardians.addSignatures(published, [0]);

  //       // Grab the destination wallet's address. This will be used as a place
  //       // holder for the fee recipient. No fee will be paid out.
  //       const desitnationAddress = await wallet
  //         .getAddress()
  //         .then((address) => ethers.utils.hexlify(Buffer.from(address, "hex")));

  //       // Execute `complete_transfer::complete_transfer` on Token Bridge.
  //       const completeTransferTx = await wallet
  //         .executeMoveCall({
  //           packageObjectId: TOKEN_BRIDGE_ID,
  //           module: "complete_transfer",
  //           function: "complete_transfer",
  //           typeArguments: [WRAPPED_WETH_COIN_TYPE],
  //           arguments: [
  //             TOKEN_BRIDGE_STATE_ID,
  //             WORMHOLE_STATE_ID,
  //             Array.from(signedWormholeMessage),
  //             desitnationAddress,
  //           ],
  //           gasBudget: 20000,
  //         })
  //         .catch((reason) => {
  //           // should not happen
  //           console.log(reason);
  //           return null;
  //         });
  //       expect(completeTransferTx).is.not.null;

  //       // Fetch the wrapped asset's coin object after the transfer to
  //       // verify that the tokens were minted to the recipient.
  //       const coins = await provider
  //         .getCoins(desitnationAddress, WRAPPED_WETH_COIN_TYPE)
  //         .then((result) => result.data);
  //       const nonzeroCoin = coins.find((coin) => coin.balance > 0);
  //       expect(nonzeroCoin).is.not.undefined;

  //       expect(
  //         ethers.BigNumber.from(nonzeroCoin!.balance)
  //           .mul(unitDifference)
  //           .eq(rawAmount)
  //       ).is.true;
  //     });
  //   });
  // });
});
