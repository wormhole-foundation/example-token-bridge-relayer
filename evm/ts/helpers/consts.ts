import {ethers} from "ethers";

// rpc
export const AVAX_HOST = "http://localhost:8546";
export const ETH_HOST = "http://localhost:8547";

// forks
export const FORK_AVAX_CHAIN_ID = Number(
  process.env.TESTING_AVAX_FORK_CHAINID!
);
export const FORK_ETH_CHAIN_ID = Number(process.env.TESTING_ETH_FORK_CHAINID!);

// Avalanche wormhole variables
export const AVAX_WORMHOLE_ADDRESS = process.env.TESTING_AVAX_WORMHOLE_ADDRESS!;
export const AVAX_WORMHOLE_CHAIN_ID = Number(
  process.env.TESTING_AVAX_WORMHOLE_CHAINID!
);
export const AVAX_WORMHOLE_MESSAGE_FEE = ethers.BigNumber.from(
  process.env.TESTING_AVAX_WORMHOLE_MESSAGE_FEE!
);
export const AVAX_WORMHOLE_GUARDIAN_SET_INDEX = Number(
  process.env.TESTING_AVAX_WORMHOLE_GUARDIAN_SET_INDEX!
);
export const AVAX_BRIDGE_ADDRESS = process.env.TESTING_AVAX_BRIDGE_ADDRESS!;
export const WAVAX_ADDRESS = process.env.TESTING_WRAPPED_AVAX_ADDRESS!;
export const AVAX_SWAP_RATE_PRECISION =
  process.env.TESTING_AVAX_RELAYER_FEE_PRECISION!;
export const AVAX_RELAYER_FEE_PRECISION =
  process.env.TESTING_AVAX_RELAYER_FEE_PRECISION!;

// Ethereum wormhole variables
export const ETH_WORMHOLE_ADDRESS = process.env.TESTING_ETH_WORMHOLE_ADDRESS!;
export const ETH_WORMHOLE_CHAIN_ID = Number(
  process.env.TESTING_ETH_WORMHOLE_CHAINID!
);
export const ETH_WORMHOLE_MESSAGE_FEE = ethers.BigNumber.from(
  process.env.TESTING_ETH_WORMHOLE_MESSAGE_FEE!
);
export const ETH_WORMHOLE_GUARDIAN_SET_INDEX = Number(
  process.env.TESTING_ETH_WORMHOLE_GUARDIAN_SET_INDEX!
);
export const ETH_BRIDGE_ADDRESS = process.env.TESTING_ETH_BRIDGE_ADDRESS!;
export const WETH_ADDRESS = process.env.TESTING_WRAPPED_ETH_ADDRESS!;
export const ETH_SWAP_RATE_PRECISION =
  process.env.TESTING_ETH_RELAYER_FEE_PRECISION!;
export const ETH_RELAYER_FEE_PRECISION =
  process.env.TESTING_ETH_RELAYER_FEE_PRECISION!;

// signer
export const GUARDIAN_PRIVATE_KEY = process.env.GUARDIAN_KEY!;
export const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY!;
export const WALLET_PRIVATE_KEY_TWO = process.env.WALLET_PRIVATE_KEY_TWO!;
export const WALLET_PRIVATE_KEY_THREE = process.env.WALLET_PRIVATE_KEY_THREE!;
export const WALLET_PRIVATE_KEY_FOUR = process.env.WALLET_PRIVATE_KEY_FOUR!;

// wormhole event ABIs
export const WORMHOLE_TOPIC =
  "0x6eb224fb001ed210e379b335e35efe88672a8ce935d981a6896b27ffdf52a3b2";
export const WORMHOLE_MESSAGE_EVENT_ABI = [
  "event LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)",
];

// Token bridge relayer event ABIs
export const SWAP_TOPIC =
  "0x764f0dc063c06f32d89a3f3af80c0db4be8a090901f589a478b447e0a51f09f1";
export const SWAP_EVENT_ABI = [
  "event SwapExecuted(address indexed recipient, address indexed relayer, address indexed token, uint256 tokenAmount, uint256 nativeAmount)",
];

// Token bridge relayer transfer event ABIs
export const TRANSFER_EVENT_TOPIC =
  "0xcaf280c8cfeba144da67230d9b009c8f868a75bac9a528fa0474be1ba317c169";
export const TRANSFER_EVENT_ABI = [
  "event TransferRedeemed(uint16 indexed emitterChainId, bytes32 indexed emitterAddress, uint64 indexed sequence)",
];
