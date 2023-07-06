#/bin/bash
 

forge script forge-scripts/configure_contract.sol \
    --rpc-url $RPC \
    --private-key $PRIVATE_KEY \
    --broadcast --slow
