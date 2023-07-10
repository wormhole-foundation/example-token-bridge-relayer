#!/bin/bash

export NETWORK=devnet
export TOKEN_BRIDGE_RELAYER_PROGRAM_ID="4fkhk7mXFSwtWNopUDhcCXCDX7CHDwPgZACysEPxf5Gh"

### maybe a validator is already running
pgrep -f solana-test-validator
if [ $? -eq 0 ]; then
    echo "solana-test-validator already running"
    exit 1;
fi

TEST_ROOT=$(dirname $0)/ts/tests
ROOT=$TEST_ROOT/../..

### prepare local validator
ARTIFACTS=$ROOT/target/deploy
ACCOUNTS=$TEST_ROOT/accounts
mkdir -p $ACCOUNTS
DEPENDENCIES=$ROOT/dependencies

MPL_TOKEN_METADATA_PUBKEY=metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
MPL_TOKEN_METADATA_BPF=$DEPENDENCIES/mpl_token_metadata.so
# if [ ! -f $MPL_TOKEN_METADATA_BPF ]; then
#   echo "> Fetching MPL Token Metadata program from mainnet-beta"
#   solana program dump -u m $MPL_TOKEN_METADATA_PUBKEY $MPL_TOKEN_METADATA_BPF
# fi

### Fetch Wormhole programs from main branch
CORE_BRIDGE_BPF=$DEPENDENCIES/$NETWORK/bridge.so
TOKEN_BRIDGE_BPF=$DEPENDENCIES/$NETWORK/token_bridge.so

CORE_BRIDGE_PUBKEY=Bridge1p5gheXUvJ6jGWGeCsgPKgnE3YgdGKRVCMY9o
TOKEN_BRIDGE_PUBKEY=B6RHG3mfcckmrYN1UhmJzyS1XX3fZKbkeUcpJe9Sy3FE

TEST=$TEST_ROOT/.test

solana-test-validator --reset \
  --bpf-program $MPL_TOKEN_METADATA_PUBKEY $MPL_TOKEN_METADATA_BPF \
  --bpf-program $CORE_BRIDGE_PUBKEY $CORE_BRIDGE_BPF \
  --bpf-program $TOKEN_BRIDGE_PUBKEY $TOKEN_BRIDGE_BPF \
  --account-dir $ACCOUNTS \
  --ledger $TEST > validator.log 2>&1 &
sleep 5

solana program deploy \
    -u localhost $ARTIFACTS/token_bridge_relayer.so \
    --program-id $ARTIFACTS/token_bridge_relayer-keypair.json \
    --commitment confirmed
solana program set-upgrade-authority \
    -u localhost \
    $TOKEN_BRIDGE_RELAYER_PROGRAM_ID \
    --new-upgrade-authority E6WwzparLRr5UGqydNPyUxT2HVfKiQgJdvFNib1Gg51E \
    --commitment confirmed

### write program logs
PROGRAM_LOGS=$TEST/program-logs
mkdir -p $PROGRAM_LOGS

RPC=http://localhost:8899
solana logs $CORE_BRIDGE_PUBKEY --url $RPC > $PROGRAM_LOGS/$CORE_BRIDGE_PUBKEY &
solana logs $TOKEN_BRIDGE_PUBKEY --url $RPC > $PROGRAM_LOGS/$TOKEN_BRIDGE_PUBKEY &
solana logs $MPL_TOKEN_METADATA_PUBKEY --url $RPC > $PROGRAM_LOGS/$MPL_TOKEN_METADATA_PUBKEY &
solana logs $TOKEN_BRIDGE_RELAYER_PROGRAM_ID --url $RPC > $PROGRAM_LOGS/$TOKEN_BRIDGE_RELAYER_PROGRAM_ID &

### run tests
npx ts-mocha -p ./tsconfig.json -t 1000000 $TEST_ROOT/[0-9]*.ts

### nuke
pkill -f "solana logs"
pkill -f solana-test-validator
