# Example-Token-Bridge-Relayer

## Wormhole-Scaffolding

This repository was generated from the [wormhole-scaffolding](https://github.com/wormhole-foundation/wormhole-scaffolding) template. We recommend using this template as a starting point for cross-chain development on Wormhole.

## Prerequisites

### EVM

Install [Foundry tools](https://book.getfoundry.sh/getting-started/installation), which include `forge`, `anvil` and `cast` CLI tools.

### Solana

> **Warning**
> Only Solana versions >= 1.14.14 and < 1.15 are supported.

Install `cargo` and `anchor` CLI tools. If you need these tools,
please visit the [Anchor book] for more details.

### Sui

Install the `Sui` CLI. This tool is used to compile the contracts and run the tests.

```sh
cargo install --locked --git https://github.com/MystenLabs/sui.git --rev 09b2081498366df936abae26eea4b2d5cafb2788 sui sui-faucet
```

### Worm CLI

First, checkout the [Wormhole](https://github.com/wormhole-foundation/wormhole) repo, then install the CLI tool by running:

```sh
wormhole/clients/js $ make install
```

`worm` is the swiss army knife for interacting with wormhole contracts on all
supported chains, and generating signed messages (VAAs) for testing.

## Build, Test and Deploy Smart Contracts

Each directory represents Wormhole integrations for specific blockchain networks. Please navigate to a network subdirectory to see more details (see the relevant README.md) on building, testing and deploying the smart contracts.

## Design

![alt text](./docs/design.png)

Also see the [design doc].

[anchor book]: https://book.anchor-lang.com/getting_started/installation.html
[wormhole repo]: https://github.com/wormhole-foundation/wormhole/tree/dev.v2/solana
[design doc]: https://github.com/wormhole-foundation/example-token-bridge-relayer/blob/main/DESIGN.md
