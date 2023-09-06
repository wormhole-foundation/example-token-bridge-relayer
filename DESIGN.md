# Token Bridge Relayer

This document describes the design of the Token Bridge Relayer (TBR) smart contract. The TBR contract allows users to send cross-chain transfers with native asset drop-off.

## Context

The [Wormhole Token Bridge](https://github.com/wormhole-foundation/wormhole/tree/main/whitepapers/0003_token_bridge.md) enables cross-chain token transfers, consisting of the following steps:

1. Alice invokes the Token Bridge contract on the source chain, passing transfer details (token amount, destination chain, etc.)
2. Once Alice's transaction is included in the source blockchain, the Gaurdians produce a VAA attesting to the transaction.
3. Bob picks up that VAA and invokes the Token Bridge contract on the destination chain, which will mint/release the appropriate amount of tokens into the account specified by Alice in Step 1.
4. Alice can now spend the tokens on the destination chain.

While the protocol allows for Alice and Bob to be two independent entities, traditionally they have been the same person (the user). This means that in Step 3, they already need to have native funds on the destination chain in order to redeem the transaction, and in Step 4 they need additional native funds to pay for gas when spending the received tokens. This is a subpar onboarding experience, because the user has to find other means of obtaining native gas tokens before they can redeem (and use) their transferred tokens.

The Token Bridge Relayer provides an alternative instantiation of Bob, such that the user only has to interact with a single smart contract on the origin chain (in Step 1). Additionally, when completing the transaction, the TBR swaps some of the transferred tokens into native gas, and sends those to the recipient along with the tokens ("native drop-off").

## Detailed Design

To support the above use-case, the TBR consists of:

- An on-chain contract on the sending chain that Alice will interact with instead of the Token Bridge
- An off-chain service that performs Step 3
- An on-chain contract on the destination chain that the off-chain service interacts with that handles the swap and paying the relayer

The details of the off-chain service are outside the scope of this document, and only the on-chain components will be described.
Whilst the send and receive functionalities are distinct, they are implemented in the same contract, the Token Bridge relayer contract.

On the source chain, the user interacts with the `transferTokensWithRelay` entry point of the TBR contract. Under the hood, this function sends a contract-controlled transfer (aka. transfer with payload) with the tokens and additional instructions in the payload to specify the recipient address, the fee paid to the relayer for completing the transaction, and the amount of native gas to drop off to the recipient. The schema of the additional payload looks like:

```solidity
struct TransferWithRelay {
    uint8 payloadId; // == 1
    uint256 targetRelayerFee;
    uint256 toNativeTokenAmount;
    bytes32 targetRecipient;
}
```

the recipient of the Token Bridge transfer is the TBR contract on the destination chain, which will redeem the tokens, then according to the instructions above, transfer the tokens (+ native gas) to the user, and pay the relayer. The amount of tokens the recipient receives is the amount transferred - the amount swapped into native gas - the amount paid to the relayer.

### Accepted tokens and swaps

While the Token Bridge allows sending any token, the relayer may not be interested in relaying arbitrary tokens.
After all, the off-chain relayer gets reimbursed in the tokens being transferred (i.e. if the token is USDC, the relayer gets some of that as payment in exchange for paying for the transaction and the swap to native gas).

To this end, the TBR contract maintains a set of accepted tokens ("registered tokens"), and for each of them recording two pieces of data: the swap rate (how much USD is a token worth) and the max native swap amount. Updating these values is permissioned to the _owner_ of the contracts.

The swap rate is represented as a fixed point decimal number, i.e. the amounts are multiplied by some power of 10.
TODO: we should specify this precision to be 10^18 or something similar. The issue is that the EVM contracts and Sui are deployed with 10^8, with Sui not having a safe way to change this number to anything higher. EVM has a safe way of upgrading, but it's cumbersome and involves downtime (pausing the contract temporarily), so we should deprecate that method.
The `toNativeTokenAmount` represents the amount of tokens the user requested to convert to native tokens. The relayer contract calculates based on the swap rate how many native tokens the recipient receives for those tokens, and the relayer receives the bridged tokens in exchange for paying the native tokens to the recipient.

The max native swap amount represents the maximum number of native tokens the relayer will pay for this token, regardless of the requested amount.

If a token is not registered on the sending side, the transaction reverts. The swap rate, however, is quoted at the receiving side, at the time of relay. Thus, for a token to be successfully transfered, it must be registered on both the sending chain and the recipient chain.
A misconfiguration, i.e. the token being registered on the sending chain but not the recipient chain, results in a temporary denial of service, which can be resolved by registering the token on the recipient chain.

### Foreign contract registration

The TBR contracts on various chains need to be registered with each other. This is used to verify that the relay instructions originate from a trusted source. The TBR contracts only accept inbound transfers from registered TBR contracts. Similarly, for outbound transfers, the TBR contract only allows sending to chains where there is a registered TBR contract (that contract is will be recipient of the transfer).

### Completing a transfer

To complete the transfer, the off-chain relayer invokes the `completeTransferWithRelay` method (or equivalent) on the target `TokenBridgeRelayer` contract, passing the attested Wormhole message to the contract. The `TokenBridgeRelayer` contract then completes the following actions:

1. Determines if the token being transferred is an `acceptedToken`
2. Completes the transfer (and verifies the VAA) by invoking the Wormhole Token Bridge contract
3. Takes custody of the newly minted (or released) tokens
4. Verifies that the Wormhole message was generated by a `registeredContract`
5. Parses the `TransferWithRelay` payload
6. Determines if the user requested a swap amount larger than the `maxNativeSwapAmount`
7. Determines if the relayer sent enough native assets to perform a swap (if requested by the user)
8. Sends the remaining tokens (and native assets) to the recipient
9. Sends swap proceeds to the off-chain relayer, and refunds any excess native assets
10. Pays the off-chain relayer a fee for facilitating the transfer and swap

## Chain-specific implementation details

### EVM

On EVM, TBR implements the following interface:

```solidity
function transferTokensWithRelay(
    address token,
    uint256 amount,
    uint256 toNativeTokenAmount,
    uint16 targetChain,
    bytes32 targetRecipient,
    uint32 batchId
) external payable returns (uint64 messageSequence);

function wrapAndTransferEthWithRelay(
    uint256 toNativeTokenAmount,
    uint16 targetChain,
    bytes32 targetRecipient,
    uint32 batchId
) external payable returns (uint64 messageSequence);

function completeTransferWithRelay(bytes calldata encodedTransferMessage) external payable;

function calculateMaxSwapAmountIn(address token) external view returns (uint256);

function calculateNativeSwapAmountOut(address token, uint256 toNativeAmount) external view returns (uint256);
```

Note that `batchId` corresponds to the `nonce` field in a Wormhole message, and is currently unused.

To initiate a transfer, a user will invoke the `transferTokensWithRelay` method on the `TokenBridgeRelayer` contract. The `transferTokensWithRelay` method takes six arguments:

- `token` - Address of the token on the origin chain
- `amount` - Amount of tokens to be transferred
- `toNativeTokenAmount` - Amount of tokens to swap into native assets on the target chain
- `targetChain` - Wormhole chain ID of the target chain
- `targetRecipient` - User's wallet address on the target chain (32-byte representation)
- `batchId` - Wormhole message nonce

When the off-chain relayer invokes the `completeTransferWithRelay` endpoint, it needs to know how many native tokens to pass on to cover the native drop-off. To do this, it will first call the `calculateNativeSwapAmountOut` with the bridged tokens and the requested amount.

### Solana

On Solana, the TBR contract implements the following interface:

```rust
pub fn transfer_native_tokens_with_relay(
    ctx: Context<TransferNativeWithRelay>,
    amount: u64,
    to_native_token_amount: u64,
    recipient_chain: u16,
    recipient_address: [u8; 32],
    batch_id: u32,
    wrap_native: bool,
);

pub fn transfer_wrapped_tokens_with_relay(
    ctx: Context<TransferWrappedWithRelay>,
    amount: u64,
    to_native_token_amount: u64,
    recipient_chain: u16,
    recipient_address: [u8; 32],
    batch_id: u32,
);

pub fn complete_native_transfer_with_relay(
    ctx: Context<CompleteNativeWithRelay>,
    _vaa_hash: [u8; 32],
);

pub fn complete_wrapped_transfer_with_relay(
    ctx: Context<CompleteWrappedWithRelay>,
    _vaa_hash: [u8; 32],
);
```

#### Native Swaps

Solana does not allow the transaction `payer` (the off-chain relayer) to specify an amount of lamports (native asset) to pass to the contract during execution. Instead, the callee contract can transfer arbitrary amount of lamports out of the `payer`'s account.
Thus the `TokenBridgeRelayer` contract directly transfers lamports from the `payer` to the `recipient` when performing a native asset swap. This does change the trust assumptions between the off-chain relayer and the Solana contract, since the contract directly determines how many lamports to deduct from the off-chain relayer's account. However, the Solana contract will never deduct more than the `max_native_swap_amount`.

#### Relayer Fees for SOL Transfers

Instead of paying the `fee_recipient` a `relayer_fee` when completing a transfer for native SOL, the `payer` will receive the `relayer_fee`. The Wormhole Token Bridge releases WSOL when completing a native transfer on Solana, which is not the desired asset for users. Instead, this contract unwraps the WSOL by closing the WSOL account and transfers the lamports to the `payer`. The contract then transfers the intended amount of lamports from the `payer` account to the `recipient` account. This design reduces the need for a temporary system account for warehousing the SOL after closing the WSOL account. It also doesn't require the `fee_recipient` to sign the transaction.

## Future Considerations

The `TokenBridgeRelayer` contracts currently rely on a centralized actor (the `owner` or `ownerAssistant`) to update the swap rates between native assets and Token Bridge supported assets. Integrating with a decentralized oracle such as [Pyth](https://github.com/pyth-network/pyth-sdk-solidity) would greatly enhance the user experience and security of these contracts.
