import {expect, use as chaiUse} from "chai";
import chaiAsPromised from "chai-as-promised";
chaiUse(chaiAsPromised);
import {Connection, PublicKey} from "@solana/web3.js";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from "@solana/spl-token";
import {CHAINS, ChainId} from "@certusone/wormhole-sdk";
import * as mock from "@certusone/wormhole-sdk/lib/cjs/mock";
import {getTokenBridgeDerivedAccounts} from "@certusone/wormhole-sdk/lib/cjs/solana";
import * as wormhole from "@certusone/wormhole-sdk/lib/cjs/solana/wormhole";
import * as tokenBridgeRelayer from "../sdk/";
import {BN} from "@coral-xyz/anchor";
import {
  LOCALHOST,
  PAYER_KEYPAIR,
  RELAYER_KEYPAIR,
  FEE_RECIPIENT_KEYPAIR,
  ASSISTANT_KEYPAIR,
  WORMHOLE_CONTRACTS,
  CORE_BRIDGE_PID,
  TOKEN_BRIDGE_PID,
  deriveMaliciousTokenBridgeEndpointKey,
  programIdFromEnvVar,
  boilerPlateReduction,
  fetchTestTokens,
  getRandomInt,
  verifyRelayerMessage,
  tokenBridgeTransform,
  tokenBridgeNormalizeAmount,
  calculateRelayerFee,
} from "./helpers";

// The default pecision value used in the token bridge relayer program.
const CONTRACT_PRECISION = 100000000;
const TOKEN_BRIDGE_RELAYER_PID = programIdFromEnvVar(
  "TOKEN_BRIDGE_RELAYER_PROGRAM_ID"
);
const ETHEREUM_TOKEN_BRIDGE_ADDRESS = WORMHOLE_CONTRACTS.ethereum.token_bridge;

describe(" 1: Token Bridge Relayer", function () {
  const connection = new Connection(LOCALHOST, "processed");
  // payer is also the recipient in all tests
  const payer = PAYER_KEYPAIR;
  const relayer = RELAYER_KEYPAIR;
  const feeRecipient = FEE_RECIPIENT_KEYPAIR;
  const assistant = ASSISTANT_KEYPAIR;

  const {
    guardianSign,
    postSignedMsgAsVaaOnSolana,
    expectIxToSucceed,
    expectIxToFailWithError,
  } = boilerPlateReduction(connection, payer);

  const foreignChain = CHAINS.ethereum;
  const invalidChain = (foreignChain + 1) as ChainId;
  const foreignContractAddress = Buffer.alloc(32, "deadbeef", "hex");
  const unregisteredContractAddress = Buffer.alloc(32, "deafbeef", "hex");
  const foreignTokenBridge = new mock.MockEthereumTokenBridge(
    ETHEREUM_TOKEN_BRIDGE_ADDRESS,
    200
  );
  const program = tokenBridgeRelayer.createTokenBridgeRelayerProgramInterface(
    connection,
    TOKEN_BRIDGE_RELAYER_PID
  );

  describe("Initialize Program", function () {
    // Expected relayer fee and swap rate precisions.
    const newRelayerFeePrecision = 100_000_000;
    const newSwapRatePrecision = 100_000_000;

    const createInitializeIx = (opts?: {
      feeRecipient?: PublicKey;
      assistant?: PublicKey;
    }) =>
      tokenBridgeRelayer.createInitializeInstruction(
        connection,
        TOKEN_BRIDGE_RELAYER_PID,
        payer.publicKey,
        TOKEN_BRIDGE_PID,
        CORE_BRIDGE_PID,
        opts?.feeRecipient ?? feeRecipient.publicKey,
        opts?.assistant ?? assistant.publicKey
      );

    it("Cannot Initialize With Default Fee Recipient", async function () {
      await expectIxToFailWithError(
        await createInitializeIx({feeRecipient: PublicKey.default}),
        "InvalidPublicKey"
      );
    });

    it("Cannot Initialize With Default Assistant", async function () {
      await expectIxToFailWithError(
        await createInitializeIx({assistant: PublicKey.default}),
        "InvalidPublicKey"
      );
    });

    it("Finally Initialize Program", async function () {
      await expectIxToSucceed(createInitializeIx());

      const ownerConfigData = await tokenBridgeRelayer.getOwnerConfigData(
        connection,
        TOKEN_BRIDGE_RELAYER_PID
      );
      expect(ownerConfigData.owner).deep.equals(payer.publicKey);
      expect(ownerConfigData.assistant).deep.equals(assistant.publicKey);

      const senderConfigData = await tokenBridgeRelayer.getSenderConfigData(
        connection,
        TOKEN_BRIDGE_RELAYER_PID
      );
      expect(senderConfigData.owner).deep.equals(payer.publicKey);
      expect(senderConfigData.finality).equals(0);

      const tokenBridgeAccounts = getTokenBridgeDerivedAccounts(
        TOKEN_BRIDGE_RELAYER_PID,
        TOKEN_BRIDGE_PID,
        CORE_BRIDGE_PID
      );

      (
        [
          ["config", "tokenBridgeConfig"],
          ["authoritySigner", "tokenBridgeAuthoritySigner"],
          ["custodySigner", "tokenBridgeCustodySigner"],
          ["wormholeBridge", "wormholeBridge"],
          ["emitter", "tokenBridgeEmitter"],
          ["wormholeFeeCollector", "wormholeFeeCollector"],
          ["sequence", "tokenBridgeSequence"],
        ] as [
          keyof typeof senderConfigData.tokenBridge,
          keyof typeof tokenBridgeAccounts
        ][]
      ).forEach(([lhs, rhs]) =>
        expect(senderConfigData.tokenBridge[lhs]).deep.equals(
          tokenBridgeAccounts[rhs]
        )
      );

      const redeemerConfigData = await tokenBridgeRelayer.getRedeemerConfigData(
        connection,
        TOKEN_BRIDGE_RELAYER_PID
      );
      expect(redeemerConfigData.owner).deep.equals(payer.publicKey);
      expect(redeemerConfigData.relayerFeePrecision.toString()).equals(
        newRelayerFeePrecision.toString()
      );
      expect(redeemerConfigData.swapRatePrecision).equals(newSwapRatePrecision);
      expect(redeemerConfigData.feeRecipient.toString()).equals(
        feeRecipient.publicKey.toString()
      );
      (
        [
          ["config", "tokenBridgeConfig"],
          ["custodySigner", "tokenBridgeCustodySigner"],
          ["mintAuthority", "tokenBridgeMintAuthority"],
        ] as [
          keyof typeof redeemerConfigData.tokenBridge,
          keyof typeof tokenBridgeAccounts
        ][]
      ).forEach(([lhs, rhs]) =>
        expect(redeemerConfigData.tokenBridge[lhs]).deep.equals(
          tokenBridgeAccounts[rhs]
        )
      );
    });

    it("Cannot Call Instruction Again: initialize", async function () {
      await expectIxToFailWithError(
        await createInitializeIx({
          feeRecipient: feeRecipient.publicKey,
          assistant: assistant.publicKey,
        }),
        "already in use"
      );
    });
  });

  describe("Transfer Ownership", async function () {
    // Create the submit ownership transfer instruction, which will be used
    // to set the pending owner to the `relayer` key.
    const createSubmitOwnershipTransferIx = (opts?: {
      sender?: PublicKey;
      newOwner?: PublicKey;
    }) =>
      tokenBridgeRelayer.createSubmitOwnershipTransferInstruction(
        connection,
        TOKEN_BRIDGE_RELAYER_PID,
        opts?.sender ?? payer.publicKey,
        opts?.newOwner ?? relayer.publicKey
      );

    // Create the confirm ownership transfer instruction, which will be used
    // to set the new owner to the `relayer` key.
    const createConfirmOwnershipTransferIx = (opts?: {sender?: PublicKey}) =>
      tokenBridgeRelayer.createConfirmOwnershipTransferInstruction(
        connection,
        TOKEN_BRIDGE_RELAYER_PID,
        opts?.sender ?? relayer.publicKey
      );

    // Instruction to cancel an ownership transfer request.
    const createCancelOwnershipTransferIx = (opts?: {sender?: PublicKey}) =>
      tokenBridgeRelayer.createCancelOwnershipTransferInstruction(
        connection,
        TOKEN_BRIDGE_RELAYER_PID,
        opts?.sender ?? payer.publicKey
      );

    it("Cannot Submit Ownership Transfer Request (New Owner == Address(0))", async function () {
      await expectIxToFailWithError(
        await createSubmitOwnershipTransferIx({
          newOwner: PublicKey.default,
        }),
        "InvalidPublicKey"
      );
    });

    it("Cannot Submit Ownership Transfer Request (New Owner == Owner)", async function () {
      await expectIxToFailWithError(
        await createSubmitOwnershipTransferIx({
          newOwner: payer.publicKey,
        }),
        "AlreadyTheOwner",
        payer
      );
    });

    it("Cannot Submit Ownership Transfer Request as Non-Owner", async function () {
      await expectIxToFailWithError(
        await createSubmitOwnershipTransferIx({
          sender: relayer.publicKey,
        }),
        "OwnerOnly",
        relayer
      );
    });

    it("Submit Ownership Transfer Request as Owner", async function () {
      await expectIxToSucceed(createSubmitOwnershipTransferIx());

      // Confirm that the pending owner variable is set in the owner config.
      const ownerConfigData = await tokenBridgeRelayer.getOwnerConfigData(
        connection,
        TOKEN_BRIDGE_RELAYER_PID
      );

      expect(ownerConfigData.pendingOwner).deep.equals(relayer.publicKey);
    });

    it("Cannot Confirm Ownership Transfer Request as Non Pending Owner", async function () {
      await expectIxToFailWithError(
        await createConfirmOwnershipTransferIx({
          sender: assistant.publicKey,
        }),
        "NotPendingOwner",
        assistant
      );
    });

    it("Confirm Ownership Transfer Request as Pending Owner", async function () {
      await expectIxToSucceed(createConfirmOwnershipTransferIx(), relayer);

      // Confirm that the owner config reflects the current ownership status.
      {
        const ownerConfigData = await tokenBridgeRelayer.getOwnerConfigData(
          connection,
          TOKEN_BRIDGE_RELAYER_PID
        );
        expect(ownerConfigData.owner).deep.equals(relayer.publicKey);
        expect(ownerConfigData.pendingOwner).deep.equals(null);
      }

      // Set the owner back to the payer key.
      await expectIxToSucceed(
        createSubmitOwnershipTransferIx({
          sender: relayer.publicKey,
          newOwner: payer.publicKey,
        }),
        relayer
      );

      await expectIxToSucceed(
        createConfirmOwnershipTransferIx({sender: payer.publicKey}),
        payer
      );

      // Confirm that the payer is the owner again.
      {
        const ownerConfigData = await tokenBridgeRelayer.getOwnerConfigData(
          connection,
          TOKEN_BRIDGE_RELAYER_PID
        );
        expect(ownerConfigData.owner).deep.equals(payer.publicKey);
        expect(ownerConfigData.pendingOwner).deep.equals(null);
      }
    });

    it("Cannot Cancel Ownership Request as Non-Owner", async function () {
      // First, submit the ownership transfer request.
      await expectIxToSucceed(createSubmitOwnershipTransferIx());

      // Confirm that the pending owner variable is set in the owner config.
      {
        const ownerConfigData = await tokenBridgeRelayer.getOwnerConfigData(
          connection,
          TOKEN_BRIDGE_RELAYER_PID
        );
        expect(ownerConfigData.pendingOwner).deep.equals(relayer.publicKey);
      }

      // Confirm that the cancel ownership transfer request fails.
      await expectIxToFailWithError(
        await createCancelOwnershipTransferIx({sender: relayer.publicKey}),
        "OwnerOnly",
        relayer
      );
    });

    it("Cancel Ownership Request as Owner", async function () {
      await expectIxToSucceed(createCancelOwnershipTransferIx());

      // Confirm the pending owner field was reset.
      const ownerConfigData = await tokenBridgeRelayer.getOwnerConfigData(
        connection,
        TOKEN_BRIDGE_RELAYER_PID
      );
      expect(ownerConfigData.pendingOwner).deep.equals(null);
    });
  });

  describe("Update Relayer Fee Precision", function () {
    const relayerFeePrecision = 1_000_000_000;

    const createUpdateRelayerFeePrecisionIx = (opts?: {
      sender?: PublicKey;
      relayerFeePrecision?: number;
    }) =>
      tokenBridgeRelayer.createUpdateRelayerFeePrecisionInstruction(
        connection,
        TOKEN_BRIDGE_RELAYER_PID,
        opts?.sender ?? payer.publicKey,
        opts?.relayerFeePrecision ?? relayerFeePrecision
      );

    it("Cannot Update as Non-Owner", async function () {
      await expectIxToFailWithError(
        await createUpdateRelayerFeePrecisionIx({
          sender: relayer.publicKey,
        }),
        "OwnerOnly",
        relayer
      );
    });

    it("Cannot Update With relayer_fee_precision == 0", async function () {
      await expectIxToFailWithError(
        await createUpdateRelayerFeePrecisionIx({relayerFeePrecision: 0}),
        "InvalidPrecision"
      );
    });

    it("Finally Update Relayer Fee Precision", async function () {
      await expectIxToSucceed(createUpdateRelayerFeePrecisionIx());

      // Verify state changes.
      const redeemerConfigData = await tokenBridgeRelayer.getRedeemerConfigData(
        connection,
        TOKEN_BRIDGE_RELAYER_PID
      );
      expect(redeemerConfigData.relayerFeePrecision).equals(
        relayerFeePrecision
      );

      const senderConfigData = await tokenBridgeRelayer.getRedeemerConfigData(
        connection,
        TOKEN_BRIDGE_RELAYER_PID
      );
      expect(senderConfigData.relayerFeePrecision).equals(relayerFeePrecision);

      // Set the precision back to the default.
      await expectIxToSucceed(
        createUpdateRelayerFeePrecisionIx({
          relayerFeePrecision: CONTRACT_PRECISION,
        })
      );
    });
  });

  describe("Update Swap Rate Precision", function () {
    const swapRatePrecision = 1_000_000_000;

    const createUpdateSwapRatePrecisionIx = (opts?: {
      sender?: PublicKey;
      swapRatePrecision?: number;
    }) =>
      tokenBridgeRelayer.createUpdateSwapRatePrecisionInstruction(
        connection,
        TOKEN_BRIDGE_RELAYER_PID,
        opts?.sender ?? payer.publicKey,
        opts?.swapRatePrecision ?? swapRatePrecision
      );

    it("Cannot Update as Non-Owner", async function () {
      await expectIxToFailWithError(
        await createUpdateSwapRatePrecisionIx({
          sender: assistant.publicKey,
        }),
        "OwnerOnly",
        assistant
      );
    });

    it("Cannot Update With relayer_fee_precision == 0", async function () {
      await expectIxToFailWithError(
        await createUpdateSwapRatePrecisionIx({swapRatePrecision: 0}),
        "InvalidPrecision"
      );
    });

    it("Finally Update Swap Rate Precision", async function () {
      await expectIxToSucceed(createUpdateSwapRatePrecisionIx());

      // Verify state changes.
      const redeemerConfigData = await tokenBridgeRelayer.getRedeemerConfigData(
        connection,
        TOKEN_BRIDGE_RELAYER_PID
      );
      expect(redeemerConfigData.swapRatePrecision).equals(swapRatePrecision);

      const senderConfigData = await tokenBridgeRelayer.getSenderConfigData(
        connection,
        TOKEN_BRIDGE_RELAYER_PID
      );
      expect(senderConfigData.swapRatePrecision).equals(swapRatePrecision);

      // Set the precision back to the default.
      await expectIxToSucceed(
        createUpdateSwapRatePrecisionIx({
          swapRatePrecision: CONTRACT_PRECISION,
        })
      );
    });
  });

  describe("Register Foreign Emitter", function () {
    const createRegisterForeignContractIx = (opts?: {
      sender?: PublicKey;
      contractAddress?: Buffer;
    }) =>
      tokenBridgeRelayer.createRegisterForeignContractInstruction(
        connection,
        TOKEN_BRIDGE_RELAYER_PID,
        opts?.sender ?? payer.publicKey,
        TOKEN_BRIDGE_PID,
        foreignChain,
        opts?.contractAddress ?? foreignContractAddress,
        ETHEREUM_TOKEN_BRIDGE_ADDRESS
      );

    it("Cannot Update as Non-Owner", async function () {
      const contractAddress = Buffer.alloc(32, "fbadc0de", "hex");
      await expectIxToFailWithError(
        await createRegisterForeignContractIx({
          sender: relayer.publicKey,
          contractAddress,
        }),
        "OwnerOnly",
        relayer
      );
    });

    [CHAINS.unset, CHAINS.solana].forEach((chain) =>
      it(`Cannot Register Chain ID == ${chain}`, async function () {
        await expectIxToFailWithError(
          await program.methods
            .registerForeignContract(chain, [...foreignContractAddress])
            .accounts({
              owner: payer.publicKey,
              config: tokenBridgeRelayer.deriveSenderConfigKey(
                TOKEN_BRIDGE_RELAYER_PID
              ),
              foreignContract: tokenBridgeRelayer.deriveForeignContractKey(
                TOKEN_BRIDGE_RELAYER_PID,
                chain
              ),
              tokenBridgeForeignEndpoint: deriveMaliciousTokenBridgeEndpointKey(
                TOKEN_BRIDGE_PID,
                chain,
                Buffer.alloc(32)
              ),
              tokenBridgeProgram: new PublicKey(TOKEN_BRIDGE_PID),
            })
            .instruction(),
          "InvalidForeignContract"
        );
      })
    );

    it("Cannot Register Zero Address", async function () {
      await expectIxToFailWithError(
        await createRegisterForeignContractIx({
          contractAddress: Buffer.alloc(32),
        }),
        "InvalidForeignContract"
      );
    });

    it("Cannot Register Contract Address Length != 32", async function () {
      await expectIxToFailWithError(
        await createRegisterForeignContractIx({
          contractAddress: foreignContractAddress.subarray(0, 31),
        }),
        "InstructionDidNotDeserialize"
      );
    });

    [Buffer.alloc(32, "fbadc0de", "hex"), foreignContractAddress].forEach(
      (contractAddress) =>
        it(`Register ${
          contractAddress === foreignContractAddress ? "Final" : "Random"
        } Address`, async function () {
          await expectIxToSucceed(
            createRegisterForeignContractIx({contractAddress})
          );

          const {chain, address} =
            await tokenBridgeRelayer.getForeignContractData(
              connection,
              TOKEN_BRIDGE_RELAYER_PID,
              foreignChain
            );
          expect(chain).equals(foreignChain);
          expect(address).deep.equals(contractAddress);
        })
    );
  });

  describe("Update Relayer Fee", async function () {
    const relayerFee = getRandomInt(
      CONTRACT_PRECISION,
      CONTRACT_PRECISION * 100000
    );

    const createUpdateRelayerFeeIx = (opts?: {
      sender?: PublicKey;
      chain?: ChainId;
      relayerFee?: BN;
    }) =>
      tokenBridgeRelayer.createUpdateRelayerFeeInstruction(
        connection,
        TOKEN_BRIDGE_RELAYER_PID,
        opts?.sender ?? payer.publicKey,
        opts?.chain ?? foreignChain,
        opts?.relayerFee ?? new BN(relayerFee)
      );

    it("Cannot Update Relayer Fee as Non-Owner", async function () {
      await expectIxToFailWithError(
        await createUpdateRelayerFeeIx({sender: relayer.publicKey}),
        "OwnerOnly",
        relayer
      );
    });

    it("Cannot Update Relayer Fee for Unregistered Chain", async function () {
      let result = false;
      try {
        await expectIxToSucceed(
          await createUpdateRelayerFeeIx({
            relayerFee: new BN(69),
            chain: 69 as ChainId,
          })
        );
      } catch (error: any) {
        const expectedError =
          "AnchorError caused by account: foreign_contract. Error Code: AccountNotInitialized.";
        if (String(error).includes(expectedError)) {
          result = true;
        }
      }

      expect(result).is.true;
    });

    it("Update Relayer Fee as Owner", async function () {
      await expectIxToSucceed(await createUpdateRelayerFeeIx());

      // Confirm state changes.
      const relayerFeeData = await tokenBridgeRelayer.getRelayerFeeData(
        connection,
        program.programId,
        foreignChain
      );

      expect(relayerFeeData.chain).equals(foreignChain);
      expect(relayerFeeData.fee.toNumber()).equals(relayerFee);
    });

    it("Update Relayer Fee as Assistant", async function () {
      const newRelayerFee = getRandomInt(
        CONTRACT_PRECISION,
        CONTRACT_PRECISION * 100000
      );

      await expectIxToSucceed(
        await createUpdateRelayerFeeIx({
          relayerFee: new BN(newRelayerFee),
          sender: assistant.publicKey,
        }),
        assistant
      );

      // Confirm state changes.
      const relayerFeeData = await tokenBridgeRelayer.getRelayerFeeData(
        connection,
        program.programId,
        foreignChain
      );

      expect(relayerFeeData.chain).equals(foreignChain);
      expect(relayerFeeData.fee.toNumber()).equals(newRelayerFee);
    });
  });

  // describe("Register Wrapped SOL", async function () {
  //   // Token registration instruction.
  //   const createRegisterTokenIx = (opts?: {
  //     sender?: PublicKey;
  //     contractAddress?: Buffer;
  //     swapRate?: BN;
  //     maxNativeSwapAmount?: BN;
  //     swapsEnabled?: boolean;
  //   }) =>
  //     tokenBridgeRelayer.createRegisterTokenInstruction(
  //       connection,
  //       TOKEN_BRIDGE_RELAYER_PID,
  //       opts?.sender ?? payer.publicKey,
  //       NATIVE_MINT,
  //       opts?.swapRate ?? new BN(10000000000),
  //       opts?.maxNativeSwapAmount ?? new BN(1000000000),
  //       opts?.swapsEnabled ?? true
  //     );

  //   it("Register Wrapped Sol as Owner", async function () {
  //     await expectIxToSucceed(createRegisterTokenIx());
  //   });
  // });

  // describe("Wrap and Transfer Experimental", async function () {
  //   const createWrapAndTransferIx =
  //     tokenBridgeRelayer.createWrapAndTransferWithRelayInstruction(
  //       connection,
  //       program.programId,
  //       payer.publicKey,
  //       new BN(1000000000)
  //     );

  //   it("Do It", async function () {
  //     await expectIxToSucceed(createWrapAndTransferIx);
  //     const balance = await getAccount(
  //       connection,
  //       tokenBridgeRelayer.deriveTokenAccountKey(program.programId, NATIVE_MINT)
  //     );

  //     console.log(balance.amount);
  //   });
  // });

  fetchTestTokens().forEach(([isNative, decimals, _1, mint, _2]) => {
    describe(`For ${
      isNative ? "Native" : "Wrapped"
    } With ${decimals} Decimals`, function () {
      // Create random swapRate and maxNativeTokenAmount.
      const swapRate = getRandomInt(
        CONTRACT_PRECISION,
        CONTRACT_PRECISION * 100000
      );
      const maxNative = getRandomInt(0, CONTRACT_PRECISION * 100000);

      // Token registration instruction.
      const createRegisterTokenIx = (opts?: {
        sender?: PublicKey;
        contractAddress?: Buffer;
        swapRate?: BN;
        maxNativeSwapAmount?: BN;
        swapsEnabled?: boolean;
      }) =>
        tokenBridgeRelayer.createRegisterTokenInstruction(
          connection,
          TOKEN_BRIDGE_RELAYER_PID,
          opts?.sender ?? payer.publicKey,
          mint,
          opts?.swapRate ?? new BN(swapRate),
          opts?.maxNativeSwapAmount ?? new BN(maxNative),
          opts?.swapsEnabled ?? true
        );

      // Token deregistration instruction.
      const createDeregisterTokenIx = (opts?: {sender?: PublicKey}) =>
        tokenBridgeRelayer.createDeregisterTokenInstruction(
          connection,
          TOKEN_BRIDGE_RELAYER_PID,
          opts?.sender ?? payer.publicKey,
          mint
        );

      // Token Swap Rate instruction.
      const createUpdateSwapRateIx = (opts?: {
        sender?: PublicKey;
        swapRate?: BN;
      }) =>
        tokenBridgeRelayer.createUpdateSwapRateInstruction(
          connection,
          TOKEN_BRIDGE_RELAYER_PID,
          opts?.sender ?? payer.publicKey,
          mint,
          opts?.swapRate ?? new BN(swapRate)
        );

      // Token max native swap amount instruction.
      const createUpdateMaxNativeSwapAmountIx = (opts?: {
        sender?: PublicKey;
        maxNativeSwapAmount?: BN;
      }) =>
        tokenBridgeRelayer.createUpdateMaxNativeSwapAmountInstruction(
          connection,
          TOKEN_BRIDGE_RELAYER_PID,
          opts?.sender ?? payer.publicKey,
          mint,
          opts?.maxNativeSwapAmount ?? new BN(maxNative)
        );

      // Token swap toggle instruction.
      const createUpdateSwapsEnabledIx = (opts?: {
        sender?: PublicKey;
        swapsEnabled?: boolean;
      }) =>
        tokenBridgeRelayer.createUpdateSwapsEnabledInstruction(
          connection,
          TOKEN_BRIDGE_RELAYER_PID,
          opts?.sender ?? payer.publicKey,
          mint,
          opts?.swapsEnabled ?? false
        );

      describe("Register Token", async function () {
        it("Cannot Register Token Swap Rate == 0", async function () {
          await expectIxToFailWithError(
            await createRegisterTokenIx({swapRate: new BN(0)}),
            "ZeroSwapRate"
          );
        });

        it("Cannot Register Token as Non-Owner", async function () {
          await expectIxToFailWithError(
            await createRegisterTokenIx({sender: assistant.publicKey}),
            "OwnerOnly",
            assistant
          );
        });

        it("Register Token as Owner", async function () {
          await expectIxToSucceed(createRegisterTokenIx());

          // Validate the account changes.
          const registeredTokenData =
            await tokenBridgeRelayer.getRegisteredTokenData(
              connection,
              program.programId,
              mint
            );

          expect(registeredTokenData.swapRate.toNumber()).equals(swapRate);
          expect(registeredTokenData.maxNativeSwapAmount.toNumber()).equals(
            maxNative
          );
          expect(registeredTokenData.swapsEnabled).equals(true);
          expect(registeredTokenData.isRegistered).equals(true);
        });

        it("Cannot Register Token Again", async function () {
          await expectIxToFailWithError(
            createRegisterTokenIx(),
            "TokenAlreadyRegistered",
            payer
          );
        });
      });

      describe("Deregister Token", async function () {
        it("Cannot Deregister Token as Non-Owner", async function () {
          await expectIxToFailWithError(
            await createDeregisterTokenIx({sender: assistant.publicKey}),
            "OwnerOnly",
            assistant
          );
        });

        it("Deregister Token as Owner", async function () {
          await expectIxToSucceed(createDeregisterTokenIx());

          // Validate the account changes.
          const registeredTokenData =
            await tokenBridgeRelayer.getRegisteredTokenData(
              connection,
              program.programId,
              mint
            );

          expect(registeredTokenData.swapRate.toNumber()).equals(0);
          expect(registeredTokenData.maxNativeSwapAmount.toNumber()).equals(0);
          expect(registeredTokenData.swapsEnabled).equals(false);
          expect(registeredTokenData.isRegistered).equals(false);
        });

        it("Cannot Deregister Unregistered Token", async function () {
          await expectIxToFailWithError(
            await createDeregisterTokenIx(),
            "TokenAlreadyRegistered",
            payer
          );
        });

        it("Register Token Again", async function () {
          await expectIxToSucceed(createRegisterTokenIx());

          // Validate the account changes.
          const registeredTokenData =
            await tokenBridgeRelayer.getRegisteredTokenData(
              connection,
              program.programId,
              mint
            );

          expect(registeredTokenData.swapRate.toNumber()).equals(swapRate);
          expect(registeredTokenData.maxNativeSwapAmount.toNumber()).equals(
            maxNative
          );
          expect(registeredTokenData.swapsEnabled).equals(true);
          expect(registeredTokenData.isRegistered).equals(true);
        });
      });

      describe("Update Swap Rate", async function () {
        it("Cannot Update Swap Rate as Non-Owner", async function () {
          await expectIxToFailWithError(
            await createUpdateSwapRateIx({sender: relayer.publicKey}),
            "OwnerOnly",
            relayer
          );
        });

        it("Cannot Update Swap Rate For Unregistered Token", async function () {
          // Deregister the token.
          await expectIxToSucceed(createDeregisterTokenIx());

          // Confirm the swap rate update fails.
          await expectIxToFailWithError(
            await createUpdateSwapRateIx(),
            "TokenNotRegistered",
            payer
          );

          // Register the token again.
          await expectIxToSucceed(createRegisterTokenIx());
        });

        it("Cannot Update Swap Rate == 0", async function () {
          await expectIxToFailWithError(
            await createUpdateSwapRateIx({swapRate: new BN(0)}),
            "ZeroSwapRate",
            payer
          );
        });

        it("Update Swap Rate as Assistant", async function () {
          const newSwapRate = getRandomInt(
            CONTRACT_PRECISION,
            CONTRACT_PRECISION * 100000
          );

          await expectIxToSucceed(
            await createUpdateSwapRateIx({
              swapRate: new BN(newSwapRate),
              sender: assistant.publicKey,
            }),
            assistant
          );

          // Validate the account changes.
          const registeredTokenData =
            await tokenBridgeRelayer.getRegisteredTokenData(
              connection,
              program.programId,
              mint
            );

          expect(registeredTokenData.swapRate.toNumber()).equals(newSwapRate);
        });

        it("Update Swap Rate as Owner", async function () {
          const newSwapRate = getRandomInt(
            CONTRACT_PRECISION,
            CONTRACT_PRECISION * 100000
          );

          await expectIxToSucceed(
            await createUpdateSwapRateIx({
              swapRate: new BN(newSwapRate),
            })
          );

          // Validate the account changes.
          const registeredTokenData =
            await tokenBridgeRelayer.getRegisteredTokenData(
              connection,
              program.programId,
              mint
            );

          expect(registeredTokenData.swapRate.toNumber()).equals(newSwapRate);
        });
      });

      describe("Update Max Native Swap Amount", async function () {
        it("Cannot Update Max Native Swap Amount as Non-Owner", async function () {
          await expectIxToFailWithError(
            await createUpdateMaxNativeSwapAmountIx({
              sender: relayer.publicKey,
            }),
            "OwnerOnly",
            relayer
          );
        });

        it("Cannot Update Max Native Swap Amount For Unregistered Token", async function () {
          // Deregister the token.
          await expectIxToSucceed(createDeregisterTokenIx());

          // Confirm the max native amount update fails.
          await expectIxToFailWithError(
            await createUpdateMaxNativeSwapAmountIx(),
            "TokenNotRegistered",
            payer
          );

          // Register the token again.
          await expectIxToSucceed(createRegisterTokenIx());
        });

        it("Update Swap Rate as Owner", async function () {
          const newMaxNative = getRandomInt(0, CONTRACT_PRECISION * 100000);

          await expectIxToSucceed(
            await createUpdateMaxNativeSwapAmountIx({
              maxNativeSwapAmount: new BN(newMaxNative),
            })
          );

          // Validate the account changes.
          const registeredTokenData =
            await tokenBridgeRelayer.getRegisteredTokenData(
              connection,
              program.programId,
              mint
            );

          expect(registeredTokenData.maxNativeSwapAmount.toNumber()).equals(
            newMaxNative
          );
        });
      });

      describe("Update Swaps Enabled", async function () {
        it("Cannot Update Swaps Enabled as Non-Owner", async function () {
          await expectIxToFailWithError(
            await createUpdateSwapsEnabledIx({
              sender: relayer.publicKey,
            }),
            "OwnerOnly",
            relayer
          );
        });

        it("Cannot Update Swaps Enabled For Unregistered Token", async function () {
          // Deregister the token.
          await expectIxToSucceed(createDeregisterTokenIx());

          // Confirm the swap toggle update fails.
          await expectIxToFailWithError(
            await createUpdateSwapsEnabledIx(),
            "TokenNotRegistered",
            payer
          );

          // Register the token again.
          await expectIxToSucceed(createRegisterTokenIx());
        });

        it("Update Swaps Enabled as Owner", async function () {
          // Confirm that swaps are enabled. This is set to true in the register
          // token instruction ealier in the test.
          {
            const registeredTokenData =
              await tokenBridgeRelayer.getRegisteredTokenData(
                connection,
                program.programId,
                mint
              );

            expect(registeredTokenData.swapsEnabled).is.true;
          }

          // Set the swap toggle to false.
          await expectIxToSucceed(
            await createUpdateSwapsEnabledIx({
              swapsEnabled: false,
            })
          );

          // Verify that the swap toggle is set to false.
          {
            const registeredTokenData =
              await tokenBridgeRelayer.getRegisteredTokenData(
                connection,
                program.programId,
                mint
              );

            expect(registeredTokenData.swapsEnabled).is.false;
          }

          // Set the swap toggle to true again.
          // Set the swap toggle to false.
          await expectIxToSucceed(
            await createUpdateSwapsEnabledIx({
              swapsEnabled: true,
            })
          );

          // Verify that the swap toggle is set to true.
          {
            const registeredTokenData =
              await tokenBridgeRelayer.getRegisteredTokenData(
                connection,
                program.programId,
                mint
              );

            expect(registeredTokenData.swapsEnabled).is.true;
          }
        });
      });
    });
  });

  describe("Transfer Tokens With Relay Business Logic", function () {
    const batchId = 0;
    const sendAmount = 6900000000000; // we are sending once
    const toNativeTokenAmount = 1000000000;
    const recipientAddress = Buffer.alloc(32, "1337beef", "hex");
    const initialRelayerFee = 100000000; // $1.00

    const getWormholeSequence = async () =>
      (
        await wormhole.getProgramSequenceTracker(
          connection,
          TOKEN_BRIDGE_PID,
          CORE_BRIDGE_PID
        )
      ).value() + 1n;

    const verifyTmpTokenAccountDoesNotExist = async (mint: PublicKey) => {
      const tmpTokenAccountKey = tokenBridgeRelayer.deriveTmpTokenAccountKey(
        TOKEN_BRIDGE_RELAYER_PID,
        mint
      );
      await expect(getAccount(connection, tmpTokenAccountKey)).to.be.rejected;
    };

    const getTokenBalance = async (tokenAccount: PublicKey) =>
      Number((await getAccount(connection, tokenAccount)).amount);

    fetchTestTokens().forEach(
      ([isNative, decimals, tokenAddress, mint, swapRate]) => {
        describe(`For ${
          isNative ? "Native" : "Wrapped"
        } With ${decimals} Decimals`, function () {
          const recipientTokenAccount = getAssociatedTokenAddressSync(
            mint,
            payer.publicKey
          );

          describe(`Send Tokens With Payload`, function () {
            const createSendTokensWithPayloadIx = (opts?: {
              sender?: PublicKey;
              amount?: number;
              toNativeAmount: number;
              recipientAddress?: Buffer;
              recipientChain?: ChainId;
            }) =>
              (isNative
                ? tokenBridgeRelayer.createSendNativeTokensWithPayloadInstruction
                : tokenBridgeRelayer.createSendWrappedTokensWithPayloadInstruction)(
                connection,
                TOKEN_BRIDGE_RELAYER_PID,
                opts?.sender ?? payer.publicKey,
                TOKEN_BRIDGE_PID,
                CORE_BRIDGE_PID,
                mint,
                {
                  amount: opts?.amount ?? sendAmount,
                  toNativeTokenAmount:
                    opts?.toNativeAmount ?? toNativeTokenAmount,
                  recipientAddress: opts?.recipientAddress ?? recipientAddress,
                  recipientChain: opts?.recipientChain ?? foreignChain,
                  batchId: batchId,
                }
              );

            it("Set the Swap Rate", async function () {
              // Set the swap rate.
              const createUpdateSwapRateIx =
                await tokenBridgeRelayer.createUpdateSwapRateInstruction(
                  connection,
                  TOKEN_BRIDGE_RELAYER_PID,
                  payer.publicKey,
                  mint,
                  new BN(swapRate)
                );
              await expectIxToSucceed(createUpdateSwapRateIx);
            });

            it("Set the Initial Relayer Fee", async function () {
              // Set the initial relayer fee.
              const createUpdateRelayerFeeIx =
                await tokenBridgeRelayer.createUpdateRelayerFeeInstruction(
                  connection,
                  TOKEN_BRIDGE_RELAYER_PID,
                  payer.publicKey,
                  foreignChain,
                  new BN(initialRelayerFee)
                );
              await expectIxToSucceed(createUpdateRelayerFeeIx);
            });

            //       if (isNative && decimals > 8)
            //         it("Cannot Send Amount Less Than Bridgeable", async function() {
            //           await expectIxToFailWithError(
            //             await createSendTokensWithPayloadIx({amount: 9n}),
            //             "ZeroBridgeAmount"
            //           );
            //         });

            //       it("Cannot Send To Unregistered Foreign Contract", async function() {
            //         await expectIxToFailWithError(
            //           await createSendTokensWithPayloadIx({recipientChain: invalidChain}),
            //           "AccountNotInitialized"
            //         );
            //       });

            //       [CHAINS.unset, CHAINS.solana].forEach((recipientChain) =>
            //         it(`Cannot Send To Chain ID == ${recipientChain}`, async function() {
            //           await expectIxToFailWithError(
            //             await createSendTokensWithPayloadIx({recipientChain}),
            //             "AnchorError caused by account: foreign_contract. Error Code: AccountNotInitialized"
            //           );
            //         })
            //       );

            //       it("Cannot Send To Zero Address", async function() {
            //         await expectIxToFailWithError(
            //           await createSendTokensWithPayloadIx({recipientAddress: Buffer.alloc(32)}),
            //           "InvalidRecipient"
            //         );
            //       });

            it("Finally Send Tokens With Payload", async function () {
              const sequence = await getWormholeSequence();

              // Fetch the token balance before the transfer.
              const balanceBefore = await getTokenBalance(
                recipientTokenAccount
              );

              // Attempt to send the transfer. Depending on pda derivations, we can
              // exceed our 200k compute units budget.
              await expectIxToSucceed(
                createSendTokensWithPayloadIx(),
                250_000 // compute units
              );

              // Calculate the balance change and confirm it matches the expected.
              const balanceChange =
                balanceBefore - (await getTokenBalance(recipientTokenAccount));
              expect(balanceChange).equals(
                tokenBridgeTransform(Number(sendAmount), decimals)
              );

              // Normalize the to native token amount.
              const expectedToNativeAmount = tokenBridgeNormalizeAmount(
                toNativeTokenAmount,
                decimals
              );

              // Calculate the expected target relayer fee and normalize it.
              const expectedFee = tokenBridgeNormalizeAmount(
                await calculateRelayerFee(
                  connection,
                  program.programId,
                  foreignChain,
                  decimals,
                  mint
                ),
                decimals
              );

              // Parse the token bridge relayer payload and validate the encoded
              // values.
              await verifyRelayerMessage(
                connection,
                sequence,
                expectedFee,
                expectedToNativeAmount,
                recipientAddress
              );
              await verifyTmpTokenAccountDoesNotExist(mint);
            });
          });
        });
      }
    );
  });
});
