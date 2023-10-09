#/bin/bash
 

forge script forge-scripts/test_transfer.sol \
    --rpc-url $RPC \
    --broadcast --slow $@
