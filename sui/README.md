# SUI

## Build

Run the following commands to install the necessary Wormhole and Token Bridge dependencies:

```
make dependencies
```

## Testing Environment

The testing environments can be found in the following locations:

- [Unit Tests](./contracts/token_bridge_relayer/) (see the source code)
- [Integration Tests](./ts/tests/01_token_bridge_relayer.ts)

You can run the tests with the following commands:

```
# Move-based Unit tests
make unit-test

# local-validator integration tests written in typescript
make integration-test

# unit tests and local-validator integration tests
make test
```

## Contract Deployment

Deploy the Token Bridge Relayer contract (and save the output) by running the following command:

```
worm sui deploy \
    ./PATH_TO_REPO/sui/contracts/token_bridge_relayer \
    -n TARGET_NETWORK (mainnet or testnet) -k YOUR_BASE64_KEY \
    --rpc YOUR_RPC -d true
```

## Contract Setup

### Step 1: Create Environment File

To set up the deployed Token Bridge Relayer contract on testnet or mainnet, create an environment file with the following variables in the `./env` directory. `RELAYER_STATE_ID` should not be set until completing the next step in the `Contract Setup` guide.

```
### Wormhole
export WORMHOLE_ID=
export WORMHOLE_STATE_ID=

### Token Bridge
export TOKEN_BRIDGE_ID=
export TOKEN_BRIDGE_STATE_ID=

### Token Bridge Relayer
export RELAYER_ID=
export RELAYER_OWNER_CAPABILITY_ID=
export RELAYER_UPGRADE_CAP_ID=
export RELAYER_STATE_ID=

## RPC
export RPC=

## Private Key
export KEY=
```

### Step 2: Create Deployment Config

Start by copying the `mainnetConfig.json` or `testnetConfig.json` file in the `./cfg` directory and setting the config up according to your deployment needs:

```
cd cfg
cp mainnetConfig.json deploymentConfig.json
```

### Step 3: Create State

To create the state object, run the following command and save the object ID in your environment file as `RELAYER_STATE_ID`:

```
source env/your_file.env && yarn create-state
```

### Step 4: Register Foreign Contracts

To register each foreign contract from the `deployedContracts` section of your `deploymentConfig.json`, run the following command:

```
source env/your_file.env && yarn register-contracts
```

### Step 5: Set Target Relayer Fees

To set the target relayer fees for each registered foreign contract, run the following command:

```
source env/your_file.env && yarn set-relayer-fees
```

### Step 6: Register Tokens

To register the tokens defined in the `acceptedTokensList` section of your `deploymentConfig.json`, run the following command. This command will also set the `swapRate`, `maxNativeSwapAmount` and `swapEnabled` values for each token.

```
source env/your_file.env && yarn register-tokens
```

## Send Outbound Test Transfer

To send a test transfer on testnet or mainnet, first start by creating an environment file (see [here](#step-1-create-environment-file)) then run the following command:

```
source env/your_file.env && yarn test-transfer -c COIN_TYPE_TO_TRANSFER -a AMOUNT_TO_SEND -t TARGET_WORMHOLE_CHAIN_ID -r 32_byte_recipient_wallet_address
```
