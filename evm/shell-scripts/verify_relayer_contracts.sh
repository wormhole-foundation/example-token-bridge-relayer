#/bin/bash

etherscan_key=$1

# environment variables
evm_chain_id=$RELEASE_EVM_CHAIN_ID
bridge_addr=$RELEASE_BRIDGE_ADDRESS
weth_addr=$RELEASE_WETH_ADDRESS
fee_recipient=$RELEASE_FEE_RECIPIENT
owner_assistant=$RELEASE_OWNER_ASSISTANT
unwrap=$RELEASE_UNWRAP_WETH
deployed_addr=$RELAYER_CONTRACT_ADDRESS

forge verify-contract --chain-id $evm_chain_id --watch --etherscan-api-key $etherscan_key \
--constructor-args $(cast abi-encode "constructor(address,address,address,address,bool)" $bridge_addr $weth_addr $fee_recipient $owner_assistant $unwrap) \
    $deployed_addr \
    src/token-bridge-relayer/TokenBridgeRelayer.sol:TokenBridgeRelayer
