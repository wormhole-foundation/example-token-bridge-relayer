import {expect, use as chaiUse} from "chai";
import chaiAsPromised from "chai-as-promised";
chaiUse(chaiAsPromised);
import {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  createWrappedOnSolana,
  redeemOnSolana,
  transferNativeSol,
  tryNativeToHexString,
  CHAINS,
} from "@certusone/wormhole-sdk";
import * as wormhole from "@certusone/wormhole-sdk/lib/cjs/solana/wormhole";
import * as tokenBridge from "@certusone/wormhole-sdk/lib/cjs/solana/tokenBridge";
import * as mock from "@certusone/wormhole-sdk/lib/cjs/mock";
import {
  GOVERNANCE_EMITTER_ADDRESS,
  MOCK_GUARDIANS,
  LOCALHOST,
  MINTS_WITH_DECIMALS,
  PAYER_KEYPAIR,
  WORMHOLE_CONTRACTS,
  CORE_BRIDGE_PID,
  TOKEN_BRIDGE_PID,
  RELAYER_KEYPAIR,
  WETH_ADDRESS,
  boilerPlateReduction,
  createMaliciousRegisterChainInstruction,
  ASSISTANT_KEYPAIR,
  FEE_RECIPIENT_KEYPAIR,
} from "./helpers";

describe(" 0: Wormhole", () => {
  const connection = new Connection(LOCALHOST, "processed");
  const payer = PAYER_KEYPAIR;
  const relayer = RELAYER_KEYPAIR;
  const assistant = ASSISTANT_KEYPAIR;
  const feeRecipient = FEE_RECIPIENT_KEYPAIR;

  const defaultMintAmount = 10n ** 6n;

  const {
    requestAirdrop,
    guardianSign,
    postSignedMsgAsVaaOnSolana,
    expectIxToSucceed,
    expectTxToSucceed,
  } = boilerPlateReduction(connection, payer);

  const signAndPost = async (message: Buffer) => {
    const signedMsg = guardianSign(message);
    await postSignedMsgAsVaaOnSolana(signedMsg);
    return signedMsg;
  };

  const governance = new mock.GovernanceEmitter(
    GOVERNANCE_EMITTER_ADDRESS.toBuffer().toString("hex"),
    20
  );

  before("Airdrop", async function () {
    await Promise.all(
      [payer, relayer, assistant, feeRecipient]
        .map((kp) => kp.publicKey)
        .map(requestAirdrop)
    );
  });

  describe("Verify Local Validator", function () {
    it("Create SPL Tokens", async function () {
      await Promise.all(
        Array.from(MINTS_WITH_DECIMALS.entries()).map(
          async ([mintDecimals, {privateKey, publicKey}]) => {
            const mint = await createMint(
              connection,
              payer,
              payer.publicKey,
              null, // freezeAuthority
              mintDecimals,
              Keypair.fromSecretKey(privateKey)
            );
            expect(mint).deep.equals(publicKey);

            const {decimals} = await getMint(connection, mint);
            expect(decimals).equals(mintDecimals);
          }
        )
      );
    });

    it("Create ATAs", async function () {
      await Promise.all(
        Array.from(MINTS_WITH_DECIMALS.values()).flatMap(({publicKey: mint}) =>
          [payer, relayer, feeRecipient].map(
            (wallet) =>
              expect(
                getOrCreateAssociatedTokenAccount(
                  connection,
                  wallet,
                  mint,
                  wallet.publicKey
                )
              ).to.be.fulfilled
          )
        )
      );

      // Create an additional account for the native mint.
      await Promise.all(
        [payer, relayer, feeRecipient].map(
          (wallet) =>
            expect(
              getOrCreateAssociatedTokenAccount(
                connection,
                wallet,
                NATIVE_MINT,
                wallet.publicKey
              )
            ).to.be.fulfilled
        )
      );
    });

    it("Mint to Wallet's ATAs", async function () {
      await Promise.all(
        Array.from(MINTS_WITH_DECIMALS.entries()).map(
          async ([mintDecimals, {publicKey: mint}]) => {
            const mintAmount = defaultMintAmount * 10n ** BigInt(mintDecimals);
            const destination = getAssociatedTokenAddressSync(
              mint,
              payer.publicKey
            );

            await expect(
              mintTo(connection, payer, mint, destination, payer, mintAmount)
            ).to.be.fulfilled;

            const {amount} = await getAccount(connection, destination);
            expect(amount).equals(mintAmount);
          }
        )
      );
    });
  });

  describe("Verify Wormhole Program", function () {
    it("Initialize", async function () {
      const guardianSetExpirationTime = 86400;
      const fee = 100n;
      const devnetGuardian = MOCK_GUARDIANS.getPublicKeys()[0];
      const initialGuardians = [devnetGuardian];

      await expectIxToSucceed(
        wormhole.createInitializeInstruction(
          CORE_BRIDGE_PID,
          payer.publicKey,
          guardianSetExpirationTime,
          fee,
          initialGuardians
        )
      );

      const accounts = await connection.getProgramAccounts(CORE_BRIDGE_PID);
      expect(accounts).has.length(2);

      const info = await wormhole.getWormholeBridgeData(
        connection,
        CORE_BRIDGE_PID
      );
      expect(info.guardianSetIndex).equals(0);
      expect(info.config.guardianSetExpirationTime).equals(
        guardianSetExpirationTime
      );
      expect(info.config.fee).equals(fee);

      const guardianSet = await wormhole.getGuardianSet(
        connection,
        CORE_BRIDGE_PID,
        info.guardianSetIndex
      );
      expect(guardianSet.index).equals(0);
      expect(guardianSet.keys).has.length(1);
      expect(devnetGuardian).deep.equal(guardianSet.keys[0]);
    });
  });

  describe("Verify Token Bridge Program", function () {
    const ethereumTokenBridge = new mock.MockEthereumTokenBridge(
      WORMHOLE_CONTRACTS.ethereum.token_bridge
    );
    const tokenBridgeWethMint = tokenBridge.deriveWrappedMintKey(
      TOKEN_BRIDGE_PID,
      CHAINS.ethereum,
      WETH_ADDRESS
    );

    it("Initialize", async function () {
      await expectIxToSucceed(
        tokenBridge.createInitializeInstruction(
          TOKEN_BRIDGE_PID,
          payer.publicKey,
          CORE_BRIDGE_PID
        )
      );

      const accounts = await connection.getProgramAccounts(TOKEN_BRIDGE_PID);
      expect(accounts).has.length(1);
    });

    const registerForeignEndpoint = async (
      message: Buffer,
      isMalicious: boolean,
      expectedAccountLength: number
    ) => {
      const signedMsg = await expect(signAndPost(message)).to.be.fulfilled;

      const createIxFunc = isMalicious
        ? createMaliciousRegisterChainInstruction
        : tokenBridge.createRegisterChainInstruction;

      await expectIxToSucceed(
        createIxFunc(
          TOKEN_BRIDGE_PID,
          CORE_BRIDGE_PID,
          payer.publicKey,
          signedMsg
        )
      );

      const accounts = await connection.getProgramAccounts(TOKEN_BRIDGE_PID);
      expect(accounts).has.length(expectedAccountLength);
    };

    it("Register Foreign Endpoint (Ethereum)", async function () {
      const message = governance.publishTokenBridgeRegisterChain(
        0, //timestamp
        CHAINS.ethereum,
        WORMHOLE_CONTRACTS.ethereum.token_bridge
      );
      await registerForeignEndpoint(message, false, 3);
    });

    // This shouldn't be allowed, but we're doing it just to prove the safety
    // of the scaffold programs.
    it("Register Bogus Foreign Endpoint (Chain ID == 0)", async function () {
      const message = governance.publishTokenBridgeRegisterChain(
        0, // timestamp
        CHAINS.solana, //will be overwritten
        PublicKey.default.toString()
      );
      message.writeUInt16BE(CHAINS.unset, 86); //overwrite chainId
      await registerForeignEndpoint(message, true, 5);
    });

    // This shouldn't be allowed, but we're doing it just to prove the safety
    // of the scaffold programs.
    it("Register Bogus Foreign Endpoint (Chain ID == 1)", async function () {
      const message = governance.publishTokenBridgeRegisterChain(
        0, // timestamp
        CHAINS.solana,
        PublicKey.default.toString()
      );
      await registerForeignEndpoint(message, true, 7);
    });

    it("Outbound Transfer Native", async function () {
      const targetAddress = Buffer.alloc(32, "deadbeef", "hex");
      await expectTxToSucceed(
        transferNativeSol(
          connection,
          CORE_BRIDGE_PID,
          TOKEN_BRIDGE_PID,
          payer.publicKey,
          BigInt(LAMPORTS_PER_SOL), //1 SOL
          targetAddress,
          CHAINS.ethereum
        )
      );

      const {sequence} = await wormhole.getProgramSequenceTracker(
        connection,
        TOKEN_BRIDGE_PID,
        CORE_BRIDGE_PID
      );
      expect(sequence).equals(1n);
    });

    it("Attest WETH from Ethereum", async function () {
      const signedMsg = await expect(
        signAndPost(
          ethereumTokenBridge.publishAttestMeta(
            WETH_ADDRESS,
            18,
            "WETH",
            "Wrapped Ether"
          )
        )
      ).to.be.fulfilled;

      await expectTxToSucceed(
        createWrappedOnSolana(
          connection,
          CORE_BRIDGE_PID,
          TOKEN_BRIDGE_PID,
          payer.publicKey,
          signedMsg
        )
      );
    });

    it("Create WETH ATAs", async function () {
      await Promise.all(
        [payer, relayer, feeRecipient].map(
          (wallet) =>
            expect(
              getOrCreateAssociatedTokenAccount(
                connection,
                wallet,
                tokenBridgeWethMint,
                wallet.publicKey
              )
            ).to.be.fulfilled
        )
      );
    });

    it("Mint WETH to Wallet ATA", async function () {
      const destination = getAssociatedTokenAddressSync(
        tokenBridgeWethMint,
        payer.publicKey
      );

      // Scale the mint amount by the wrapped decimals (max 8).
      const mintAmount = defaultMintAmount * 10n ** BigInt(8);

      const signedMsg = await expect(
        signAndPost(
          ethereumTokenBridge.publishTransferTokens(
            tryNativeToHexString(WETH_ADDRESS, "ethereum"),
            CHAINS.ethereum, // tokenChain
            mintAmount,
            CHAINS.solana, // recipientChain
            destination.toBuffer().toString("hex"),
            0n //fee
          )
        )
      ).to.be.fulfilled;

      await expectTxToSucceed(
        redeemOnSolana(
          connection,
          CORE_BRIDGE_PID,
          TOKEN_BRIDGE_PID,
          payer.publicKey,
          signedMsg
        )
      );

      const {amount} = await getAccount(connection, destination);
      expect(amount).equals(mintAmount);
    });
  });

  describe("Check wormhole-sdk", function () {
    it("tryNativeToHexString", async function () {
      expect(tryNativeToHexString(payer.publicKey.toString(), "solana")).equals(
        "c291b257b963a479bbc5a56aa6525494a6d708e628ff2ad61c8679c99d2afca5"
      );
    });
  });
});
