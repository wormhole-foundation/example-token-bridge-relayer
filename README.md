# Example-Token-Bridge-Relayer

## Prerequisites

### EVM

Install [Foundry tools](https://book.getfoundry.sh/getting-started/installation), which include `forge`, `anvil` and `cast` CLI tools.

## Build, Test and Deploy Smart Contracts

Each directory represents Wormhole integrations for specific blockchain networks. Please navigate to a network subdirectory to see more details (see the relevant README.md) on building, testing and deploying the smart contracts.

## Off-Chain Relayer Processes

Navigate to the [relayer](./relayer/) directory.

### Off-Chain Message Relayer

Before starting the off-chain message relayer process, copy the sample environment file. Add your private key, and any desired target network RPCs.

```
cp .env.sample .env
```

Copy the sample `tokenBridgeRelayer.json` file. This file contains the deployed contracts addresses of the Wormhole Core, Wormhole Token Bridge, and Token Bridge Relayer smart contracts. The sample file contains contracts addresses that are deployed to a select number of testnets:

```
cp cfg/tokenBridgeRelayer.json.sample cfg/tokenBridgeRelayer.json
```

Before starting the off-chain message relayer process, open the [source file](./relayer/src/tokenBridgeRelayer/main.ts) and check that the `SUPPORTED_CHAINS` and `SIGNERS` variables reflect the configured networks in the `.env` and `tokenBridgeRelayer.json` files.

To build and start the process, run the following commands:

```
npm ci && npm run build
npm run start-relayer
```

### Off-Chain Price Relayer

Before starting the off-chain price relayer process, copy the sample environment file (this `.env` file is shared with the off-chain message relayer process):

```
cp .env.sample .env
```

Copy the sample `priceRelayer.json` file.

```
cp cfg/priceRelayer.json.sample cfg/priceRelayer.json
```

The following table describes each parameter in the `priceRelayer.json` configuration file:
| Parameter | Description |
| :--- | :--- |
| fetchPricesInterval | Determines how often (in milliseconds) the off-chain price relayer will pull prices from CoinGecko and update the swap rate for each token accepted by the Token Bridge Relayer contracts.|
| updatePriceChangePercentage | The minimum price change (in percentage terms) that a token must realize before the off-chain price relayer will update the swap rate in the Token Bridge Relayer contract's state.
| relayers | Array of tokens that the relayer will fetch swap rates for. Each relayer object must contain the following parameters: <br /> - `chainId` The Wormhole Chain ID of token. <br /> - `tokenId` The Token ID used to pull swap rates from the CoinGecko API. <br /> - `tokenContract` The Origin-chain token address (bytes32 format). <br /> - `pricePrecision` The swap rate precision. This is a state variable set when the Token Bridge Relayer smart contracts are deployed. This should be the same on each chain. It is very important that this variable is set correctly.

Before starting the off-chain price relayer process, open the [source file](./relayer/src/priceRelayer/main.ts) and check that the `SUPPORTED_CHAINS` and `SIGNERS` variables reflect the configured networks in the `.env`.

```
# only run these if you haven't already for the off-chain message relayer
cd relayer
npm ci

# build and start
npm run build
npm run start-oracle
```
