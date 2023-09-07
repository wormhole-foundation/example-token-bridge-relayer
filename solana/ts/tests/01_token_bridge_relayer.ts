import { expect, use as chaiUse } from "chai";
import chaiAsPromised from "chai-as-promised";
chaiUse(chaiAsPromised);
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { CHAINS, ChainId, tryNativeToHexString } from "@certusone/wormhole-sdk";
import * as mock from "@certusone/wormhole-sdk/lib/cjs/mock";
import { getTokenBridgeDerivedAccounts } from "@certusone/wormhole-sdk/lib/cjs/solana";
import * as wormhole from "@certusone/wormhole-sdk/lib/cjs/solana/wormhole";
import * as tokenBridgeRelayer from "../sdk/";
import { BN } from "@coral-xyz/anchor";
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
  boilerPlateReduction,
  fetchTestTokens,
  getRandomInt,
  verifyRelayerMessage,
  tokenBridgeTransform,
  tokenBridgeNormalizeAmount,
  calculateRelayerFee,
  getDescription,
  getBalance,
  createTransferWithRelayPayload,
  calculateSwapAmounts,
  getSwapInputs,
  TOKEN_BRIDGE_RELAYER_PID,
} from "./helpers";

// The default pecision value used in the token bridge relayer program.
const CONTRACT_PRECISION = 100000000;
const INITIAL_RELAYER_FEE = new BN(0);
const ETHEREUM_TOKEN_BRIDGE_ADDRESS =
  "0x" + tryNativeToHexString(WORMHOLE_CONTRACTS.ethereum.token_bridge, "ethereum");

describe(" 1: Token Bridge Relayer", function () {
  const connection = new Connection(LOCALHOST, "confirmed");
  // payer is also the recipient in all tests
  const payer = PAYER_KEYPAIR;
  const relayer = RELAYER_KEYPAIR;
  const feeRecipient = FEE_RECIPIENT_KEYPAIR;
  const assistant = ASSISTANT_KEYPAIR;

  const { guardianSign, postSignedMsgAsVaaOnSolana, expectIxToSucceed, expectIxToFailWithError } =
    boilerPlateReduction(connection, payer);

  const foreignChain = CHAINS.ethereum;
  const invalidChain = (foreignChain + 1) as ChainId;
  const foreignContractAddress = Buffer.alloc(32, "deadbeef", "hex");
  const unregisteredContractAddress = Buffer.alloc(32, "deafbeef", "hex");
  const foreignTokenBridge = new mock.MockEthereumTokenBridge(ETHEREUM_TOKEN_BRIDGE_ADDRESS, 200);
  const program = tokenBridgeRelayer.createTokenBridgeRelayerProgramInterface(
    connection,
    TOKEN_BRIDGE_RELAYER_PID
  );

  describe("Initialize Program", function () {
    // Expected relayer fee and swap rate precisions.
    const newRelayerFeePrecision = 100_000_000;
    const newSwapRatePrecision = 100_000_000;

    const createInitializeIx = (opts?: { feeRecipient?: PublicKey; assistant?: PublicKey }) =>
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
        await createInitializeIx({ feeRecipient: PublicKey.default }),
        "InvalidPublicKey"
      );
    });

    it("Cannot Initialize With Default Assistant", async function () {
      await expectIxToFailWithError(
        await createInitializeIx({ assistant: PublicKey.default }),
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
      expect(senderConfigData.paused).equals(false);

      const tokenBridgeAccounts = getTokenBridgeDerivedAccounts(
        TOKEN_BRIDGE_RELAYER_PID,
        TOKEN_BRIDGE_PID,
        CORE_BRIDGE_PID
      );

      (
        [["sequence", "tokenBridgeSequence"]] as [
          keyof typeof senderConfigData.tokenBridge,
          keyof typeof tokenBridgeAccounts
        ][]
      ).forEach(([lhs, rhs]) =>
        expect(senderConfigData.tokenBridge[lhs]).deep.equals(tokenBridgeAccounts[rhs])
      );

      const redeemerConfigData = await tokenBridgeRelayer.getRedeemerConfigData(
        connection,
        TOKEN_BRIDGE_RELAYER_PID
      );
      expect(redeemerConfigData.owner).deep.equals(payer.publicKey);
      expect(redeemerConfigData.relayerFeePrecision.toString()).equals(
        newRelayerFeePrecision.toString()
      );
      expect(redeemerConfigData.feeRecipient.toString()).equals(feeRecipient.publicKey.toString());
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
    const createSubmitOwnershipTransferIx = (opts?: { sender?: PublicKey; newOwner?: PublicKey }) =>
      tokenBridgeRelayer.createSubmitOwnershipTransferInstruction(
        connection,
        TOKEN_BRIDGE_RELAYER_PID,
        opts?.sender ?? payer.publicKey,
        opts?.newOwner ?? relayer.publicKey
      );

    // Create the confirm ownership transfer instruction, which will be used
    // to set the new owner to the `relayer` key.
    const createConfirmOwnershipTransferIx = (opts?: { sender?: PublicKey }) =>
      tokenBridgeRelayer.createConfirmOwnershipTransferInstruction(
        connection,
        TOKEN_BRIDGE_RELAYER_PID,
        opts?.sender ?? relayer.publicKey
      );

    // Instruction to cancel an ownership transfer request.
    const createCancelOwnershipTransferIx = (opts?: { sender?: PublicKey }) =>
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

      await expectIxToSucceed(createConfirmOwnershipTransferIx({ sender: payer.publicKey }), payer);

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
        await createCancelOwnershipTransferIx({ sender: relayer.publicKey }),
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

  describe("Update Owner Assistant", async function () {
    // Create the update owner assistant instruction.
    const createUpdateOwnerAssistantIx = (opts?: {
      sender?: PublicKey;
      newAssistant?: PublicKey;
    }) =>
      tokenBridgeRelayer.createUpdateAssistantInstruction(
        connection,
        TOKEN_BRIDGE_RELAYER_PID,
        opts?.sender ?? payer.publicKey,
        opts?.newAssistant ?? relayer.publicKey // set it to the relayer key
      );

    it("Cannot Update Assistant (New Assistant == Address(0))", async function () {
      await expectIxToFailWithError(
        await createUpdateOwnerAssistantIx({ newAssistant: PublicKey.default }),
        "InvalidPublicKey"
      );
    });
    it("Cannot Update Assistant (New Assistant == Assistant)", async function () {
      await expectIxToFailWithError(
        await createUpdateOwnerAssistantIx({ newAssistant: assistant.publicKey }),
        "AlreadyTheAssistant",
        payer
      );
    });
    it("Cannot Update Assistant as Non-Owner", async function () {
      await expectIxToFailWithError(
        await createUpdateOwnerAssistantIx({ sender: relayer.publicKey }),
        "OwnerOnly",
        relayer
      );
    });
    it("Update Assistant as Owner", async function () {
      await expectIxToSucceed(createUpdateOwnerAssistantIx());

      // Confirm the assistant field was updated.
      const ownerConfigData = await tokenBridgeRelayer.getOwnerConfigData(
        connection,
        TOKEN_BRIDGE_RELAYER_PID
      );
      expect(ownerConfigData.assistant).deep.equals(relayer.publicKey);

      // Set the assistant back to the assistant key.
      await expectIxToSucceed(
        createUpdateOwnerAssistantIx({
          newAssistant: assistant.publicKey,
        }),
        payer
      );
    });
  });

  describe("Update Fee Recipient", async function () {
    // Create the update fee recipient instruction.
    const createUpdateFeeRecipientIx = (opts?: {
      sender?: PublicKey;
      newFeeRecipient?: PublicKey;
    }) =>
      tokenBridgeRelayer.createUpdateFeeRecipientInstruction(
        connection,
        TOKEN_BRIDGE_RELAYER_PID,
        opts?.sender ?? payer.publicKey,
        opts?.newFeeRecipient ?? assistant.publicKey // set it to the assistant key
      );

    it("Cannot Update Fee Recipient (New Fee Recipient == Address(0))", async function () {
      await expectIxToFailWithError(
        await createUpdateFeeRecipientIx({
          newFeeRecipient: PublicKey.default,
        }),
        "InvalidPublicKey"
      );
    });
    it("Cannot Update Fee Recipient (New Fee Recipient == Fee Recipient)", async function () {
      await expectIxToFailWithError(
        await createUpdateFeeRecipientIx({
          newFeeRecipient: feeRecipient.publicKey,
        }),
        "AlreadyTheFeeRecipient",
        payer
      );
    });
    it("Cannot Update Fee Recipient as Non-Owner", async function () {
      await expectIxToFailWithError(
        await createUpdateFeeRecipientIx({ sender: relayer.publicKey }),
        "OwnerOnly",
        relayer
      );
    });
    it("Update Fee Recipient as Owner", async function () {
      await expectIxToSucceed(createUpdateFeeRecipientIx());

      // Confirm the fee recipient field was updated.
      const redeemerConfigData = await tokenBridgeRelayer.getRedeemerConfigData(
        connection,
        TOKEN_BRIDGE_RELAYER_PID
      );
      expect(redeemerConfigData.feeRecipient).deep.equals(assistant.publicKey);

      // Set the fee recipient back to the fee recipient key.
      await expectIxToSucceed(
        createUpdateFeeRecipientIx({
          newFeeRecipient: feeRecipient.publicKey,
        }),
        payer
      );
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
        await createUpdateRelayerFeePrecisionIx({ relayerFeePrecision: 0 }),
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
      expect(redeemerConfigData.relayerFeePrecision).equals(relayerFeePrecision);

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
        ETHEREUM_TOKEN_BRIDGE_ADDRESS,
        INITIAL_RELAYER_FEE
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
            .registerForeignContract(chain, [...foreignContractAddress], INITIAL_RELAYER_FEE)
            .accounts({
              owner: payer.publicKey,
              config: tokenBridgeRelayer.deriveSenderConfigKey(TOKEN_BRIDGE_RELAYER_PID),
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

    [Buffer.alloc(32, "fbadc0de", "hex"), foreignContractAddress].forEach((contractAddress) =>
      it(`Register ${
        contractAddress === foreignContractAddress ? "Final" : "Random"
      } Address`, async function () {
        await expectIxToSucceed(createRegisterForeignContractIx({ contractAddress }));

        const { chain, address, fee } = await tokenBridgeRelayer.getForeignContractData(
          connection,
          TOKEN_BRIDGE_RELAYER_PID,
          foreignChain
        );
        expect(chain).equals(foreignChain);
        expect(address).deep.equals(contractAddress);
        expect(fee.toNumber()).equals(INITIAL_RELAYER_FEE.toNumber());
      })
    );
  });

  describe("Update Relayer Fee", async function () {
    const relayerFee = getRandomInt(CONTRACT_PRECISION, CONTRACT_PRECISION * 100000);

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
        await createUpdateRelayerFeeIx({ sender: relayer.publicKey }),
        "OwnerOrAssistantOnly",
        relayer
      );
    });

    it("Cannot Update Relayer Fee for Unregistered Chain", async function () {
      await expectIxToFailWithError(
        await createUpdateRelayerFeeIx({
          relayerFee: new BN(69),
          chain: 69 as ChainId,
        }),
        "AnchorError caused by account: foreign_contract. Error Code: AccountNotInitialized."
      );
    });

    it("Update Relayer Fee as Owner", async function () {
      await expectIxToSucceed(await createUpdateRelayerFeeIx());

      // Confirm state changes.
      const relayerFeeData = await tokenBridgeRelayer.getForeignContractData(
        connection,
        program.programId,
        foreignChain
      );

      expect(relayerFeeData.chain).equals(foreignChain);
      expect(relayerFeeData.fee.toNumber()).equals(relayerFee);
    });

    it("Update Relayer Fee as Assistant", async function () {
      const newRelayerFee = getRandomInt(CONTRACT_PRECISION, CONTRACT_PRECISION * 100000);

      await expectIxToSucceed(
        await createUpdateRelayerFeeIx({
          relayerFee: new BN(newRelayerFee),
          sender: assistant.publicKey,
        }),
        assistant
      );

      // Confirm state changes.
      const relayerFeeData = await tokenBridgeRelayer.getForeignContractData(
        connection,
        program.programId,
        foreignChain
      );

      expect(relayerFeeData.chain).equals(foreignChain);
      expect(relayerFeeData.fee.toNumber()).equals(newRelayerFee);
    });
  });

  describe("Set Pause for Transfer", async function () {
    const createSetPauseForTransfersIx = (opts?: { sender?: PublicKey; paused?: boolean }) =>
      tokenBridgeRelayer.createSetPauseForTransfersInstruction(
        connection,
        TOKEN_BRIDGE_RELAYER_PID,
        opts?.sender ?? payer.publicKey,
        opts?.paused ?? true
      );

    it("Cannot Set Pause for Transfers as Non-Owner", async function () {
      await expectIxToFailWithError(
        await createSetPauseForTransfersIx({ sender: relayer.publicKey }),
        "OwnerOnly",
        relayer
      );
    });

    it("Set Pause for Transfers to True as Owner", async function () {
      await expectIxToSucceed(await createSetPauseForTransfersIx());

      const senderConfigData = await tokenBridgeRelayer.getSenderConfigData(
        connection,
        TOKEN_BRIDGE_RELAYER_PID
      );
      expect(senderConfigData.paused).equals(true);
    });

    it("Set Pause for Transfers to False as Owner", async function () {
      await expectIxToSucceed(await createSetPauseForTransfersIx({ paused: false }));

      const senderConfigData = await tokenBridgeRelayer.getSenderConfigData(
        connection,
        TOKEN_BRIDGE_RELAYER_PID
      );
      expect(senderConfigData.paused).equals(false);
    });
  });

  fetchTestTokens().forEach(([isNative, decimals, _1, mint, _2]) => {
    describe(getDescription(decimals, isNative, mint), function () {
      // Create random swapRate and maxNativeTokenAmount.
      const swapRate = getRandomInt(CONTRACT_PRECISION, CONTRACT_PRECISION * 100000);
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
          opts?.maxNativeSwapAmount ?? mint === NATIVE_MINT ? new BN(0) : new BN(maxNative)
        );

      // Token deregistration instruction.
      const createDeregisterTokenIx = (opts?: { sender?: PublicKey }) =>
        tokenBridgeRelayer.createDeregisterTokenInstruction(
          connection,
          TOKEN_BRIDGE_RELAYER_PID,
          opts?.sender ?? payer.publicKey,
          mint
        );

      // Token Swap Rate instruction.
      const createUpdateSwapRateIx = (opts?: { sender?: PublicKey; swapRate?: BN }) =>
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

      describe("Register Token", async function () {
        it("Cannot Register Token Swap Rate == 0", async function () {
          await expectIxToFailWithError(
            await createRegisterTokenIx({ swapRate: new BN(0) }),
            "ZeroSwapRate"
          );
        });

        it("Cannot Register Token as Non-Owner", async function () {
          await expectIxToFailWithError(
            await createRegisterTokenIx({ sender: assistant.publicKey }),
            "OwnerOnly",
            assistant
          );
        });

        if (mint === NATIVE_MINT)
          it("Cannot Register Native Mint with Nonzero Max Native Token Amount", async function () {
            await expectIxToFailWithError(
              tokenBridgeRelayer.createRegisterTokenInstruction(
                connection,
                TOKEN_BRIDGE_RELAYER_PID,
                payer.publicKey,
                mint,
                new BN(swapRate),
                new BN(1)
              ),
              "SwapsNotAllowedForNativeMint"
            );
          });

        it("Register Token as Owner", async function () {
          await expectIxToSucceed(createRegisterTokenIx());

          // Validate the account changes.
          const registeredTokenData = await tokenBridgeRelayer.getRegisteredTokenData(
            connection,
            program.programId,
            mint
          );

          expect(registeredTokenData.swapRate.toNumber()).equals(swapRate);
          expect(registeredTokenData.maxNativeSwapAmount.toNumber()).equals(
            mint === NATIVE_MINT ? 0 : maxNative
          );
        });

        it("Cannot Register Token Again", async function () {
          await expectIxToFailWithError(createRegisterTokenIx(), "already in use", payer);
        });
      });

      describe("Deregister Token", async function () {
        it("Cannot Deregister Token as Non-Owner", async function () {
          await expectIxToFailWithError(
            await createDeregisterTokenIx({ sender: assistant.publicKey }),
            "OwnerOnly",
            assistant
          );
        });

        it("Deregister Token as Owner", async function () {
          await expectIxToSucceed(createDeregisterTokenIx());

          // Validate that the account no longer exists.
          let failed = false;
          try {
            await tokenBridgeRelayer.getRegisteredTokenData(connection, program.programId, mint);
          } catch (e: any) {
            expect(e.message.includes("Account does not exist")).is.true;
            failed = true;
          }
          expect(failed).is.true;
        });

        it("Cannot Deregister Unregistered Token", async function () {
          await expectIxToFailWithError(
            await createDeregisterTokenIx(),
            "AccountNotInitialized",
            payer
          );
        });

        it("Register Token Again", async function () {
          await expectIxToSucceed(createRegisterTokenIx());

          // Validate the account changes.
          const registeredTokenData = await tokenBridgeRelayer.getRegisteredTokenData(
            connection,
            program.programId,
            mint
          );

          expect(registeredTokenData.swapRate.toNumber()).equals(swapRate);
          expect(registeredTokenData.maxNativeSwapAmount.toNumber()).equals(
            mint === NATIVE_MINT ? 0 : maxNative
          );
        });
      });

      describe("Update Swap Rate", async function () {
        it("Cannot Update Swap Rate as Non-Owner", async function () {
          await expectIxToFailWithError(
            await createUpdateSwapRateIx({ sender: relayer.publicKey }),
            "OwnerOrAssistantOnly",
            relayer
          );
        });

        it("Cannot Update Swap Rate For Unregistered Token", async function () {
          // Deregister the token.
          await expectIxToSucceed(createDeregisterTokenIx());

          // Confirm the swap rate update fails.
          await expectIxToFailWithError(
            await createUpdateSwapRateIx(),
            "AccountNotInitialized",
            payer
          );

          // Register the token again.
          await expectIxToSucceed(createRegisterTokenIx());
        });

        it("Cannot Update Swap Rate == 0", async function () {
          await expectIxToFailWithError(
            await createUpdateSwapRateIx({ swapRate: new BN(0) }),
            "ZeroSwapRate",
            payer
          );
        });

        it("Update Swap Rate as Assistant", async function () {
          const newSwapRate = getRandomInt(CONTRACT_PRECISION, CONTRACT_PRECISION * 100000);

          await expectIxToSucceed(
            await createUpdateSwapRateIx({
              swapRate: new BN(newSwapRate),
              sender: assistant.publicKey,
            }),
            assistant
          );

          // Validate the account changes.
          const registeredTokenData = await tokenBridgeRelayer.getRegisteredTokenData(
            connection,
            program.programId,
            mint
          );

          expect(registeredTokenData.swapRate.toNumber()).equals(newSwapRate);
        });

        it("Update Swap Rate as Owner", async function () {
          const newSwapRate = getRandomInt(CONTRACT_PRECISION, CONTRACT_PRECISION * 100000);

          await expectIxToSucceed(
            await createUpdateSwapRateIx({
              swapRate: new BN(newSwapRate),
            })
          );

          // Validate the account changes.
          const registeredTokenData = await tokenBridgeRelayer.getRegisteredTokenData(
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
            "AccountNotInitialized",
            payer
          );

          // Register the token again.
          await expectIxToSucceed(createRegisterTokenIx());
        });

        it("Update Max Native Swap Amount as Owner", async function () {
          const newMaxNative =
            mint === NATIVE_MINT ? 0 : getRandomInt(0, CONTRACT_PRECISION * 100000);

          await expectIxToSucceed(
            await createUpdateMaxNativeSwapAmountIx({
              maxNativeSwapAmount: new BN(newMaxNative),
            })
          );

          // Validate the account changes.
          const registeredTokenData = await tokenBridgeRelayer.getRegisteredTokenData(
            connection,
            program.programId,
            mint
          );

          expect(registeredTokenData.maxNativeSwapAmount.toNumber()).equals(newMaxNative);
        });

        if (mint === NATIVE_MINT)
          it("Cannot Update Max Native Swap Amount to Nonzero value For Native Mint", async function () {
            await expectIxToFailWithError(
              await createUpdateMaxNativeSwapAmountIx({
                maxNativeSwapAmount: new BN(1),
              }),
              "SwapsNotAllowedForNativeMint"
            );
          });
      });
    });
  });

  describe("Transfer Tokens With Relay Business Logic", function () {
    // Test parameters. The following tests rely on these parameters,
    // and changing them may cause the tests to fail.
    const batchId = 0;
    const sendAmount = 420000000000; // we are sending once
    const recipientAddress = Buffer.alloc(32, "1337beef", "hex");
    const initialRelayerFee = 100000000; // $1.00
    const maxNativeSwapAmount = 50000000000; // 50 SOL

    const getWormholeSequence = async () =>
      (
        await wormhole.getProgramSequenceTracker(connection, TOKEN_BRIDGE_PID, CORE_BRIDGE_PID)
      ).value();

    const verifyTmpTokenAccountDoesNotExist = async (mint: PublicKey) => {
      const tmpTokenAccountKey = tokenBridgeRelayer.deriveTmpTokenAccountKey(
        TOKEN_BRIDGE_RELAYER_PID,
        mint
      );
      await expect(getAccount(connection, tmpTokenAccountKey)).to.be.rejected;
    };

    fetchTestTokens().forEach(([isNative, decimals, tokenAddress, mint, swapRate]) => {
      describe(getDescription(decimals, isNative, mint), function () {
        // Target contract swap amount.
        const toNativeTokenAmount = 10000000000;

        // ATAs.
        const recipientTokenAccount = getAssociatedTokenAddressSync(mint, payer.publicKey);
        const feeRecipientTokenAccount = getAssociatedTokenAddressSync(
          mint,
          feeRecipient.publicKey
        );
        const relayerTokenAccount = getAssociatedTokenAddressSync(mint, relayer.publicKey);

        describe(`Send Tokens With Payload`, function () {
          const createSendTokensWithPayloadIx = (opts?: {
            sender?: PublicKey;
            amount?: number;
            toNativeTokenAmount?: number;
            recipientAddress?: Buffer;
            recipientChain?: ChainId;
            wrapNative?: boolean;
          }) =>
            (isNative
              ? tokenBridgeRelayer.createTransferNativeTokensWithRelayInstruction
              : tokenBridgeRelayer.createTransferWrappedTokensWithRelayInstruction)(
              connection,
              TOKEN_BRIDGE_RELAYER_PID,
              opts?.sender ?? payer.publicKey,
              TOKEN_BRIDGE_PID,
              CORE_BRIDGE_PID,
              mint,
              {
                amount: opts?.amount ?? sendAmount,
                toNativeTokenAmount: opts?.toNativeTokenAmount ?? toNativeTokenAmount,
                recipientAddress: opts?.recipientAddress ?? recipientAddress,
                recipientChain: opts?.recipientChain ?? foreignChain,
                batchId: batchId,
                wrapNative: opts?.wrapNative ?? mint === NATIVE_MINT ? true : false,
              }
            );

          it("Set the Swap Rate", async function () {
            // Set the swap rate.
            const createUpdateSwapRateIx = await tokenBridgeRelayer.createUpdateSwapRateInstruction(
              connection,
              TOKEN_BRIDGE_RELAYER_PID,
              payer.publicKey,
              mint,
              new BN(swapRate)
            );
            await expectIxToSucceed(createUpdateSwapRateIx);
          });

          it("Set the Max Native Swap Amount", async function () {
            // Set the max native swap amount.
            const createUpdateMaxNativeSwapAmountIx =
              await tokenBridgeRelayer.createUpdateMaxNativeSwapAmountInstruction(
                connection,
                TOKEN_BRIDGE_RELAYER_PID,
                payer.publicKey,
                mint,
                mint === NATIVE_MINT ? new BN(0) : new BN(maxNativeSwapAmount)
              );
            await expectIxToSucceed(createUpdateMaxNativeSwapAmountIx);
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

          it("Cannot Send When Paused", async function () {
            // Pause transfers.
            const createSetPauseForTransfersIx =
              await tokenBridgeRelayer.createSetPauseForTransfersInstruction(
                connection,
                TOKEN_BRIDGE_RELAYER_PID,
                payer.publicKey,
                true
              );
            await expectIxToSucceed(createSetPauseForTransfersIx);

            // Attempt to do the transfer.
            await expectIxToFailWithError(
              await createSendTokensWithPayloadIx(),
              "OutboundTransfersPaused"
            );

            // Unpause transfers.
            const createSetPauseForTransfersIx2 =
              await tokenBridgeRelayer.createSetPauseForTransfersInstruction(
                connection,
                TOKEN_BRIDGE_RELAYER_PID,
                payer.publicKey,
                false
              );
            await expectIxToSucceed(createSetPauseForTransfersIx2);
          });

          it("Cannot Send Unregistered Token", async function () {
            // Deregister the token.
            await expectIxToSucceed(
              await tokenBridgeRelayer.createDeregisterTokenInstruction(
                connection,
                TOKEN_BRIDGE_RELAYER_PID,
                payer.publicKey,
                mint
              )
            );

            // Attempt to do the transfer.
            await expectIxToFailWithError(
              await createSendTokensWithPayloadIx(),
              "AccountNotInitialized"
            );

            // Register the token again.
            await expectIxToSucceed(
              await tokenBridgeRelayer.createRegisterTokenInstruction(
                connection,
                TOKEN_BRIDGE_RELAYER_PID,
                payer.publicKey,
                mint,
                new BN(swapRate),
                new BN(0) // set the max native to zero, this won't affect subsequent tests
              )
            );
          });

          if (isNative && decimals > 8)
            it("Cannot Send Amount Less Than Bridgeable", async function () {
              await expectIxToFailWithError(
                await createSendTokensWithPayloadIx({ amount: 1 }),
                "ZeroBridgeAmount"
              );
            });

          if (isNative && decimals > 8)
            it("Cannot Set To Native Token Amount Less Than Bridgeable", async function () {
              await expectIxToFailWithError(
                await createSendTokensWithPayloadIx({
                  toNativeTokenAmount: 1,
                }),
                "InvalidToNativeAmount"
              );
            });

          it("Cannot Send Amount Less Than Sum of Relayer Fee and To Native Token Amount", async function () {
            // Calculate the relayer fee in terms of the token.
            const relayerFee = tokenBridgeTransform(
              await calculateRelayerFee(
                connection,
                program.programId,
                foreignChain,
                decimals,
                mint
              ),
              decimals
            );

            // Calculate the transfer amount.
            const insufficientAmount = relayerFee + toNativeTokenAmount - 1;

            await expectIxToFailWithError(
              await createSendTokensWithPayloadIx({
                amount: insufficientAmount,
              }),
              "InsufficientFunds"
            );
          });

          it("Cannot Send To Unregistered Foreign Contract", async function () {
            await expectIxToFailWithError(
              await createSendTokensWithPayloadIx({
                recipientChain: invalidChain,
              }),
              "AccountNotInitialized"
            );
          });

          [CHAINS.unset, CHAINS.solana].forEach((recipientChain) =>
            it(`Cannot Send To Chain ID == ${recipientChain}`, async function () {
              await expectIxToFailWithError(
                await createSendTokensWithPayloadIx({ recipientChain }),
                "AnchorError caused by account: foreign_contract. Error Code: AccountNotInitialized"
              );
            })
          );

          it("Cannot Send To Zero Address", async function () {
            await expectIxToFailWithError(
              await createSendTokensWithPayloadIx({
                recipientAddress: Buffer.alloc(32),
              }),
              "InvalidRecipient"
            );
          });

          if (mint !== NATIVE_MINT && isNative)
            it("Cannot Wrap Non-Native Token", async function () {
              await expectIxToFailWithError(
                await createSendTokensWithPayloadIx({
                  wrapNative: true,
                }),
                "NativeMintRequired"
              );
            });

          for (const toNativeAmount of [toNativeTokenAmount, 0]) {
            it(`Transfer with Relay (To Native Amount == ${toNativeAmount})`, async function () {
              const sequence = await tokenBridgeRelayer.getSignerSequenceData(
                connection,
                TOKEN_BRIDGE_RELAYER_PID,
                payer.publicKey
              );

              // Fetch the balance before the transfer.
              const balanceBefore = await getBalance(
                connection,
                payer.publicKey,
                mint === NATIVE_MINT,
                recipientTokenAccount
              );

              // Attempt to send the transfer.
              await expectIxToSucceed(
                createSendTokensWithPayloadIx({
                  toNativeTokenAmount: toNativeAmount,
                }),
                250_000
              );

              // Fetch the balance after the transfer.
              const balanceAfter = await getBalance(
                connection,
                payer.publicKey,
                mint === NATIVE_MINT,
                recipientTokenAccount
              );

              // Calculate the balance change and confirm it matches the expected. If
              // wrap is true, then the balance should decrease by the amount sent
              // plus the amount of lamports used to pay for the transaction.
              if (mint === NATIVE_MINT) {
                expect(balanceBefore - balanceAfter).gte(
                  tokenBridgeTransform(Number(sendAmount), decimals)
                );
              } else {
                expect(balanceBefore - balanceAfter).equals(
                  tokenBridgeTransform(Number(sendAmount), decimals)
                );
              }

              // Normalize the to native token amount.
              const expectedToNativeAmount = tokenBridgeNormalizeAmount(toNativeAmount, decimals);

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

              // Normalize the transfer amount and verify that it's correct.
              const expectedAmount = tokenBridgeNormalizeAmount(sendAmount, decimals);

              // Parse the token bridge relayer payload and validate the encoded
              // values.
              await verifyRelayerMessage(
                connection,
                payer.publicKey,
                BigInt(sequence.toString()),
                expectedAmount,
                expectedFee,
                expectedToNativeAmount,
                recipientAddress
              );

              await verifyTmpTokenAccountDoesNotExist(mint);
            });
          }
        });

        describe("Complete Transfer with Relay", function () {
          // Test parameters. The following tests rely on these values
          // and could fail if they are changed.
          const feeEpsilon = 10000000;
          const receiveAmount = sendAmount / 6;
          const toNativeTokenAmount = 10000000000;
          expect(toNativeTokenAmount).lt(receiveAmount);

          // Replay protection place holder.
          let replayVAA: Buffer;

          const createRedeemTransferWithPayloadIx = (
            sender: PublicKey,
            signedMsg: Buffer,
            recipient: PublicKey
          ) =>
            (isNative
              ? tokenBridgeRelayer.createCompleteNativeTransferWithRelayInstruction
              : tokenBridgeRelayer.createCompleteWrappedTransferWithRelayInstruction)(
              connection,
              TOKEN_BRIDGE_RELAYER_PID,
              sender,
              feeRecipient.publicKey,
              TOKEN_BRIDGE_PID,
              CORE_BRIDGE_PID,
              signedMsg,
              recipient
            );

          it("Cannot Redeem From Unregistered Foreign Contract", async function () {
            // Create the encoded transfer with relay payload.
            const transferWithRelayPayload = createTransferWithRelayPayload(
              0, // relayer fee
              0, // to native token amount
              payer.publicKey.toBuffer().toString("hex")
            );

            // Create the token bridge message.
            const bogusMsg = guardianSign(
              foreignTokenBridge.publishTransferTokensWithPayload(
                tokenAddress,
                isNative ? CHAINS.solana : foreignChain, // tokenChain
                BigInt(tokenBridgeNormalizeAmount(receiveAmount, decimals)),
                CHAINS.solana, // recipientChain
                TOKEN_BRIDGE_RELAYER_PID.toBuffer().toString("hex"),
                unregisteredContractAddress,
                Buffer.from(transferWithRelayPayload.substring(2), "hex"),
                batchId
              )
            );

            // Post the Wormhole message.
            await postSignedMsgAsVaaOnSolana(bogusMsg);

            // Attempt to redeem the transfer.
            await expectIxToFailWithError(
              await createRedeemTransferWithPayloadIx(payer.publicKey, bogusMsg, payer.publicKey),
              "InvalidForeignContract"
            );
          });

          it("Cannot Redeem Unregistered Token", async function () {
            // Define inbound transfer parameters. Calculate the fee
            // using the foreignChain to simulate calculating the
            // target relayer fee. This contract won't allow us to set
            // a relayer fee for the Solana chain ID.
            const relayerFee = await calculateRelayerFee(
              connection,
              program.programId,
              foreignChain, // placeholder
              decimals,
              mint
            );

            // Deregister the token.
            await expectIxToSucceed(
              await tokenBridgeRelayer.createDeregisterTokenInstruction(
                connection,
                TOKEN_BRIDGE_RELAYER_PID,
                payer.publicKey,
                mint
              )
            );

            // Create the encoded transfer with relay payload.
            const transferWithRelayPayload = createTransferWithRelayPayload(
              tokenBridgeNormalizeAmount(relayerFee, decimals),
              tokenBridgeNormalizeAmount(toNativeTokenAmount, decimals),
              payer.publicKey.toBuffer().toString("hex")
            );

            // Create the token bridge message.
            const signedMsg = guardianSign(
              foreignTokenBridge.publishTransferTokensWithPayload(
                tokenAddress,
                isNative ? CHAINS.solana : foreignChain, // tokenChain
                BigInt(tokenBridgeNormalizeAmount(receiveAmount, decimals)),
                CHAINS.solana, // recipientChain
                TOKEN_BRIDGE_RELAYER_PID.toBuffer().toString("hex"),
                foreignContractAddress,
                Buffer.from(transferWithRelayPayload.substring(2), "hex"),
                batchId
              )
            );

            // Post the Wormhole message.
            await expect(postSignedMsgAsVaaOnSolana(signedMsg, payer)).to.be.fulfilled;

            // Attempt to redeem the transfer.
            await expectIxToFailWithError(
              await createRedeemTransferWithPayloadIx(payer.publicKey, signedMsg, payer.publicKey),
              "AccountNotInitialized"
            );

            // Register the token again.
            await expectIxToSucceed(
              await tokenBridgeRelayer.createRegisterTokenInstruction(
                connection,
                TOKEN_BRIDGE_RELAYER_PID,
                payer.publicKey,
                mint,
                new BN(swapRate),
                mint === NATIVE_MINT ? new BN(0) : new BN(maxNativeSwapAmount)
              )
            );
          });

          it("Cannot Redeem Invalid Recipient", async function () {
            // Define inbound transfer parameters. Calculate the fee
            // using the foreignChain to simulate calculating the
            // target relayer fee. This contract won't allow us to set
            // a relayer fee for the Solana chain ID.
            const relayerFee = await calculateRelayerFee(
              connection,
              program.programId,
              foreignChain, // placeholder
              decimals,
              mint
            );

            // Encode a different recipient in the payload.
            const transferWithRelayPayload = createTransferWithRelayPayload(
              tokenBridgeNormalizeAmount(relayerFee, decimals),
              tokenBridgeNormalizeAmount(toNativeTokenAmount, decimals),
              relayer.publicKey.toBuffer().toString("hex") // encode the relayer instead of recipient
            );

            // Create the token bridge message.
            const signedMsg = guardianSign(
              foreignTokenBridge.publishTransferTokensWithPayload(
                tokenAddress,
                isNative ? CHAINS.solana : foreignChain, // tokenChain
                BigInt(tokenBridgeNormalizeAmount(receiveAmount, decimals)),
                CHAINS.solana, // recipientChain
                TOKEN_BRIDGE_RELAYER_PID.toBuffer().toString("hex"),
                foreignContractAddress,
                Buffer.from(transferWithRelayPayload.substring(2), "hex"),
                batchId
              )
            );

            // Post the Wormhole message.
            await expect(postSignedMsgAsVaaOnSolana(signedMsg, payer)).to.be.fulfilled;

            // Attempt to redeem the transfer with a different recipient.
            await expectIxToFailWithError(
              await createRedeemTransferWithPayloadIx(payer.publicKey, signedMsg, payer.publicKey),
              "InvalidRecipient"
            );
          });

          it("Self Redeem", async function () {
            // Define inbound transfer parameters. Calculate the fee
            // using the foreignChain to simulate calculating the
            // target relayer fee. This contract won't allow us to set
            // a relayer fee for the Solana chain ID.
            const relayerFee = await calculateRelayerFee(
              connection,
              program.programId,
              foreignChain, // placeholder
              decimals,
              mint
            );

            // Create the encoded transfer with relay payload.
            const transferWithRelayPayload = createTransferWithRelayPayload(
              tokenBridgeNormalizeAmount(relayerFee, decimals),
              tokenBridgeNormalizeAmount(toNativeTokenAmount, decimals),
              payer.publicKey.toBuffer().toString("hex")
            );

            // Create the token bridge message.
            const signedMsg = guardianSign(
              foreignTokenBridge.publishTransferTokensWithPayload(
                tokenAddress,
                isNative ? CHAINS.solana : foreignChain, // tokenChain
                BigInt(tokenBridgeNormalizeAmount(receiveAmount, decimals)),
                CHAINS.solana, // recipientChain
                TOKEN_BRIDGE_RELAYER_PID.toBuffer().toString("hex"),
                foreignContractAddress,
                Buffer.from(transferWithRelayPayload.substring(2), "hex"),
                batchId
              )
            );

            // Post the Wormhole message.
            await expect(postSignedMsgAsVaaOnSolana(signedMsg, payer)).to.be.fulfilled;

            // Fetch the balance before the transfer.
            const balanceBefore = await getBalance(
              connection,
              payer.publicKey,
              mint === NATIVE_MINT,
              recipientTokenAccount
            );

            // Complete the transfer.
            await expectIxToSucceed(
              createRedeemTransferWithPayloadIx(payer.publicKey, signedMsg, payer.publicKey),
              payer
            );

            // Fetch the balance after the transfer.
            const balanceAfter = await getBalance(
              connection,
              payer.publicKey,
              mint === NATIVE_MINT,
              recipientTokenAccount
            );

            // Calculate the balance change and confirm it matches the expected. If
            // wrap is true, then the balance should decrease by the amount sent
            // plus the amount of lamports used to pay for the transaction.
            if (mint === NATIVE_MINT) {
              expect(balanceAfter - balanceBefore - receiveAmount).lte(
                tokenBridgeTransform(feeEpsilon, decimals)
              );
            } else {
              expect(balanceAfter - balanceBefore).equals(
                tokenBridgeTransform(Number(receiveAmount), decimals)
              );
            }

            await verifyTmpTokenAccountDoesNotExist(mint);
          });

          it("With Relayer (With Swap)", async function () {
            // Define inbound transfer parameters. Calculate the fee
            // using the foreignChain to simulate calculating the
            // target relayer fee. This contract won't allow us to set
            // a relayer fee for the Solana chain ID.
            const relayerFee = await calculateRelayerFee(
              connection,
              program.programId,
              foreignChain, // placeholder
              decimals,
              mint
            );

            // Create the encoded transfer with relay payload.
            const transferWithRelayPayload = createTransferWithRelayPayload(
              tokenBridgeNormalizeAmount(relayerFee, decimals),
              tokenBridgeNormalizeAmount(toNativeTokenAmount, decimals),
              payer.publicKey.toBuffer().toString("hex")
            );

            // Create the token bridge message.
            const signedMsg = guardianSign(
              foreignTokenBridge.publishTransferTokensWithPayload(
                tokenAddress,
                isNative ? CHAINS.solana : foreignChain, // tokenChain
                BigInt(tokenBridgeNormalizeAmount(receiveAmount, decimals)),
                CHAINS.solana, // recipientChain
                TOKEN_BRIDGE_RELAYER_PID.toBuffer().toString("hex"),
                foreignContractAddress,
                Buffer.from(transferWithRelayPayload.substring(2), "hex"),
                batchId
              )
            );

            // Post the Wormhole message.
            await expect(postSignedMsgAsVaaOnSolana(signedMsg, relayer)).to.be.fulfilled;

            // Fetch the token balances before the transfer.
            const recipientTokenBalanceBefore = await getBalance(
              connection,
              payer.publicKey,
              mint === NATIVE_MINT,
              recipientTokenAccount
            );
            const feeRecipientTokenBalanceBefore = await getBalance(
              connection,
              feeRecipient.publicKey,
              mint === NATIVE_MINT,
              feeRecipientTokenAccount
            );

            // Fetch the lamport balances before the transfer.
            const recipientLamportBalanceBefore = await getBalance(
              connection,
              payer.publicKey,
              true,
              recipientTokenAccount
            );
            const relayerLamportBalanceBefore = await getBalance(
              connection,
              relayer.publicKey,
              true,
              relayerTokenAccount
            );

            // Complete the transfer.
            await expectIxToSucceed(
              createRedeemTransferWithPayloadIx(relayer.publicKey, signedMsg, payer.publicKey),
              relayer,
              250_000
            );

            // Fetch the token balances after the transfer.
            const recipientTokenBalanceAfter = await getBalance(
              connection,
              payer.publicKey,
              mint === NATIVE_MINT,
              recipientTokenAccount
            );
            const feeRecipientTokenBalanceAfter = await getBalance(
              connection,
              feeRecipient.publicKey,
              mint === NATIVE_MINT,
              feeRecipientTokenAccount
            );

            // Fetch the lamport balances after the transfer.
            const recipientLamportBalanceAfter = await getBalance(
              connection,
              payer.publicKey,
              true,
              recipientTokenAccount
            );
            const relayerLamportBalanceAfter = await getBalance(
              connection,
              relayer.publicKey,
              true,
              relayerTokenAccount
            );

            // Denormalize the transfer amount and relayer fee.
            const denormalizedReceiveAmount = tokenBridgeTransform(receiveAmount, decimals);
            const denormalizedRelayerFee = tokenBridgeTransform(relayerFee, decimals);

            // Confirm the balance changes.
            if (mint === NATIVE_MINT) {
              // Confirm lamport changes for the recipient.
              expect(recipientLamportBalanceAfter - recipientLamportBalanceBefore).equals(
                tokenBridgeTransform(Number(receiveAmount) - denormalizedRelayerFee, decimals)
              );

              // Confirm lamport changes for the relayer.
              expect(relayerLamportBalanceAfter - relayerLamportBalanceBefore).gte(
                denormalizedRelayerFee - feeEpsilon
              );
            } else {
              // Calculate the expected token swap amounts.
              const [expectedSwapAmountIn, expectedSwapAmountOut] = await calculateSwapAmounts(
                connection,
                program.programId,
                decimals,
                mint,
                toNativeTokenAmount
              );

              // Confirm token changes for the recipient.
              expect(recipientTokenBalanceAfter - recipientTokenBalanceBefore).equals(
                denormalizedReceiveAmount - expectedSwapAmountIn - denormalizedRelayerFee
              );

              // Confirm token changes for fee recipient.
              expect(feeRecipientTokenBalanceAfter - feeRecipientTokenBalanceBefore).equals(
                expectedSwapAmountIn + denormalizedRelayerFee
              );

              // Confirm lamports changes for the recipient.
              expect(recipientLamportBalanceAfter - recipientLamportBalanceBefore).equals(
                expectedSwapAmountOut
              );

              // Confirm lamports changes for the relayer.
              expect(relayerLamportBalanceBefore - relayerLamportBalanceAfter)
                .gte(expectedSwapAmountOut)
                .lte(expectedSwapAmountOut + feeEpsilon);
            }

            await verifyTmpTokenAccountDoesNotExist(mint);
          });

          it("With Relayer (With Max Swap Limit Reached)", async function () {
            // Define inbound transfer parameters. Calculate the fee
            // using the foreignChain to simulate calculating the
            // target relayer fee. This contract won't allow us to set
            // a relayer fee for the Solana chain ID.
            const relayerFee = await calculateRelayerFee(
              connection,
              program.programId,
              foreignChain, // placeholder
              decimals,
              mint
            );

            // Create the encoded transfer with relay payload.
            const transferWithRelayPayload = createTransferWithRelayPayload(
              tokenBridgeNormalizeAmount(relayerFee, decimals),
              tokenBridgeNormalizeAmount(toNativeTokenAmount, decimals),
              payer.publicKey.toBuffer().toString("hex")
            );

            // Create the token bridge message.
            const signedMsg = guardianSign(
              foreignTokenBridge.publishTransferTokensWithPayload(
                tokenAddress,
                isNative ? CHAINS.solana : foreignChain, // tokenChain
                BigInt(tokenBridgeNormalizeAmount(receiveAmount, decimals)),
                CHAINS.solana, // recipientChain
                TOKEN_BRIDGE_RELAYER_PID.toBuffer().toString("hex"),
                foreignContractAddress,
                Buffer.from(transferWithRelayPayload.substring(2), "hex"),
                batchId
              )
            );

            // Update the max native swap amount if the toNativeTokenAmount is
            // not enough to cap the swap quantity.
            {
              // Compute the max native swap amount in token terms.
              const [maxNativeSwapAmountInTokens, _, __] = await getSwapInputs(
                connection,
                program.programId,
                decimals,
                mint
              );

              if (toNativeTokenAmount <= maxNativeSwapAmountInTokens) {
                // Reduce the max native swap amount to half of the
                // to native token amount equivalent.
                const newMaxNativeSwapAmount =
                  maxNativeSwapAmount * (toNativeTokenAmount / maxNativeSwapAmountInTokens / 2);

                await expectIxToSucceed(
                  await tokenBridgeRelayer.createUpdateMaxNativeSwapAmountInstruction(
                    connection,
                    TOKEN_BRIDGE_RELAYER_PID,
                    payer.publicKey,
                    mint,
                    new BN(newMaxNativeSwapAmount)
                  )
                );
              }
            }

            // Post the Wormhole message.
            await expect(postSignedMsgAsVaaOnSolana(signedMsg, relayer)).to.be.fulfilled;

            // Fetch the token balances before the transfer.
            const recipientTokenBalanceBefore = await getBalance(
              connection,
              payer.publicKey,
              mint === NATIVE_MINT,
              recipientTokenAccount
            );
            const feeRecipientTokenBalanceBefore = await getBalance(
              connection,
              feeRecipient.publicKey,
              mint === NATIVE_MINT,
              feeRecipientTokenAccount
            );

            // Fetch the lamport balances before the transfer.
            const recipientLamportBalanceBefore = await getBalance(
              connection,
              payer.publicKey,
              true,
              recipientTokenAccount
            );
            const relayerLamportBalanceBefore = await getBalance(
              connection,
              relayer.publicKey,
              true,
              relayerTokenAccount
            );

            // Complete the transfer.
            await expectIxToSucceed(
              createRedeemTransferWithPayloadIx(relayer.publicKey, signedMsg, payer.publicKey),
              relayer,
              250_000
            );

            // Fetch the token balances after the transfer.
            const recipientTokenBalanceAfter = await getBalance(
              connection,
              payer.publicKey,
              mint === NATIVE_MINT,
              recipientTokenAccount
            );
            const feeRecipientTokenBalanceAfter = await getBalance(
              connection,
              feeRecipient.publicKey,
              mint === NATIVE_MINT,
              feeRecipientTokenAccount
            );

            // Fetch the lamport balances after the transfer.
            const recipientLamportBalanceAfter = await getBalance(
              connection,
              payer.publicKey,
              true,
              recipientTokenAccount
            );
            const relayerLamportBalanceAfter = await getBalance(
              connection,
              relayer.publicKey,
              true,
              relayerTokenAccount
            );

            // Denormalize the transfer amount and relayer fee.
            const denormalizedReceiveAmount = tokenBridgeTransform(receiveAmount, decimals);
            const denormalizedRelayerFee = tokenBridgeTransform(relayerFee, decimals);

            // Confirm the balance changes.
            if (mint === NATIVE_MINT) {
              // Confirm lamport changes for the recipient.
              expect(recipientLamportBalanceAfter - recipientLamportBalanceBefore).equals(
                tokenBridgeTransform(Number(receiveAmount) - denormalizedRelayerFee, decimals)
              );

              // Confirm lamport changes for the relayer.
              expect(relayerLamportBalanceAfter - relayerLamportBalanceBefore).gte(
                denormalizedRelayerFee - feeEpsilon
              );
            } else {
              // Calculate the expected token swap amounts.
              const [expectedSwapAmountIn, expectedSwapAmountOut] = await calculateSwapAmounts(
                connection,
                program.programId,
                decimals,
                mint,
                toNativeTokenAmount
              );

              // Confirm that the expectedSwapAmountIn is less than the
              // original to native token amount.
              expect(expectedSwapAmountIn).lt(toNativeTokenAmount);

              // Confirm token changes for the recipient.
              expect(recipientTokenBalanceAfter - recipientTokenBalanceBefore).equals(
                denormalizedReceiveAmount - expectedSwapAmountIn - denormalizedRelayerFee
              );

              // Confirm token changes for fee recipient.
              expect(feeRecipientTokenBalanceAfter - feeRecipientTokenBalanceBefore).equals(
                expectedSwapAmountIn + denormalizedRelayerFee
              );

              // Confirm lamports changes for the recipient.
              expect(recipientLamportBalanceAfter - recipientLamportBalanceBefore).equals(
                expectedSwapAmountOut
              );

              // Confirm lamports changes for the relayer.
              expect(relayerLamportBalanceBefore - relayerLamportBalanceAfter)
                .gte(expectedSwapAmountOut)
                .lte(expectedSwapAmountOut + feeEpsilon);
            }

            // Set the max native swap amount back to the initial value.
            await expectIxToSucceed(
              await tokenBridgeRelayer.createUpdateMaxNativeSwapAmountInstruction(
                connection,
                TOKEN_BRIDGE_RELAYER_PID,
                payer.publicKey,
                mint,
                mint === NATIVE_MINT ? new BN(0) : new BN(maxNativeSwapAmount)
              )
            );

            await verifyTmpTokenAccountDoesNotExist(mint);
          });

          it("With Relayer (With Swap No Fee)", async function () {
            // Define inbound transfer parameters. Calculate the fee
            // using the foreignChain to simulate calculating the
            // target relayer fee. This contract won't allow us to set
            // a relayer fee for the Solana chain ID.
            const relayerFee = await calculateRelayerFee(
              connection,
              program.programId,
              foreignChain, // placeholder
              decimals,
              mint
            );

            // Create the encoded transfer with relay payload. Set the
            // target relayer fee to zero for this test.
            const transferWithRelayPayload = createTransferWithRelayPayload(
              tokenBridgeNormalizeAmount(0, decimals),
              tokenBridgeNormalizeAmount(toNativeTokenAmount, decimals),
              payer.publicKey.toBuffer().toString("hex")
            );

            // Create the token bridge message.
            const signedMsg = guardianSign(
              foreignTokenBridge.publishTransferTokensWithPayload(
                tokenAddress,
                isNative ? CHAINS.solana : foreignChain, // tokenChain
                BigInt(tokenBridgeNormalizeAmount(receiveAmount, decimals)),
                CHAINS.solana, // recipientChain
                TOKEN_BRIDGE_RELAYER_PID.toBuffer().toString("hex"),
                foreignContractAddress,
                Buffer.from(transferWithRelayPayload.substring(2), "hex"),
                batchId
              )
            );

            // Post the Wormhole message.
            await expect(postSignedMsgAsVaaOnSolana(signedMsg, relayer)).to.be.fulfilled;

            // Fetch the token balances before the transfer.
            const recipientTokenBalanceBefore = await getBalance(
              connection,
              payer.publicKey,
              mint === NATIVE_MINT,
              recipientTokenAccount
            );
            const feeRecipientTokenBalanceBefore = await getBalance(
              connection,
              feeRecipient.publicKey,
              mint === NATIVE_MINT,
              feeRecipientTokenAccount
            );

            // Fetch the lamport balances before the transfer.
            const recipientLamportBalanceBefore = await getBalance(
              connection,
              payer.publicKey,
              true,
              recipientTokenAccount
            );
            const relayerLamportBalanceBefore = await getBalance(
              connection,
              relayer.publicKey,
              true,
              relayerTokenAccount
            );

            // Complete the transfer.
            await expectIxToSucceed(
              createRedeemTransferWithPayloadIx(relayer.publicKey, signedMsg, payer.publicKey),
              relayer,
              250_000
            );

            // Fetch the token balances after the transfer.
            const recipientTokenBalanceAfter = await getBalance(
              connection,
              payer.publicKey,
              mint === NATIVE_MINT,
              recipientTokenAccount
            );
            const feeRecipientTokenBalanceAfter = await getBalance(
              connection,
              feeRecipient.publicKey,
              mint === NATIVE_MINT,
              feeRecipientTokenAccount
            );

            // Fetch the lamport balances after the transfer.
            const recipientLamportBalanceAfter = await getBalance(
              connection,
              payer.publicKey,
              true,
              recipientTokenAccount
            );
            const relayerLamportBalanceAfter = await getBalance(
              connection,
              relayer.publicKey,
              true,
              relayerTokenAccount
            );

            // Denormalize the transfer amount and relayer fee.
            const denormalizedReceiveAmount = tokenBridgeTransform(receiveAmount, decimals);
            const denormalizedRelayerFee = tokenBridgeTransform(relayerFee, decimals);

            // Confirm the balance changes.
            if (mint === NATIVE_MINT) {
              // Confirm lamport changes for the recipient.
              expect(recipientLamportBalanceAfter - recipientLamportBalanceBefore).equals(
                tokenBridgeTransform(Number(receiveAmount), decimals)
              );

              // Confirm lamport changes for the relayer.
              expect(relayerLamportBalanceBefore - relayerLamportBalanceAfter).lte(feeEpsilon);
            } else {
              // Calculate the expected token swap amounts.
              const [expectedSwapAmountIn, expectedSwapAmountOut] = await calculateSwapAmounts(
                connection,
                program.programId,
                decimals,
                mint,
                toNativeTokenAmount
              );

              // Confirm token changes for the recipient.
              expect(recipientTokenBalanceAfter - recipientTokenBalanceBefore).equals(
                denormalizedReceiveAmount - expectedSwapAmountIn
              );

              // Confirm token changes for fee recipient.
              expect(feeRecipientTokenBalanceAfter - feeRecipientTokenBalanceBefore).equals(
                expectedSwapAmountIn
              );

              // Confirm lamports changes for the recipient.
              expect(recipientLamportBalanceAfter - recipientLamportBalanceBefore).equals(
                expectedSwapAmountOut
              );

              // Confirm lamports changes for the relayer.
              expect(relayerLamportBalanceBefore - relayerLamportBalanceAfter)
                .gte(expectedSwapAmountOut)
                .lte(expectedSwapAmountOut + feeEpsilon);
            }

            await verifyTmpTokenAccountDoesNotExist(mint);
          });

          it("With Relayer (No Fee and No Swap)", async function () {
            // Define inbound transfer parameters. Calculate the fee
            // using the foreignChain to simulate calculating the
            // target relayer fee. This contract won't allow us to set
            // a relayer fee for the Solana chain ID.
            const relayerFee = await calculateRelayerFee(
              connection,
              program.programId,
              foreignChain, // placeholder
              decimals,
              mint
            );

            // Create the encoded transfer with relay payload. Set the
            // to native token amount and relayer fee to zero for this test.
            const transferWithRelayPayload = createTransferWithRelayPayload(
              tokenBridgeNormalizeAmount(0, decimals),
              tokenBridgeNormalizeAmount(0, decimals),
              payer.publicKey.toBuffer().toString("hex")
            );

            // Create the token bridge message.
            const signedMsg = guardianSign(
              foreignTokenBridge.publishTransferTokensWithPayload(
                tokenAddress,
                isNative ? CHAINS.solana : foreignChain, // tokenChain
                BigInt(tokenBridgeNormalizeAmount(receiveAmount, decimals)),
                CHAINS.solana, // recipientChain
                TOKEN_BRIDGE_RELAYER_PID.toBuffer().toString("hex"),
                foreignContractAddress,
                Buffer.from(transferWithRelayPayload.substring(2), "hex"),
                batchId
              )
            );

            // Post the Wormhole message.
            await expect(postSignedMsgAsVaaOnSolana(signedMsg, relayer)).to.be.fulfilled;

            // Fetch the token balances before the transfer.
            const recipientTokenBalanceBefore = await getBalance(
              connection,
              payer.publicKey,
              mint === NATIVE_MINT,
              recipientTokenAccount
            );
            const feeRecipientTokenBalanceBefore = await getBalance(
              connection,
              feeRecipient.publicKey,
              mint === NATIVE_MINT,
              feeRecipientTokenAccount
            );

            // Fetch the lamport balances before the transfer.
            const recipientLamportBalanceBefore = await getBalance(
              connection,
              payer.publicKey,
              true,
              recipientTokenAccount
            );
            const relayerLamportBalanceBefore = await getBalance(
              connection,
              relayer.publicKey,
              true,
              relayerTokenAccount
            );

            // Complete the transfer.
            await expectIxToSucceed(
              createRedeemTransferWithPayloadIx(relayer.publicKey, signedMsg, payer.publicKey),
              relayer
            );

            // Fetch the token balances after the transfer.
            const recipientTokenBalanceAfter = await getBalance(
              connection,
              payer.publicKey,
              mint === NATIVE_MINT,
              recipientTokenAccount
            );
            const feeRecipientTokenBalanceAfter = await getBalance(
              connection,
              feeRecipient.publicKey,
              mint === NATIVE_MINT,
              feeRecipientTokenAccount
            );

            // Fetch the lamport balances after the transfer.
            const recipientLamportBalanceAfter = await getBalance(
              connection,
              payer.publicKey,
              true,
              recipientTokenAccount
            );
            const relayerLamportBalanceAfter = await getBalance(
              connection,
              relayer.publicKey,
              true,
              relayerTokenAccount
            );

            // Denormalize the transfer amount and relayer fee.
            const denormalizedReceiveAmount = tokenBridgeTransform(receiveAmount, decimals);

            // Confirm the balance changes.
            if (mint === NATIVE_MINT) {
              // Confirm lamport changes for the recipient.
              expect(recipientLamportBalanceAfter - recipientLamportBalanceBefore).equals(
                tokenBridgeTransform(Number(receiveAmount), decimals)
              );

              // Confirm lamport changes for the relayer.
              expect(relayerLamportBalanceBefore - relayerLamportBalanceAfter).lte(feeEpsilon);
            } else {
              // Confirm token changes for the recipient.
              expect(recipientTokenBalanceAfter - recipientTokenBalanceBefore).equals(
                denormalizedReceiveAmount
              );

              // Confirm token changes for fee recipient.
              expect(feeRecipientTokenBalanceAfter - feeRecipientTokenBalanceBefore).equals(0);

              // Confirm lamports changes for the recipient.
              expect(recipientLamportBalanceAfter - recipientLamportBalanceBefore).equals(0);

              // Confirm lamports changes for the relayer.
              expect(relayerLamportBalanceBefore - relayerLamportBalanceAfter).lte(feeEpsilon);
            }

            await verifyTmpTokenAccountDoesNotExist(mint);
          });

          it("With Relayer (No Swap With Fee)", async function () {
            // Define inbound transfer parameters. Calculate the fee
            // using the foreignChain to simulate calculating the
            // target relayer fee. This contract won't allow us to set
            // a relayer fee for the Solana chain ID.
            const relayerFee = await calculateRelayerFee(
              connection,
              program.programId,
              foreignChain, // placeholder
              decimals,
              mint
            );

            // Create the encoded transfer with relay payload. Set the
            // to native token amount to zero for this test.
            const transferWithRelayPayload = createTransferWithRelayPayload(
              tokenBridgeNormalizeAmount(relayerFee, decimals),
              tokenBridgeNormalizeAmount(0, decimals),
              payer.publicKey.toBuffer().toString("hex")
            );

            // Create the token bridge message.
            const signedMsg = guardianSign(
              foreignTokenBridge.publishTransferTokensWithPayload(
                tokenAddress,
                isNative ? CHAINS.solana : foreignChain, // tokenChain
                BigInt(tokenBridgeNormalizeAmount(receiveAmount, decimals)),
                CHAINS.solana, // recipientChain
                TOKEN_BRIDGE_RELAYER_PID.toBuffer().toString("hex"),
                foreignContractAddress,
                Buffer.from(transferWithRelayPayload.substring(2), "hex"),
                batchId
              )
            );
            replayVAA = signedMsg;

            // Post the Wormhole message.
            await expect(postSignedMsgAsVaaOnSolana(signedMsg, relayer)).to.be.fulfilled;

            // Fetch the token balances before the transfer.
            const recipientTokenBalanceBefore = await getBalance(
              connection,
              payer.publicKey,
              mint === NATIVE_MINT,
              recipientTokenAccount
            );
            const feeRecipientTokenBalanceBefore = await getBalance(
              connection,
              feeRecipient.publicKey,
              mint === NATIVE_MINT,
              feeRecipientTokenAccount
            );

            // Fetch the lamport balances before the transfer.
            const recipientLamportBalanceBefore = await getBalance(
              connection,
              payer.publicKey,
              true,
              recipientTokenAccount
            );
            const relayerLamportBalanceBefore = await getBalance(
              connection,
              relayer.publicKey,
              true,
              relayerTokenAccount
            );

            // Complete the transfer.
            await expectIxToSucceed(
              createRedeemTransferWithPayloadIx(relayer.publicKey, signedMsg, payer.publicKey),
              relayer
            );

            // Fetch the token balances after the transfer.
            const recipientTokenBalanceAfter = await getBalance(
              connection,
              payer.publicKey,
              mint === NATIVE_MINT,
              recipientTokenAccount
            );
            const feeRecipientTokenBalanceAfter = await getBalance(
              connection,
              feeRecipient.publicKey,
              mint === NATIVE_MINT,
              feeRecipientTokenAccount
            );

            // Fetch the lamport balances after the transfer.
            const recipientLamportBalanceAfter = await getBalance(
              connection,
              payer.publicKey,
              true,
              recipientTokenAccount
            );
            const relayerLamportBalanceAfter = await getBalance(
              connection,
              relayer.publicKey,
              true,
              relayerTokenAccount
            );

            // Denormalize the transfer amount and relayer fee.
            const denormalizedReceiveAmount = tokenBridgeTransform(receiveAmount, decimals);
            const denormalizedRelayerFee = tokenBridgeTransform(relayerFee, decimals);

            // Confirm the balance changes.
            if (mint === NATIVE_MINT) {
              // Confirm lamport changes for the recipient.
              expect(recipientLamportBalanceAfter - recipientLamportBalanceBefore).equals(
                tokenBridgeTransform(Number(receiveAmount) - denormalizedRelayerFee, decimals)
              );

              // Confirm lamport changes for the relayer.
              expect(relayerLamportBalanceAfter - relayerLamportBalanceBefore).gte(
                denormalizedRelayerFee - feeEpsilon
              );
            } else {
              // Confirm token changes for the recipient.
              expect(recipientTokenBalanceAfter - recipientTokenBalanceBefore).equals(
                denormalizedReceiveAmount - denormalizedRelayerFee
              );

              // Confirm token changes for fee recipient.
              expect(feeRecipientTokenBalanceAfter - feeRecipientTokenBalanceBefore).equals(
                denormalizedRelayerFee
              );

              // Confirm lamports changes for the recipient.
              expect(recipientLamportBalanceAfter - recipientLamportBalanceBefore).equals(0);

              // Confirm lamports changes for the relayer.
              expect(relayerLamportBalanceBefore - relayerLamportBalanceAfter).lte(feeEpsilon);
            }

            await verifyTmpTokenAccountDoesNotExist(mint);
          });

          it("Cannot Redeem Again", async function () {
            await expectIxToFailWithError(
              await createRedeemTransferWithPayloadIx(
                relayer.publicKey,
                replayVAA,
                payer.publicKey
              ),
              "AlreadyRedeemed",
              relayer
            );
          });
        });
      });
    });
  });
});
