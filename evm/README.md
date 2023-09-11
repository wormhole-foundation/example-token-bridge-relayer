# EVM

## Build

Run the following commands to install necessary dependencies and to build the smart contracts:

```
make dependencies
make build
```

## Testing Environment

The testing environments can be found in the following locations:

- [Unit Tests](./forge-test/)
- [Integration Tests](./ts/test/01_token_bridge_relayer.ts)

First, set the `TESTING_AVAX_FORK_RPC` and `TESTING_ETH_FORK_RPC` variables in `evm/env/testing.env`. Both the unit and integration tests fork mainnet, so be sure to use the mainnet URL. Then run the tests with the following commands:

```
# solidity-based unit tests
make unit-test

# local-validator integration tests written in typescript
make integration-test

# unit tests and local-validator integration tests
make test
```

## Contract Deployment

Before deploying the contracts, create an environment file in the `env/` directory (there are subdirectories for `testnet` and `mainnet`) for each target blockchain. Each file should contain the following environment variables:

```
export RPC=""
export RELEASE_WORMHOLE_ADDRESS=
export RELEASE_BRIDGE_ADDRESS=
export RELEASE_WORMHOLE_CHAIN_ID=
export RELEASE_WETH_ADDRESS=
export RELEASE_OWNER_ASSISTANT=
export RELEASE_FEE_RECIPIENT=
export RELEASE_UNWRAP_WETH=
```

Then deploy the contracts by executing the following command:

```
. env/network_subdirectory/your_environment_file.env && shell-scripts/deploy_token_bridge_relayer.sh --private-key your_private_key_here
```

## Initial Contract Setup

Before performing the initial contract setup, please read the EVM State Variables [doc](../docs/EVM_STATE_VARIABLES.md).

Once the contracts have been deployed, the deployment configuration file needs to be created. Navigate to the shared `cfg` directory in the root of the repo, and run one of the following commands (depending on the target environment):

```
# copy the testnet sample config
cp testnetDeploymentConfig.json.sample testnetDeploymentConfig.json

# or copy the mainnet sample config
cp mainnetDeploymentConfig.json.sample mainnetDeploymentConfig.json
```

Replace the sample `deployedContracts` with your deployed contract addresses (32-byte format) keyed by Wormhole Chain ID.

```
# example

"deployedContracts": {
    "2": "00000000000000000000000021eee3f29feff229caf1631582103030331a1141",
    "10": "000000000000000000000000416593b02120edc567ddbfbdfe84ab0d1765df3b"
}
```

Replace the sample `acceptedTokensList` with your list of accepted tokens. Each token should have a symbol, native contract address (32-byte format) and the initial swapRate, keyed by the Wormhole Chain ID for the token.

```
# example

"acceptedTokensList": {
    "2": [
      {
        "symbol": "WETH",
        "contract": "000000000000000000000000B4FBF271143F4FBf7B91A5ded31805e42b2208d6",
        "swapRate": "155000000000"
      }
    ],
    "10": [
      {
        "symbol": "WFTM",
        "contract": "000000000000000000000000f1277d1Ed8AD466beddF92ef448A132661956621",
        "swapRate": "32600000"
      }
    ]
}
```

Replace the sample `maxNativeSwapAmount` with your list of maximum native swap amounts keyed by Wormhole Chain ID. This parameter can be configured on a per-token basis, but to reduce complexity each token will be set to the same value (per chain).

```
# example

"maxNativeSwapAmount": {
    "2": "1000000000000000",
    "10": "250000000000000000"
  }
```

Replace the sample `relayerFeesInUsd` with your list of relayer fees (in USD terms) keyed by Wormhole Chain ID.

```
# example

"relayerFeesInUsd": {
    "2": "5000000",
    "10": "1000000"
  }
```

Once the deployment configuration file is set, register the contracts by executing the following command for each network defined in the `deployedContracts`:

```
. env/network_subdirectory/your_environment_file.env && PRIVATE_KEY=your_private_key_here bash shell-scripts/register_contracts.sh
```

Then register the accepted tokens list and set the max native swap amounts by executing the following command for each network defined in the `deployedContracts`. The first argument (boolean value) determines if the token swap rate should be set, and the second argument (boolean value) determines if the max native swap amount should be set.

```
. env/network_subdirectory/your_environment_file.env && PRIVATE_KEY=your_private_key_here bash shell-scripts/register_tokens.sh true true
```

Finally, set the relayer fee (for each target chain) by executing the following command for each network defined in the `deployedContract`:

```
. env/network_subdirectory/your_environment_file.env && PRIVATE_KEY=your_private_key_here bash shell-scripts/set_relayer_fees.sh
```

## Test Transfer

You can interact with deployed Token Bridge Relayer contracts and send a test transfer by executing the forge script `forge-scripts/test_transfer.sol`. Before sending a test transfer, set the following environment variables in the environment file that was used to deploy the contract you wish to interact with:

```
export TEST_RELAYER_CONTRACT=
export TEST_IS_NATIVE=
export TEST_TOKEN=
export TEST_TOKEN_CHAIN=
export TEST_AMOUNT=
export TEST_TO_NATIVE_AMOUNT=
export TEST_TARGET_CHAIN_ID=
export TEST_SHOULD_WRAP=
```

Then execute the `test_transfer.sol` script by running the following command:

```
. env/network_subdirectory/your_environment_file.env && PRIVATE_KEY=your_private_key bash shell-scripts/test_transfer.sh
```
