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
