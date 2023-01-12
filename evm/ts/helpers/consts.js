"use strict";
exports.__esModule = true;
exports.WORMHOLE_MESSAGE_EVENT_ABI = exports.WORMHOLE_TOPIC = exports.WALLET_PRIVATE_KEY_TWO = exports.WALLET_PRIVATE_KEY = exports.GUARDIAN_PRIVATE_KEY = exports.ETH_RELAYER_FEE_PRECISION = exports.ETH_SWAP_RATE_PRECISION = exports.WETH_ADDRESS = exports.ETH_BRIDGE_ADDRESS = exports.ETH_WORMHOLE_GUARDIAN_SET_INDEX = exports.ETH_WORMHOLE_MESSAGE_FEE = exports.ETH_WORMHOLE_CHAIN_ID = exports.ETH_WORMHOLE_ADDRESS = exports.AVAX_RELAYER_FEE_PRECISION = exports.AVAX_SWAP_RATE_PRECISION = exports.WAVAX_ADDRESS = exports.AVAX_BRIDGE_ADDRESS = exports.AVAX_WORMHOLE_GUARDIAN_SET_INDEX = exports.AVAX_WORMHOLE_MESSAGE_FEE = exports.AVAX_WORMHOLE_CHAIN_ID = exports.AVAX_WORMHOLE_ADDRESS = exports.FORK_ETH_CHAIN_ID = exports.FORK_AVAX_CHAIN_ID = exports.ETH_HOST = exports.AVAX_HOST = void 0;
var ethers_1 = require("ethers");
// rpc
exports.AVAX_HOST = "http://localhost:8545";
exports.ETH_HOST = "http://localhost:8546";
// forks
exports.FORK_AVAX_CHAIN_ID = Number(process.env.TESTING_AVAX_FORK_CHAINID);
exports.FORK_ETH_CHAIN_ID = Number(process.env.TESTING_ETH_FORK_CHAINID);
// Avalanche wormhole variables
exports.AVAX_WORMHOLE_ADDRESS = process.env.TESTING_AVAX_WORMHOLE_ADDRESS;
exports.AVAX_WORMHOLE_CHAIN_ID = Number(process.env.TESTING_AVAX_WORMHOLE_CHAINID);
exports.AVAX_WORMHOLE_MESSAGE_FEE = ethers_1.ethers.BigNumber.from(process.env.TESTING_AVAX_WORMHOLE_MESSAGE_FEE);
exports.AVAX_WORMHOLE_GUARDIAN_SET_INDEX = Number(process.env.TESTING_AVAX_WORMHOLE_GUARDIAN_SET_INDEX);
exports.AVAX_BRIDGE_ADDRESS = process.env.TESTING_AVAX_BRIDGE_ADDRESS;
exports.WAVAX_ADDRESS = process.env.TESTING_WRAPPED_AVAX_ADDRESS;
exports.AVAX_SWAP_RATE_PRECISION = process.env.TESTING_AVAX_RELAYER_FEE_PRECISION;
exports.AVAX_RELAYER_FEE_PRECISION = process.env.TESTING_AVAX_RELAYER_FEE_PRECISION;
// Ethereum wormhole variables
exports.ETH_WORMHOLE_ADDRESS = process.env.TESTING_ETH_WORMHOLE_ADDRESS;
exports.ETH_WORMHOLE_CHAIN_ID = Number(process.env.TESTING_ETH_WORMHOLE_CHAINID);
exports.ETH_WORMHOLE_MESSAGE_FEE = ethers_1.ethers.BigNumber.from(process.env.TESTING_ETH_WORMHOLE_MESSAGE_FEE);
exports.ETH_WORMHOLE_GUARDIAN_SET_INDEX = Number(process.env.TESTING_ETH_WORMHOLE_GUARDIAN_SET_INDEX);
exports.ETH_BRIDGE_ADDRESS = process.env.TESTING_ETH_BRIDGE_ADDRESS;
exports.WETH_ADDRESS = process.env.TESTING_WRAPPED_ETH_ADDRESS;
exports.ETH_SWAP_RATE_PRECISION = process.env.TESTING_ETH_RELAYER_FEE_PRECISION;
exports.ETH_RELAYER_FEE_PRECISION = process.env.TESTING_ETH_RELAYER_FEE_PRECISION;
// signer
exports.GUARDIAN_PRIVATE_KEY = process.env.GUARDIAN_KEY;
exports.WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;
exports.WALLET_PRIVATE_KEY_TWO = process.env.WALLET_PRIVATE_KEY_TWO;
// wormhole event ABIs
exports.WORMHOLE_TOPIC = "0x6eb224fb001ed210e379b335e35efe88672a8ce935d981a6896b27ffdf52a3b2";
exports.WORMHOLE_MESSAGE_EVENT_ABI = [
    "event LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)",
];
