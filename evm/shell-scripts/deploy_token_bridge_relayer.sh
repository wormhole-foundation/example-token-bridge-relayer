#!/bin/bash

forge script forge-scripts/deploy_contracts.sol \
    --rpc-url $RPC \
    --broadcast --slow $@
