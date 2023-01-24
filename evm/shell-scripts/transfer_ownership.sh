#/bin/bash

# submit the ownership transfer request
forge script forge-scripts/transfer_ownership.sol \
    --rpc-url $RPC \
    --private-key $PRIVATE_KEY \
    --broadcast --slow
