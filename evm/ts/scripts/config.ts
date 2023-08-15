import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { SignerArguments, addSignerArgsParser } from "./signer";

export interface ConfigArguments {
    config: string;
}

export type OperatingChainId = 2 | 4 | 5 | 6 | 10 | 14 | 16 | 30;
export type SupportedChainId = OperatingChainId | 1 | 21;

export interface Config {
    deployedContracts: Record<SupportedChainId, string>;
    acceptedTokensList: Record<
        SupportedChainId,
        {
            symbol: string;
            contract: string;
            swapRate: string;
        }[]
    >;
    maxNativeSwapAmount: Record<SupportedChainId, string>;
    relayerFeesInUsd: Record<SupportedChainId, string>;
}

/**
 * These are the chains that we talk about in our configuration payloads.
 * These should include all the chains where the TBR is deployed on.
 */
export function isChain(chainId: number): chainId is SupportedChainId {
    return (
        isOperatingChain(chainId) ||
        chainId === 1 ||
        chainId === 21
    );
}

/**
 * These are the chains where we sign and send transactions.
 * We currently only support EVM chains in these scripts.
 */
export function isOperatingChain(chainId: number): chainId is OperatingChainId {
    return (
        chainId === 2 ||
        chainId === 4 ||
        chainId === 5 ||
        chainId === 6 ||
        chainId === 10 ||
        chainId === 14 ||
        chainId === 16 ||
        chainId === 30
    );
}

export function configArgsParser(): yargs.Argv<ConfigArguments> {
    const parser = yargs(hideBin(process.argv))
        .env("CONFIGURE_TBR")
        .option("config", {
            alias: "c",
            string: true,
            boolean: false,
            description: "Configuration filepath.",
            required: true,
        })
        .help("h")
        .alias("h", "help");
    return parser;
}

export type Arguments = ConfigArguments & SignerArguments;

export async function parseArgs(): Promise<Arguments> {
  const parser = addSignerArgsParser(configArgsParser());
  const args = await parser.argv;
  return {
    config: args.config,
    useLedger: args.ledger,
    derivationPath: args.derivationPath,
  };
}