#/bin/bash

chain_id=$1
optimizer_runs=$2
etherscan_key=$3

# environment variables
wormhole_chain=$RELEASE_WORMHOLE_CHAIN_ID
wormhole_addr=$RELEASE_WORMHOLE_ADDRESS
bridge_addr=$RELEASE_BRIDGE_ADDRESS
weth_addr=$RELEASE_WETH_ADDRESS
unwrap=$RELEASE_UNWRAP_WETH
deployed_addr=$RELAYER_CONTRACT_ADDRESS

forge verify-contract --chain-id $chain_id --num-of-optimizations $optimizer_runs --watch \
--constructor-args $(cast abi-encode "constructor(uint16,address,address,address,bool)" $wormhole_chain $wormhole_addr $bridge_addr $weth_addr $unwrap) \
    --compiler-version v0.8.17 $deployed_addr \
    src/token-bridge-relayer/TokenBridgeRelayer.sol:TokenBridgeRelayer $etherscan_key
