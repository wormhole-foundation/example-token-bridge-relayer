import {expect, use as chaiUse} from "chai";
import chaiAsPromised from "chai-as-promised";
chaiUse(chaiAsPromised);
import {Connection, PublicKey} from "@solana/web3.js";
import {getAccount, getAssociatedTokenAddressSync} from "@solana/spl-token";
import {
  CHAINS,
  ChainId,
  parseTokenTransferPayload,
  parseTokenTransferVaa,
  tryNativeToHexString,
} from "@certusone/wormhole-sdk";
import * as mock from "@certusone/wormhole-sdk/lib/cjs/mock";
import {getTokenBridgeDerivedAccounts} from "@certusone/wormhole-sdk/lib/cjs/solana";
import * as wormhole from "@certusone/wormhole-sdk/lib/cjs/solana/wormhole";
import {deriveWrappedMintKey} from "@certusone/wormhole-sdk/lib/cjs/solana/tokenBridge";
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
} from "./helpers";

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

  console.log(program.programId);

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

      const redeemerConfigData = await tokenBridgeRelayer.getRedeemerConfigData(
        connection,
        TOKEN_BRIDGE_RELAYER_PID
      );
      expect(redeemerConfigData.relayerFeePrecision).equals(
        relayerFeePrecision
      );

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

      const redeemerConfigData = await tokenBridgeRelayer.getRedeemerConfigData(
        connection,
        TOKEN_BRIDGE_RELAYER_PID
      );
      expect(redeemerConfigData.swapRatePrecision).equals(swapRatePrecision);

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

  fetchTestTokens().forEach(([isNative, decimals, _, mint]) => {
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

  // const batchId = 0;
  // const sendAmount = 31337n; //we are sending once
  // const recipientAddress = Buffer.alloc(32, "1337beef", "hex");

  // const getWormholeSequence = async () => (
  //     await wormhole.getProgramSequenceTracker(connection, TOKEN_BRIDGE_PID, CORE_BRIDGE_PID)
  //   ).value() + 1n;

  // const verifyWormholeMessage = async (sequence: bigint) => {
  //   const payload =
  //     parseTokenTransferPayload(
  //       (await wormhole.getPostedMessage(
  //         connection,
  //         tokenBridgeRelayer.deriveTokenTransferMessageKey(TOKEN_BRIDGE_RELAYER_PID, sequence)
  //       )).message.payload
  //     ).tokenTransferPayload;

  //   expect(payload.readUint8(0)).equals(1); // payload ID
  //   expect(recipientAddress).deep.equals(payload.subarray(1, 33));
  // }

  // const verifyTmpTokenAccountDoesNotExist = async (mint: PublicKey) => {
  //   const tmpTokenAccountKey = tokenBridgeRelayer.deriveTmpTokenAccountKey(TOKEN_BRIDGE_RELAYER_PID, mint);
  //   await expect(getAccount(connection, tmpTokenAccountKey)).to.be.rejected;
  // }

  // const getTokenBalance = async (tokenAccount: PublicKey) =>
  //   (await getAccount(connection, tokenAccount)).amount;

  // ([
  //   [
  //     false,
  //     18,
  //     tryNativeToHexString(WETH_ADDRESS, foreignChain),
  //     deriveWrappedMintKey(TOKEN_BRIDGE_PID, foreignChain, WETH_ADDRESS)
  //   ],
  //   ...(Array.from(MINTS_WITH_DECIMALS.entries())
  //     .map(([decimals, {publicKey}]): [boolean, number, string, PublicKey] =>
  //       [
  //         true,
  //         decimals,
  //         publicKey.toBuffer().toString("hex"),
  //         publicKey
  //     ])
  //   )
  // ] as [boolean, number, string, PublicKey][])
  // .forEach(([isNative, decimals, tokenAddress, mint]) => {
  //   describe(`For ${isNative ? "Native" : "Wrapped"} With ${decimals} Decimals`, function() {
  //     const recipientTokenAccount = getAssociatedTokenAddressSync(mint, payer.publicKey);
  //     // We treat amount as if it was specified with a precision of 8 decimals
  //     const truncation = (isNative ? 10n ** BigInt(decimals - 8) : 1n);
  //     //we send once, but we receive twice, hence /2, and w also have to adjust for truncation
  //     const receiveAmount = ((sendAmount / 2n) / truncation) * truncation;

  //     describe(`Send Tokens With Payload`, function() {
  //       const createSendTokensWithPayloadIx = (opts?: {
  //         sender?: PublicKey,
  //         amount?: bigint,
  //         recipientAddress?: Buffer,
  //         recipientChain?: ChainId,
  //       }) =>
  //         ( isNative
  //         ? tokenBridgeRelayer.createSendNativeTokensWithPayloadInstruction
  //         : tokenBridgeRelayer.createSendWrappedTokensWithPayloadInstruction
  //         )(
  //         connection,
  //         TOKEN_BRIDGE_RELAYER_PID,
  //         opts?.sender ?? payer.publicKey,
  //         TOKEN_BRIDGE_PID,
  //         CORE_BRIDGE_PID,
  //         mint,
  //         {
  //           batchId,
  //           amount: opts?.amount ?? sendAmount,
  //           recipientAddress: opts?.recipientAddress ?? recipientAddress,
  //           recipientChain: opts?.recipientChain ?? foreignChain,
  //         }
  //       );

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

  //       it("Finally Send Tokens With Payload", async function() {
  //         const sequence = await getWormholeSequence();

  //         const balanceBefore = await getTokenBalance(recipientTokenAccount);
  //         //depending on pda derivations, we can exceed our 200k compute units budget
  //         const computeUnits = 250_000;
  //         await expectIxToSucceed(createSendTokensWithPayloadIx(), computeUnits);
  //         const balanceChange = balanceBefore - await getTokenBalance(recipientTokenAccount);
  //         expect(balanceChange).equals((sendAmount / truncation) * truncation);

  //         await verifyWormholeMessage(sequence);
  //         await verifyTmpTokenAccountDoesNotExist(mint);
  //       });
  //     });

  //     const publishAndSign = (opts?: {foreignContractAddress?: Buffer}) => {
  //       const tokenTransferPayload = (() => {
  //         const buf = Buffer.alloc(33);
  //         buf.writeUInt8(1, 0); // payload ID
  //         payer.publicKey.toBuffer().copy(buf, 1); // payer is always recipient
  //         return buf;
  //       })();

  //       const published = foreignTokenBridge.publishTransferTokensWithPayload(
  //         tokenAddress,
  //         isNative ? CHAINS.solana : foreignChain, // tokenChain
  //         receiveAmount / truncation, //adjust for decimals
  //         CHAINS.solana, // recipientChain
  //         TOKEN_BRIDGE_RELAYER_PID.toBuffer().toString("hex"),
  //         opts?.foreignContractAddress ?? foreignContractAddress,
  //         tokenTransferPayload,
  //         batchId
  //       );
  //       published[51] = 3;

  //       return guardianSign(published);
  //     };

  //     const createRedeemTransferWithPayloadIx = (sender: PublicKey, signedMsg: Buffer) =>
  //       ( isNative
  //       ? tokenBridgeRelayer.createRedeemNativeTransferWithPayloadInstruction
  //       : tokenBridgeRelayer.createRedeemWrappedTransferWithPayloadInstruction
  //       )(
  //         connection,
  //         TOKEN_BRIDGE_RELAYER_PID,
  //         sender,
  //         TOKEN_BRIDGE_PID,
  //         CORE_BRIDGE_PID,
  //         signedMsg
  //       );

  //     [
  //       payer,
  //       relayer
  //     ]
  //     .forEach(sender => {
  //       const isSelfRelay = sender === payer;

  //       describe(
  //       `Receive Tokens With Payload (via ${isSelfRelay ? "self-relay" : "relayer"})`,
  //       function() {
  //         //got call it here so the nonce increases (signedMsg is different between tests)
  //         const signedMsg = publishAndSign();

  //         it("Cannot Redeem From Unregistered Foreign Contract", async function() {
  //           const bogusMsg = publishAndSign(
  //             {foreignContractAddress: unregisteredContractAddress}
  //           );
  //           await postSignedMsgAsVaaOnSolana(bogusMsg);
  //           await expectIxToFailWithError(
  //             await createRedeemTransferWithPayloadIx(sender.publicKey, bogusMsg),
  //             "InvalidForeignContract",
  //             sender
  //           );
  //         });

  //         it("Post Wormhole Message", async function() {
  //           await expect(postSignedMsgAsVaaOnSolana(signedMsg, sender)).to.be.fulfilled;
  //         })

  //         it("Cannot Redeem With Bogus Token Account", async function() {
  //           const bogusTokenAccount = getAssociatedTokenAddressSync(mint, relayer.publicKey);

  //           const maliciousIx = await (async () => {
  //             const parsed = parseTokenTransferVaa(signedMsg);
  //             const parsedMint = isNative
  //               ? new PublicKey(parsed.tokenAddress)
  //               : deriveWrappedMintKey(TOKEN_BRIDGE_PID,  parsed.tokenChain, parsed.tokenAddress);

  //             const tmpTokenAccount =
  //               tokenBridgeRelayer.deriveTmpTokenAccountKey(TOKEN_BRIDGE_RELAYER_PID, parsedMint);
  //             const tokenBridgeAccounts = (isNative
  //               ? tokenBridgeRelayer.getCompleteTransferNativeWithPayloadCpiAccounts
  //               : tokenBridgeRelayer.getCompleteTransferWrappedWithPayloadCpiAccounts)(
  //                 TOKEN_BRIDGE_PID,
  //                 CORE_BRIDGE_PID,
  //                 relayer.publicKey,
  //                 parsed,
  //                 tmpTokenAccount
  //               );

  //             const method = isNative
  //               ? program.methods.redeemNativeTransferWithPayload
  //               : program.methods.redeemWrappedTransferWithPayload;

  //             return method([...parsed.hash])
  //               .accounts({
  //                 config: tokenBridgeRelayer.deriveRedeemerConfigKey(TOKEN_BRIDGE_RELAYER_PID),
  //                 foreignContract:
  //                   tokenBridgeRelayer.deriveForeignContractKey(TOKEN_BRIDGE_RELAYER_PID, parsed.emitterChain),
  //                 tmpTokenAccount,
  //                 recipientTokenAccount: bogusTokenAccount,
  //                 recipient: relayer.publicKey,
  //                 payerTokenAccount: getAssociatedTokenAddressSync(parsedMint, relayer.publicKey),
  //                 tokenBridgeProgram: TOKEN_BRIDGE_PID,
  //                 ...tokenBridgeAccounts,
  //               })
  //               .instruction();
  //           })();

  //           await expectIxToFailWithError(
  //             maliciousIx,
  //             "Error Code: InvalidRecipient. Error Number: 6015",
  //             relayer
  //           );
  //         });

  //         it("Finally Receive Tokens With Payload", async function() {
  //           const tokenAccounts = ((isSelfRelay) ? [payer] : [payer, relayer]).map(
  //             kp => getAssociatedTokenAddressSync(mint, kp.publicKey)
  //           );

  //           const balancesBefore = await Promise.all(tokenAccounts.map(getTokenBalance));
  //           await expectIxToSucceed(
  //             createRedeemTransferWithPayloadIx(sender.publicKey, signedMsg),
  //             sender
  //           );
  //           const balancesChange = await Promise.all(
  //             tokenAccounts.map(async (acc, i) => (await getTokenBalance(acc)) - balancesBefore[i])
  //           );

  //           if (isSelfRelay) {
  //             expect(balancesChange[0]).equals(receiveAmount);
  //           }
  //           else {
  //             const { relayerFee, relayerFeePrecision } =
  //               await tokenBridgeRelayer.getRedeemerConfigData(connection, TOKEN_BRIDGE_RELAYER_PID);
  //             const relayerAmount =
  //               (BigInt(relayerFee) * receiveAmount) / BigInt(relayerFeePrecision);
  //             expect(balancesChange[0]).equals(receiveAmount - relayerAmount);
  //             expect(balancesChange[1]).equals(relayerAmount);
  //           }

  //           await verifyTmpTokenAccountDoesNotExist(mint);
  //         });

  //         it("Cannot Redeem Transfer Again", async function() {
  //           await expectIxToFailWithError(
  //             await createRedeemTransferWithPayloadIx(sender.publicKey, signedMsg),
  //             "AlreadyRedeemed",
  //             sender
  //           );
  //         });
  //       });
  //   });
  // });
});
