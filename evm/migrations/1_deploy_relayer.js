const TokenBridgeRelayer = artifacts.require("TokenBridgeRelayer");

const chainId = process.env.RELEASE_WORMHOLE_CHAIN_ID;
const wormhole = process.env.RELEASE_WORMHOLE_ADDRESS;
const tokenBridgeAddress = process.env.RELEASE_BRIDGE_ADDRESS;
const swapRatePrecision = process.env.RELEASE_SWAP_RATE_PRECISION;
const relayerFeePrecision = process.env.RELEASE_RELAYER_FEE_PRECISION;

module.exports = async function (deployer) {
  await deployer.deploy(
    TokenBridgeRelayer,
    chainId,
    wormhole,
    tokenBridgeAddress,
    swapRatePrecision,
    relayerFeePrecision
  );
};
