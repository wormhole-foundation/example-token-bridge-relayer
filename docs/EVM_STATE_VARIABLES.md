# EVM State Variables

This document defines each of the EVM state variables in the Token Bridge Relayer contracts.

## Variables

### chainId

- The Wormhole Chain ID of the blockchain the contract is deployed to.
- Immutable and set during deployment.

### wethAddress

- The address of the WETH contract on the blockchain the contract is deployed to.
- Immutable and set during deployment.
- Some blockchains do not support a WETH contract. However, the native asset supports transfers via an ERC20 interface and has a contract address. The `wethAddress` acts as a placeholder for these bespoke native assets, even though the contract does not support WETH-like functionality.

### owner

- The address of the contract operator (or deployer).
- The `owner` can perform a variety of different governance actions. See the [Governance Module](../evm/src/token-bridge-relayer/TokenBridgeRelayerGovernance.sol) to see the list of governance actions the owner can perform.
- Ownership of the contracts can be transferred by invoking the following methods:
  - `submitOwnershipTransferRequest`
  - `confirmOwnershipTransferRequest`
- The ownership transfer process can be canceled by invoking the `cancelOwnershipTransferRequest` method.

### pendingOwner

- This variable is set during the ownership transfer process after the owner invokes the `submitOwnershipTransferRequest` method.
- The `pendingOwner` must complete the ownership transfer process by invoking the `confirmOwnershipTransferRequest` method.

### wormhole

- The address of the Wormhole core contract on the blockchain the contract is deployed to.
- Immutable and set during deployment.

### tokenBridge

- The address of the Wormhole Token Bridge contract on the blockchain the contract is deployed to.
- Immutable and set during deployment.

### swapRatePrecision

- The accepted token swap rate precision.
- This value MUST be set to the same value on each deployed smart contract.
- The `swapRatePrecision` determines the `swapRate` minimum. For example, if the `swapRatePrecision` is set to 1e3 (1000), the `swapRate` minimum is 0.001 (see [swapRate](#swaprate) for more info).
- Setting the `swapRatePrecision` to a higher value (e.g. 1e10) will allow the contracts to support a wider variety of tokens.
- The `owner` can update this state variable by invoking the `updateSwapRatePrecision` method.

### relayerFeePrecision

- The precision of the relayer fee.
- This value MUST be set to the same value on each deployed smart contract.
- The `relayerFeePrecision` determines the `relayerFee` minimum. For example, if the `relayerFeePrecision` is set to 1e3 (1000), the `relayerFee` minimum is 0.001 (see [relayerFee](#relayerfees) for more info).
- The `owner` can update this state variable by invoking the `updateRelayerFeePrecision` method.

### registeredContracts

- A Wormhole `chainId` to known relayer contract address (bytes32 zero-left-padded) mapping.
- Only one relayer contract can be registered per target chain.
- The contract will not allow any transfers to unregistered target relayer contracts.
- The `owner` can register a target relayer contract by invoking the `registerContract` method.

### swapRate

- Token address to `swapRate` mapping.
- The USD conversion rate for an accepted token.
- The `swapRate` is scaled by the `swapRatePrecision`.
- Example:
  - Assume the `swapRatePrecision` is 1e8 and the USD conversion rate for one token is $32.00.
  - The `swapRate` set in the contract should be 32.00 \* 1e8 = 32e8 (3200000000)
- The `swapRate` can only be set for tokens that have been registered (see [acceptedTokens](#acceptedtokens)).
- The `swapRate` can be updated by the `owner` by invoking the `updateSwapRate` method.

### maxNativeSwapAmount

- Token address to `maxNativeSwapAmount` mapping.
- The `maxNativeSwapAmount` is the maximum number of native tokens a user can swap transferred tokens for.
- Scaled by the native token decimals.
- For Example:
  - Assume the native token has 18 decimals, and the desired `maxNativeSwapAmount` is 1.5 tokens.
  - The `maxNativeSwapAmount` in the contract should be set to 1.5 \* 1e18 = 1.5e18 (1500000000000000000).
- The `maxNativeSwapAmount` can only be set for tokens that have been registered (see [acceptedTokens](#acceptedtokens)).
- The `maxNativeSwapAmount` can be updated by the `owner` for each registered token by invoking the `updateMaxNativeSwapAmount` method.

### relayerFees

- A Wormhole `chainId` to USD-denominated `relayerFee` mapping.
- The `relayerFee` is the fee the off-chain relayer charges for relaying transfers cross chain and facilitating the native gas-drop off on the target chain.
- The `relayerFee` is scaled by the `relayerFeePrecision`.
- Example:
  - Assume the `relayerFeePrecision` is 1e8 and the relayer fee in USD is $4.269.
  - The `relayerFee` set in the contract should be 4.269 \* 1e8 = 4.269e8 (426900000).
- The `relayerFee` can be updated by the `owner` for each target blockchain by invoking the `updateRelayerFee` method.

### acceptedTokens

- Address to boolean mapping.
- The `acceptedTokens` mapping determines which tokens are transferrable via the Token Bridge Relayer contracts. Only Tokens that are registered on each registered contract will be transferred successfully.
- The `owner` can register a token by invoking the `registerToken` method.

### acceptedTokensList

- Array of accepted token addresses for a particular relayer contract.
- The `owner` can add or remove tokens from this list by invoking one of the following methods:
  - `registerToken`
  - `deregisterToken`
