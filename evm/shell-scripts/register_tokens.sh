#/bin/bash

setSwapRates=$1
setMaxNativeAmounts=$2
ts-node ts/scripts/registerTokens.ts --setSwapRates $setSwapRates --setMaxNativeAmount $setMaxNativeAmounts

