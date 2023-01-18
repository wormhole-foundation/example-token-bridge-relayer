#/bin/bash

pgrep anvil > /dev/null
if [ $? -eq 0 ]; then
    echo "anvil already running"
    exit 1;
fi

# avalanche mainnet fork
anvil \
    -m "myth like bonus scare over problem client lizard pioneer submit female collect" \
    --port 8545 \
    --fork-url $TESTING_AVAX_FORK_RPC > anvil_avax.log &

# ethereum mainnet fork
anvil \
    -m "myth like bonus scare over problem client lizard pioneer submit female collect" \
    --port 8546 \
    --fork-url $TESTING_ETH_FORK_RPC > anvil_eth.log &

sleep 10

## anvil's rpc
AVAX_RPC="http://localhost:8545"
ETH_RPC="http://localhost:8546"

## first key from mnemonic above
export PRIVATE_KEY=$WALLET_PRIVATE_KEY

mkdir -p cache
cp -v foundry.toml cache/foundry.toml
cp -v foundry-test.toml foundry.toml

## override environment variables based on deployment network
export RELEASE_WORMHOLE_ADDRESS=$TESTING_AVAX_WORMHOLE_ADDRESS
export RELEASE_BRIDGE_ADDRESS=$TESTING_AVAX_BRIDGE_ADDRESS
export RELEASE_SWAP_RATE_PRECISION=$TESTING_AVAX_SWAP_RATE_PRECISION
export RELEASE_RELAYER_FEE_PRECISION=$TESTING_AVAX_RELAYER_FEE_PRECISION
export RELEASE_WETH_ADDRESS=$TESTING_WRAPPED_AVAX_ADDRESS
export RELEASE_SHOULD_UNWRAP_WETH=true

echo "deploying contracts to Avalanche fork"
forge script forge-scripts/deploy_contracts.sol \
    --rpc-url $AVAX_RPC \
    --private-key $PRIVATE_KEY \
    --broadcast --slow > forge-scripts/deploy.out 2>&1

forge script forge-scripts/deploy_wormUSD.sol \
    --rpc-url $AVAX_RPC \
    --private-key $PRIVATE_KEY \
    --broadcast --slow > forge-scripts/deploy.out 2>&1

## override environment variables based on deployment network
export RELEASE_WORMHOLE_ADDRESS=$TESTING_ETH_WORMHOLE_ADDRESS
export RELEASE_BRIDGE_ADDRESS=$TESTING_ETH_BRIDGE_ADDRESS
export RELEASE_SWAP_RATE_PRECISION=$TESTING_ETH_SWAP_RATE_PRECISION
export RELEASE_RELAYER_FEE_PRECISION=$TESTING_ETH_RELAYER_FEE_PRECISION
export RELEASE_WETH_ADDRESS=$TESTING_WRAPPED_ETH_ADDRESS
export RELEASE_SHOULD_UNWRAP_WETH=true

forge script forge-scripts/deploy_contracts.sol \
    --rpc-url $ETH_RPC \
    --private-key $PRIVATE_KEY \
    --broadcast --slow > forge-scripts/deploy.out 2>&1

forge script forge-scripts/deploy_wormUSD.sol \
    --rpc-url $ETH_RPC \
    --private-key $PRIVATE_KEY \
    --broadcast --slow > forge-scripts/deploy.out 2>&1

echo "overriding foundry.toml"
mv -v cache/foundry.toml foundry.toml

## run tests here
npx ts-mocha -t 1000000 ts/test/*.ts

# nuke
pkill anvil
