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

Before deploying the contracts, create an environment file in the `env/` directory for each target blockchain. Each file should contain the following environment variables:

```
export RPC=""
export RELEASE_WORMHOLE_ADDRESS=
export RELEASE_BRIDGE_ADDRESS=
export RELEASE_SWAP_RATE_PRECISION=
export RELEASE_RELAYER_FEE_PRECISION=
export RELEASE_WORMHOLE_CHAIN_ID=
```

Then deploy the contracts by executing the following command:

```
. env/your_environment_file.env && PRIVATE_KEY=your_private_key_here bash shell-scripts/deploy_token_bridge_relayer.sh
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
. env/your_environment_file.env && PRIVATE_KEY=your_private_key bash shell-scripts/test_transfer.sh
```
