#/bin/bash

# submit the ownership transfer request
forge script forge-scripts/confirm_ownership_transfer.sol \
    --rpc-url $RPC \
    --private-key $PRIVATE_KEY \
    --broadcast --slow
