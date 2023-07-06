#/bin/bash
 

forge script forge-scripts/test_transfer.sol \
    --rpc-url $RPC \
    --private-key $PRIVATE_KEY \
    --broadcast --slow
