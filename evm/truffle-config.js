const HDWalletProvider = require("@truffle/hdwallet-provider");
module.exports = {
  contracts_directory: "./src/token-bridge-relayer/",
  networks: {
    karura_testnet: {
      provider: () => {
        return new HDWalletProvider(
          process.env.PRIVATE_KEY,
          "https://karura-dev.aca-dev.network/eth/http"
        );
      },
      network_id: 596,
      gasPrice: "0x2f9cab03ea",
      gasLimit: "0x329b140",
      gas: "0x329b140",
    },
    fantom_testnet: {
      provider: () => {
        return new HDWalletProvider(
          process.env.PRIVATE_KEY,
          "https://fantom-testnet.public.blastapi.io"
        );
      },
      network_id: 0xfa2,
    },
  },

  // Set default mocha options here, use special reporters, etc.
  mocha: {
    // timeout: 100000
  },

  // Configure your compilers
  compilers: {
    solc: {
      version: "0.8.17", // Fetch exact version from solc-bin (default: truffle's version)
      // docker: true,        // Use "0.5.1" you've installed locally with docker (default: false)
      settings: {
        // See the solidity docs for advice about optimization and evmVersion
        optimizer: {
          enabled: true,
          runs: 200,
        },
      },
      //  evmVersion: "byzantium"
      // }
    },
  },
};
