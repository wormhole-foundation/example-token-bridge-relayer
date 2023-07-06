import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { SignerArguments, addSignerArgsParser } from "./signer";

export interface ConfigArguments {
    config: string;
}

export type SupportedChainId = 2 | 4 | 5 | 6 | 10 | 14 | 16;

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

export function isChain(chainId: number): chainId is SupportedChainId {
    return (
        chainId === 2 ||
        chainId === 4 ||
        chainId === 5 ||
        chainId === 6 ||
        chainId === 10 ||
        chainId === 14 ||
        chainId === 16
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