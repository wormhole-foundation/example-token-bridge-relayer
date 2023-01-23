# Off-Chain Relayer

## Message Relayer

Before starting the off-chain message relayer process, copy the sample environment file. Add your private key, and any desired target network RPCs.

```
cp .env.sample .env
```

Copy one of the sample `tokenBridgeRelayer.json` files (depending on the target environment). These files contain the deployed contracts addresses of the Wormhole Core, Wormhole Token Bridge, and Token Bridge Relayer smart contracts.

```
# copy the testnet message relayer file
cp cfg/testnetTokenBridgeRelayer.json.sample cfg/tokenBridgeRelayer.json

# or copy the mainnet message relayer file
cp cfg/mainnetTokenBridgeRelayer.json.sample cfg/tokenBridgeRelayer.json
```

Before starting the off-chain message relayer process, open the [source file](./relayer/src/tokenBridgeRelayer/main.ts) and check that the `SUPPORTED_CHAINS` and `SIGNERS` variables reflect the configured networks in the `.env` and `tokenBridgeRelayer.json` files.

To build and start the process, run the following commands:

```
npm ci && npm run build
npm run start-relayer
```

Note: The `tokenBridgeRelayer.json` file is also used by the Off-Chain Price Relayer process.

## Price Relayer

Before starting the off-chain price relayer process, copy the sample environment file (this `.env` file is shared with the off-chain message relayer process):

```
cp .env.sample .env
```

Copy one of the sample `priceRelayer.json` files.

```
# copy the testnet price relayer file
cp cfg/testnetPriceRelayer.json.sample cfg/priceRelayer.json

# or copy the mainnet price relayer file
cp cfg/mainnetPriceRelayer.json.sample cfg/priceRelayer.json
```

The following table describes each parameter in the `priceRelayer.json` configuration file:
| Parameter | Description |
| :--- | :--- |
| fetchPricesInterval | Determines how often (in milliseconds) the off-chain price relayer will pull prices from CoinGecko and update the swap rate for each token accepted by the Token Bridge Relayer contracts.|
| updatePriceChangePercentage | The minimum price change (in percentage terms) that a token must realize before the off-chain price relayer will update the swap rate in the Token Bridge Relayer contract's state.
|pricePrecision| The swap rate precision. This is a state variable set when the Token Bridge Relayer smart contracts are deployed. See the EVM State Variables [doc](../docs/EVM_STATE_VARIABLES.md) for more information.|
| relayers | Array of tokens that the relayer will fetch swap rates for. Each relayer object must contain the following parameters: <br /> - `chainId` The Wormhole Chain ID of token. <br /> - `tokenId` The Token ID used to pull swap rates from the CoinGecko API. <br /> - `tokenContract` The Origin-chain token address (bytes32 format).

Before starting the off-chain price relayer process, open the [source file](./relayer/src/priceRelayer/main.ts) and check that the `SUPPORTED_CHAINS` and `SIGNERS` variables reflect the configured networks in the `.env`.

```
# only run these if you haven't already for the off-chain message relayer
cd relayer
npm ci

# build and start
npm run build
npm run start-oracle
```
